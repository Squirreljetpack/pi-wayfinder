import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { restoreTransaction, sessionOf, undoTransaction } from "../history/restore.js";
import {
  getTransaction,
  listTrackedFiles,
  listVersions,
  recentTransactionIds,
  type StoredFile,
  type StoredTransaction,
} from "../history/store.js";
import { expandPath } from "../paths.js";
import { combineDiffs, createPiDiff, type DiffDetails } from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderCodeLikeResult, renderDiffResult } from "../rendering/pi-renderers.js";
import { textOfBytes } from "../edit/snapshot.js";
import { formatNumberedLine } from "./line-numbers.js";
import { RewindSchema } from "./schemas.js";

export interface RewindToolDetails {
  mode: "files" | "versions" | "show" | "preview" | "undo" | "restore";
  paths: string[];
  transactionId?: string;
  targetId?: string;
  diffs?: DiffDetails[];
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
}

const PREVIEW_MAX_LINES = 400;

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function timestampOf(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Numbered file content, capped so a preview cannot flood the context. */
function numberedPreview(content: string): string {
  const truncated = truncateHead(content, { maxLines: PREVIEW_MAX_LINES });
  const lines = truncated.content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const numbered = lines.map((line, index) => formatNumberedLine(index + 1, line)).join("\n");
  return truncated.truncated ? `${numbered}\n\n[Preview truncated at ${PREVIEW_MAX_LINES} lines of ${truncated.totalLines}]` : numbered;
}

function selectFiles(files: StoredFile[], path: string | undefined, cwd: string): StoredFile[] {
  if (!path) return files;
  const wanted = expandPath(path, cwd);
  const matches = files.filter((file) => file.absolutePath === wanted);
  if (matches.length === 0) {
    throw new Error(`${path} was not changed by this transaction. It changed: ${files.map((file) => file.displayPath).join(", ")}`);
  }
  return matches;
}

async function requireTransaction(id: string, cwd: string): Promise<StoredTransaction> {
  const transaction = await getTransaction(id, cwd);
  if (transaction) return transaction;
  const recent = await recentTransactionIds(cwd).catch(() => []);
  const hint = recent.length > 0 ? `\nRecent transactions in this directory: ${recent.join(", ")}` : "";
  throw new Error(`Transaction ${id} not found.${hint}`);
}

async function listFilesResult(ctx: ExtensionToolContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: RewindToolDetails }> {
  const files = await listTrackedFiles(ctx.cwd);
  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No file history is recorded for ${ctx.cwd} yet. Every edit and rewind records one transaction.` }],
      details: { mode: "files", paths: [] },
    };
  }
  const rows = files.map(
    (file) => `  ${file.displayPath}  (${file.versions} version${file.versions === 1 ? "" : "s"}, last ${relativeTime(file.lastChangedAt)})`,
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `Files with recorded history in ${ctx.cwd}:\n${rows.join("\n")}\n\nCall rewind({ path }) to list the versions of one file.`,
      },
    ],
    details: { mode: "files", paths: files.map((file) => file.displayPath) },
  };
}

async function listVersionsResult(ctx: ExtensionToolContext, path: string): Promise<{ content: Array<{ type: "text"; text: string }>; details: RewindToolDetails }> {
  const versions = await listVersions(expandPath(path, ctx.cwd));
  if (versions.length === 0) {
    return { content: [{ type: "text" as const, text: `No recorded versions of ${path}.` }], details: { mode: "versions", paths: [path] } };
  }
  const rows = versions.map(
    (version) => `  ${version.id.slice(0, 7)}  ${timestampOf(version.createdAt)}  +${version.added} -${version.deleted}  ${version.subject}`,
  );
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Versions of ${path} (newest first):\n${rows.join("\n")}\n\n` +
          `rewind({ id }) shows what that transaction changed; rewind({ id, mode: "preview" }) shows the file as of that transaction; ` +
          `rewind({ id, mode: "undo" }) reverts it; rewind({ id, mode: "restore" }) puts the file back to that version.`,
      },
    ],
    details: { mode: "versions", paths: [path] },
  };
}

function showResult(transaction: StoredTransaction, files: StoredFile[]): { content: Array<{ type: "text"; text: string }>; details: RewindToolDetails } {
  const diffs: DiffDetails[] = files.map((file) => ({
    path: file.displayPath,
    ...createPiDiff(textOfBytes(file.before ?? Buffer.alloc(0)), textOfBytes(file.after ?? Buffer.alloc(0))),
  }));
  const diff = combineDiffs(diffs);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${transaction.id.slice(0, 7)} ${transaction.subject}\n` +
          `${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((file) => file.displayPath).join(", ")}\n\n` +
          `${diff || "(no textual change)"}`,
      },
    ],
    details: { mode: "show", paths: files.map((file) => file.displayPath), transactionId: transaction.id, diffs, diff },
  };
}

function previewResult(transaction: StoredTransaction, files: StoredFile[]): { content: Array<{ type: "text"; text: string }>; details: RewindToolDetails } {
  const blocks = files.map((file) => {
    const content = file.after ? file.after.toString("utf-8") : "";
    return `--- ${file.displayPath} at ${transaction.id.slice(0, 7)} ---\n${numberedPreview(content)}`;
  });
  return {
    content: [{ type: "text" as const, text: blocks.join("\n\n") }],
    details: { mode: "preview", paths: files.map((file) => file.displayPath), transactionId: transaction.id },
  };
}

async function applyResult(
  ctx: ExtensionToolContext,
  transaction: StoredTransaction,
  files: StoredFile[],
  mode: "undo" | "restore",
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: RewindToolDetails }> {
  const session = sessionOf(ctx);
  const report =
    mode === "undo"
      ? await undoTransaction(transaction, files, { cwd: ctx.cwd, session, signal })
      : await restoreTransaction(transaction, files, { cwd: ctx.cwd, session, signal });

  const lines = [
    `${mode === "undo" ? "Reverted" : "Restored"} ${files.length} file${files.length === 1 ? "" : "s"} from ${transaction.id.slice(0, 8)}.`,
  ];
  for (const file of files) lines.push(`  ${file.displayPath}`);
  const opposite = mode === "undo" ? "restore" : "undo";
  const shortId = report.commitId?.slice(0, 12);
  lines.push(
    shortId
      ? `Transaction ${shortId} — reverse it with rewind({ id: "${shortId}", mode: "${opposite}" }).`
      : "(History unavailable: this change cannot be undone.)",
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode,
      paths: files.map((file) => file.displayPath),
      transactionId: report.commitId ?? undefined,
      targetId: transaction.id,
      diffs: report.diffs,
      diff: report.diff,
      patch: report.patch,
      firstChangedLine: report.firstChangedLine,
    },
  };
}

export function registerRewindTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rewind",
    label: "Rewind",
    description:
      "Browse recorded file history and put files back to an earlier transaction. With no arguments it lists the files that have history in the working directory; with path only it lists that file's versions.",
    promptSnippet: "Browse recorded file history and undo or restore a transaction's file changes",
    promptGuidelines: [
      "rewind({}) lists files with recorded history; rewind({ path }) lists one file's versions with their ids, times and +/- line counts.",
      'rewind({ id, mode: "show" }) shows what a transaction changed; mode "preview" shows the file content at it. Use preview before restore, show before undo.',
      'rewind({ id, mode: "undo" }) reverts the change, keeping edits that landed afterwards by patching around them; it writes nothing when the patch no longer applies.',
      'rewind({ id, mode: "restore" }) overwrites the involved files with their content at that transaction, discarding later edits. Every undo and restore is a transaction too, reversed with the opposite mode.',
    ],
    parameters: RewindSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    renderCall(args, theme) {
      const parts: string[] = [];
      if (typeof args.mode === "string") parts.push(args.mode);
      if (typeof args.path === "string") parts.push(args.path);
      if (typeof args.id === "string") parts.push(args.id);
      return renderCodeLikeCall("rewind", parts, theme);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as RewindToolDetails | undefined;
      if (details?.mode === "undo" || details?.mode === "restore") {
        return renderDiffResult(result as never, options, theme, context, details.mode === "undo" ? "Reverting" : "Restoring");
      }
      return renderCodeLikeResult(result as never, options, theme, context);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = typeof params.path === "string" && params.path.length > 0 ? params.path : undefined;
      const id = typeof params.id === "string" && params.id.length > 0 ? params.id : undefined;
      const mode = params.mode as "show" | "preview" | "undo" | "restore" | undefined;

      if (!id) {
        if (mode === "show" || mode === "preview" || mode === "undo" || mode === "restore") {
          throw new Error(`mode "${mode}" needs an id; use "last" for the newest transaction in this directory`);
        }
        return path ? listVersionsResult(ctx, path) : listFilesResult(ctx);
      }

      const transaction = await requireTransaction(id, ctx.cwd);
      const files = selectFiles(transaction.files, path, ctx.cwd);

      switch (mode) {
        case undefined:
        case "show":
          return showResult(transaction, files);
        case "preview":
          return previewResult(transaction, files);
        case "undo":
          return applyResult(ctx, transaction, files, "undo", signal);
        case "restore":
          return applyResult(ctx, transaction, files, "restore", signal);
        default:
          throw new Error(`Unknown mode ${String(mode)}; use show, preview, undo or restore`);
      }
    },
  });
}
