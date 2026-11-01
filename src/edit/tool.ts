import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyRanges } from "./apply.js";
import { normalizeEditArguments } from "./shims.js";
import { resolveEdit, validateEdit, type EditSpec } from "./resolve.js";
import {
  readSnapshot,
  restoreSnapshot,
  serializeSnapshot,
  sha256,
  withFileMutationQueues,
  writeSnapshot,
  type TextSnapshot,
} from "./snapshot.js";
import { appendTransaction } from "../history/db.js";
import { expandPath } from "../read/paths.js";
import {
  combineDiffs,
  createPiDiff,
  createUnifiedPatch,
  type DiffDetails,
} from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderDiffResult } from "../rendering/pi-renderers.js";
import { EditSchema } from "../tools/schemas.js";

export interface EditFileResult {
  path: string;
  edits: number;
  replacements: number;
}

export interface EditToolDetails {
  paths: string[];
  files: EditFileResult[];
  edits: number;
  replacements: number;
  diffs: DiffDetails[];
  diff: string;
  patch: string;
  firstChangedLine?: number;
  transactionId: string | null;
}

interface EditGroup {
  absolutePath: string;
  displayPath: string;
  edits: EditSpec[];
}

interface StagedFile {
  snapshot: TextSnapshot;
  newText: string;
  edits: number;
  replacements: number;
  diff: DiffDetails;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("edit aborted");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function groupEdits(edits: EditSpec[], cwd: string): EditGroup[] {
  const groups = new Map<string, EditGroup>();
  for (const edit of edits) {
    const absolutePath = expandPath(edit.path, cwd);
    const group = groups.get(absolutePath);
    if (group) {
      group.edits.push(edit);
    } else {
      groups.set(absolutePath, { absolutePath, displayPath: edit.path, edits: [edit] });
    }
  }
  return Array.from(groups.values());
}

function summarize(staged: StagedFile[]): string {
  const totalEdits = staged.reduce((sum, file) => sum + file.edits, 0);
  const totalReplacements = staged.reduce((sum, file) => sum + file.replacements, 0);
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  if (staged.length === 1) {
    return `Updated ${staged[0].snapshot.displayPath}: ${plural(totalEdits, "edit")}, ${plural(totalReplacements, "replacement")}.`;
  }

  const perFile = staged.map(
    (file) => `  ${file.snapshot.displayPath}: ${plural(file.edits, "edit")}, ${plural(file.replacements, "replacement")}`,
  );
  return `Updated ${staged.length} files: ${plural(totalEdits, "edit")}, ${plural(totalReplacements, "replacement")}.\n${perFile.join("\n")}`;
}

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit files in one transaction: exact text, delimiter-bounded regions, or line ranges, across as many files as needed. Every edit is matched against the original file, validated before anything is written, and refused on overlap or count mismatch.",
    promptSnippet:
      "Make precise file edits by exact text, delimiter-bounded region, or line range, including multiple disjoint edits across files in one call",
    promptGuidelines: [
      "Batch all edits for a task into one edit call: several entries in edits[], one per region, may span multiple files.",
      'mode "exact" replaces every occurrence of old; set expected_matches when the count matters.',
      'mode "between" replaces the text between a start and end delimiter; use it when the region is large and retyping it is pointless. Set include_delimiters to replace the delimiters too, and new: "" with adjacent delimiters to insert.',
      'mode "lines" replaces whole lines using the numbers read reported; end_line omitted means one line, end_line = start_line - 1 inserts before start_line.',
      "Every edit is matched against the original file, not against earlier edits in the same call. Ranges that overlap are an error.",
      "Line-number gutters copied from read output are stripped from replacement text.",
    ],
    parameters: EditSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    prepareArguments: normalizeEditArguments,
    renderCall(args, theme) {
      const paths = Array.isArray(args.edits)
        ? Array.from(new Set(args.edits.map((edit) => edit?.path).filter((path): path is string => typeof path === "string")))
        : [];
      return renderCodeLikeCall("edit", paths, theme);
    },
    renderResult(result, options, theme, context) {
      return renderDiffResult(result as never, options, theme, context, "Editing");
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const rawEdits = params.edits as unknown[] | undefined;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        throw new Error("Missing required parameter: edits");
      }

      const edits = rawEdits.map((edit, index) => validateEdit(edit, index));
      const groups = groupEdits(edits, ctx.cwd);

      return withFileMutationQueues(
        groups.map((group) => group.absolutePath),
        async () => {
          const staged: StagedFile[] = [];
          const failures: string[] = [];

          for (const group of groups) {
            throwIfAborted(signal);
            try {
              const snapshot = await readSnapshot(group.displayPath, ctx.cwd);
              const resolved = group.edits.map((spec) => resolveEdit(snapshot.text, spec));
              const ranges = resolved.flatMap((item) => item.ranges);
              const newText = applyRanges(snapshot.text, ranges);

              if (newText === snapshot.text) continue;

              staged.push({
                snapshot,
                newText,
                edits: group.edits.length,
                replacements: ranges.length,
                diff: { path: group.displayPath, ...createPiDiff(snapshot.text, newText) },
              });
            } catch (error) {
              failures.push(messageOf(error));
            }
          }

          if (failures.length > 0) {
            throw new Error(failures.length === 1 ? failures[0] : `${failures.length} edits failed, nothing was written:\n\n${failures.join("\n\n")}`);
          }

          if (staged.length === 0) {
            throw new Error("edits produced no changes, nothing was written");
          }

          const transactionId = await appendTransaction({
            cwd: ctx.cwd,
            kind: "edit",
            summary: `${edits.length} edit(s) across ${staged.length} file(s)`,
            changes: staged.map((file) => ({
              path: file.snapshot.displayPath,
              absolutePath: file.snapshot.absolutePath,
              before: file.snapshot.raw,
              afterSha: sha256(serializeSnapshot(file.snapshot, file.newText)),
            })),
          });

          const written: TextSnapshot[] = [];
          try {
            for (const file of staged) {
              throwIfAborted(signal);
              await writeSnapshot(file.snapshot, file.newText, signal);
              written.push(file.snapshot);
            }
          } catch (error) {
            for (const snapshot of written.reverse()) {
              try {
                await restoreSnapshot(snapshot);
              } catch {
                // Restoring is best effort; the transaction log is the authoritative undo path.
              }
            }
            throw error;
          }

          const diffs = staged.map((file) => file.diff);
          const details: EditToolDetails = {
            paths: staged.map((file) => file.snapshot.displayPath),
            files: staged.map((file) => ({
              path: file.snapshot.displayPath,
              edits: file.edits,
              replacements: file.replacements,
            })),
            edits: staged.reduce((sum, file) => sum + file.edits, 0),
            replacements: staged.reduce((sum, file) => sum + file.replacements, 0),
            diffs,
            diff: combineDiffs(diffs),
            patch: createUnifiedPatch(
              staged.map((file) => ({ path: file.snapshot.displayPath, before: file.snapshot.text, after: file.newText })),
            ),
            firstChangedLine: diffs[0]?.firstChangedLine,
            transactionId,
          };

          const transactionLine =
            transactionId === null
              ? "\n(History unavailable: this edit cannot be rolled back.)"
              : `\nTransaction ${transactionId} — undo with rollback({ transaction_id: "${transactionId}" })`;

          return { content: [{ type: "text" as const, text: `${summarize(staged)}${transactionLine}` }], details };
        },
      );
    },
  });
}
