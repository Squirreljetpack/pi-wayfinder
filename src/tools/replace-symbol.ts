import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readSnapshot, type TextSnapshot } from "../edit/snapshot.js";
import { recordAndWriteLocked, sessionOf, undoHint } from "../history/restore.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveSymbolDefinition, type SymbolRange } from "../ast/symbol-locator.js";
import { combineDiffs, createUnifiedDiff, type DiffDetails } from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderDiffResult } from "../rendering/pi-renderers.js";
import type { SymbolLocation, SymbolScanner } from "../symbols/symbol-scanner.js";
import { stripLineNumbers } from "./line-numbers.js";
import { ReplaceSymbolSchema } from "./schemas.js";

export interface SymbolReplacement {
  path: string;
  symbol: string;
  text: string;
  type?: string;
  force?: boolean;
}

export interface FileReplacementBatch {
  absolutePath: string;
  displayPath: string;
  replacements: SymbolReplacement[];
}

export interface ResolvedSymbolReplacement {
  replacement: SymbolReplacement;
  range: SymbolRange;
}

export interface DeleteRange {
  startIndex: number;
  endIndex: number;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.match(/\r\n|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

export function normalizeReplacementText(text: string, lineEnding: "\r\n" | "\n"): string {
  return stripLineNumbers(text).replace(/\r\n|\r|\n/g, lineEnding);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("replace_symbol aborted");
}

function missingSymbolMessage(replacement: SymbolReplacement): string {
  return `Symbol '${replacement.symbol}'${replacement.type ? ` of type '${replacement.type}'` : ""} not found in ${replacement.path}.`;
}

/**
 * Byte range to remove for a symbol.
 *
 * The removal extends through the end of the symbol's last line plus its line break, and consumes
 * one following empty line so the deletion does not leave a dangling blank line behind.
 */
export function computeDeleteRange(content: string, range: SymbolRange): DeleteRange {
  const startIndex = range.startIndex;

  let lineBreak = content.indexOf("\n", range.endIndex);
  if (lineBreak === -1) lineBreak = content.length;

  // Trim trailing spaces/tabs on the symbol's final line.
  let trimmedEnd = lineBreak;
  while (trimmedEnd > range.endIndex && (content[trimmedEnd - 1] === " " || content[trimmedEnd - 1] === "\t")) {
    trimmedEnd--;
  }

  // Include the line break (and the \r of \r\n, which sits right before \n).
  let endIndex = lineBreak === content.length ? trimmedEnd : lineBreak + 1;

  // Consume one following blank (whitespace-only) line, if present.
  let probe = endIndex;
  while (probe < content.length && (content[probe] === " " || content[probe] === "\t")) probe++;
  if (probe < content.length && content[probe] === "\n") {
    endIndex = probe + 1;
  } else if (probe < content.length && content[probe] === "\r" && content[probe + 1] === "\n") {
    endIndex = probe + 2;
  }

  return { startIndex, endIndex };
}

function offsetAt(content: string, lines: string[], line: number, column: number): number {
  if (line <= 0) return Math.min(column, content.length);
  const preceding = lines.slice(0, line).join("\n");
  return Math.min(preceding.length + 1 + column, content.length);
}

/**
 * References that would survive the deletion — references outside the removed byte range.
 * References inside the symbol's own body disappear with it, so they do not block deletion.
 */
export function blockingReferences(
  locations: SymbolLocation[],
  symbol: string,
  absolutePath: string,
  content: string,
  deleteRange: DeleteRange,
): Array<{ displayPath: string; line: number }> {
  const lines = content.split(/\r?\n/);
  const blockers: Array<{ displayPath: string; line: number }> = [];

  for (const location of locations) {
    if (location.name !== symbol || location.type !== "reference") continue;
    const offset = offsetAt(content, lines, location.startLine, location.startColumn);
    if (location.absolutePath === absolutePath && offset >= deleteRange.startIndex && offset < deleteRange.endIndex) {
      continue;
    }
    blockers.push({ displayPath: location.displayPath, line: location.startLine + 1 });
  }

  return blockers;
}

interface PreparedFileReplacementBatch {
  batch: FileReplacementBatch;
  snapshot: TextSnapshot;
  after: Buffer;
  finalContent: string;
  diff: DiffDetails;
  summaries: string[];
}

interface ReplaceSymbolToolDetails {
  paths: string[];
  symbols: string[];
  diff: string;
  diffs: DiffDetails[];
  firstChangedLine?: number;
}

async function withFileMutationQueues<T>(absolutePaths: string[], fn: () => Promise<T>): Promise<T> {
  const uniquePaths = Array.from(new Set(absolutePaths)).sort();

  const runWithQueue = async (index: number): Promise<T> => {
    if (index >= uniquePaths.length) return fn();
    return withFileMutationQueue(uniquePaths[index], () => runWithQueue(index + 1));
  };

  return runWithQueue(0);
}

export function groupReplacementsByPath(replacements: SymbolReplacement[], cwd: string): FileReplacementBatch[] {
  const batches = new Map<string, FileReplacementBatch>();

  for (const replacement of replacements) {
    const cleanedPath = replacement.path.replace(/^@/, "");
    const absolutePath = resolve(cwd, cleanedPath);
    const existing = batches.get(absolutePath);
    if (existing) {
      existing.replacements.push(replacement);
    } else {
      batches.set(absolutePath, {
        absolutePath,
        displayPath: replacement.path,
        replacements: [replacement],
      });
    }
  }

  return Array.from(batches.values());
}

export function applyResolvedSymbolReplacements(
  content: string,
  resolvedReplacements: ResolvedSymbolReplacement[],
  lineEnding: "\r\n" | "\n",
): string {
  const sorted = [...resolvedReplacements].sort((a, b) => a.range.startIndex - b.range.startIndex);
  for (let index = 0; index < sorted.length - 1; index++) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (current.range.endIndex > next.range.startIndex) {
      throw new Error(
        `Overlapping replacements detected for symbols '${current.replacement.symbol}' and '${next.replacement.symbol}' in ${current.replacement.path}.`,
      );
    }
  }

  let nextContent = content;
  for (const item of sorted.sort((a, b) => b.range.startIndex - a.range.startIndex)) {
    const replacementText = normalizeReplacementText(item.replacement.text, lineEnding);
    nextContent = nextContent.slice(0, item.range.startIndex) + replacementText + nextContent.slice(item.range.endIndex);
  }

  return nextContent;
}

/**
 * Directories the delete pre-check scans. `ctx.cwd` covers the normal case; a target outside it
 * contributes its project root (nearest ancestor holding `.git`) so a same-project call site is not
 * missed just because the file was named by absolute path.
 */
export function scanRootsFor(absolutePaths: string[], cwd: string): string[] {
  const roots = new Set<string>([cwd]);
  for (const absolutePath of absolutePaths) {
    roots.add(nearestProjectRoot(absolutePath) ?? dirname(absolutePath));
  }
  const kept: string[] = [];
  for (const root of Array.from(roots).sort((a, b) => a.length - b.length)) {
    if (!kept.some((parent) => root === parent || root.startsWith(parent + sep))) kept.push(root);
  }
  return kept;
}

function nearestProjectRoot(absolutePath: string): string | null {
  let dir = dirname(absolutePath);
  for (let depth = 0; depth < 40; depth++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function summarizeReplacementBatches(
  preparedBatches: PreparedFileReplacementBatch[],
  replacements: SymbolReplacement[],
): string {
  const edits = replacements.length;
  const files = preparedBatches.length;
  const verb = replacements.every((replacement) => replacement.text === "") ? "Deleted" : "Replaced";
  return `${verb} ${edits} ${edits === 1 ? "symbol" : "symbols"} in ${files} ${files === 1 ? "file" : "files"}.`;
}

export function registerReplaceSymbolTool(pi: ExtensionAPI, scanner: SymbolScanner): void {
  pi.registerTool({
    name: "replace_symbol",
    label: "Replace Symbol",
    description: "Replace or delete AST symbols by name using tree-sitter ranges.",
    promptSnippet: "Use replace_symbol for complete function, method, class, or interface replacements.",
    promptGuidelines: [
      "Pass text: \"\" to delete a symbol; the call refuses when surviving references exist unless force is true.",
      "Provide complete raw code without line-number prefixes; prefixes are stripped if accidentally included.",
      "Use find_symbol_references first when a rename or signature change could affect other files.",
    ],
    parameters: ReplaceSymbolSchema,
    renderCall(args, theme) {
      const paths = Array.isArray(args.replacements)
        ? args.replacements.map((replacement) => replacement.path).filter((path): path is string => typeof path === "string")
        : [];
      return renderCodeLikeCall("replace_symbol", paths, theme);
    },
    renderResult(result, options, theme, context) {
      return renderDiffResult(result as never, options, theme, context, "Replacing");
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const replacements = params.replacements as SymbolReplacement[] | undefined;
      if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error("Missing required parameter: replacements");
      }

      const batches = groupReplacementsByPath(replacements, ctx.cwd);
      let diffs: DiffDetails[] = [];
      let undoLine = "";
      const summaries: string[] = [];

      await withFileMutationQueues(batches.map((batch) => batch.absolutePath), async () => {
        const preparedBatches: PreparedFileReplacementBatch[] = [];
        let locations: SymbolLocation[] | undefined;

        const scanRoots = scanRootsFor(batches.map((batch) => batch.absolutePath), ctx.cwd);
        const scanForDeletes = async (): Promise<SymbolLocation[]> => {
          locations ??= (
            await Promise.all(scanRoots.map((root) => scanner.scanPaths([root], ctx.cwd, signal)))
          ).flat();
          return locations;
        };

        for (const batch of batches) {
          throwIfAborted(signal);
          const snapshot = await readSnapshot(batch.absolutePath, ctx.cwd);
          const originalContent = snapshot.raw.toString("utf-8");
          const lineEnding = detectLineEnding(originalContent);

          const resolved: ResolvedSymbolReplacement[] = [];
          const deleteSummaries: string[] = [];

          for (const replacement of batch.replacements) {
            throwIfAborted(signal);
            const range = await resolveSymbolDefinition(
              batch.absolutePath,
              batch.displayPath,
              replacement.symbol,
              replacement.type,
            );
            if (!range) throw new Error(missingSymbolMessage(replacement));

            if (replacement.text !== "") {
              resolved.push({ replacement, range });
              continue;
            }

            const deleteRange = computeDeleteRange(originalContent, range);
            const candidates = await scanForDeletes();
            const blockers = blockingReferences(candidates, range.nameText, batch.absolutePath, originalContent, deleteRange);
            if (blockers.length > 0 && replacement.force !== true) {
              const list = blockers.map((ref) => `  ${ref.displayPath}:${ref.line}`).join("\n");
              const label = blockers.length === 1 ? "reference" : "references";
              throw new Error(
                `Refusing to delete '${replacement.symbol}' from ${replacement.path}: ${blockers.length} surviving ${label} found.\n${list}\n\nVerify the call sites, or set force: true to delete anyway.`,
              );
            }

            const referenceNote =
              blockers.length > 0
                ? `symbol '${replacement.symbol}' (${blockers.length} references ignored, force was set)`
                : `unreferenced symbol '${replacement.symbol}'`;
            deleteSummaries.push(`Deleted ${referenceNote} from ${replacement.path}.`);
            resolved.push({ replacement, range: { ...range, ...deleteRange } });
          }

          throwIfAborted(signal);
          const finalContent = applyResolvedSymbolReplacements(originalContent, resolved, lineEnding);
          const diff = createUnifiedDiff(batch.displayPath, originalContent, finalContent);
          const replaced = batch.replacements.filter((replacement) => replacement.text !== "");
          const symbolList = replaced.map((replacement) => `'${replacement.symbol}'`).join(", ");

          preparedBatches.push({
            batch,
            snapshot,
            after: Buffer.from(finalContent, "utf-8"),
            finalContent,
            diff,
            summaries: [
              ...(replaced.length > 0 ? [`Successfully replaced symbols ${symbolList} in ${batch.displayPath}.`] : []),
              ...deleteSummaries,
            ],
          });
        }

        diffs = preparedBatches.map((prepared) => prepared.diff).filter((diff) => diff.diff.length > 0);

        const report = await recordAndWriteLocked(
          preparedBatches.map((prepared) => ({
            snapshot: prepared.snapshot,
            after: prepared.after,
            summary: prepared.summaries.join(" "),
          })),
          {
            cwd: ctx.cwd,
            kind: "replace_symbol",
            headline: summarizeReplacementBatches(preparedBatches, replacements),
            session: sessionOf(ctx),
            signal,
          },
        );
        undoLine = undoHint(report.commitId);

        for (const prepared of preparedBatches) {
          throwIfAborted(signal);
          scanner.invalidate(prepared.batch.absolutePath);
          summaries.push(...prepared.summaries);
        }
      });

      return {
        content: [{ type: "text", text: `${summaries.join("\n")}${undoLine}` }],
        details: {
          paths: batches.map((batch) => batch.displayPath),
          symbols: replacements.map((replacement) => replacement.symbol),
          diffs,
          diff: combineDiffs(diffs),
          firstChangedLine: diffs[0]?.firstChangedLine,
        } satisfies ReplaceSymbolToolDetails,
      };
    },
  });
}
