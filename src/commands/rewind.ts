import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { textOfBytes } from "../edit/snapshot.js";
import { restoreTransaction } from "../history/restore.js";
import { getTransaction, listTrackedFiles, listVersions, recentTransactionIds, type StoredFile } from "../history/store.js";
import { createPiDiff } from "../rendering/diff-output.js";

/**
 * `/rewind` — the human face of the recorded file history.
 *
 * Mirrors VS Code's local file history: pick a file, then pick one of its versions, see the diff,
 * confirm, and the file is restored. Restores go through the same recorded transaction as the
 * rewind tool, so a mistaken pick is itself undoable.
 */

const PREVIEW_LINES = 40;

function pad(value: number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function timestampOf(at: number): string {
  const date = new Date(at);
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  return `${parts[0]}-${pad(parts[1], 2)}-${pad(parts[2], 2)} ${pad(parts[3], 2)}:${pad(parts[4], 2)}:${pad(parts[5], 2)}`;
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Numbered picker rows, mapped back to their item by exact label.
 *
 * pi's dialog API takes strings and returns a string, so the number is what makes a row unique
 * even when two versions format identically.
 */
async function pick<T>(
  ui: ExtensionCommandContext["ui"],
  title: string,
  items: readonly T[],
  format: (item: T, index: number) => string,
): Promise<T | undefined> {
  const width = String(items.length).length;
  const rows = items.map((item, index) => ({ item, label: `${pad(index + 1, width)}. ${format(item, index)}` }));
  const choice = await ui.select(title, rows.map((row) => row.label));
  if (!choice) return undefined;
  return rows.find((row) => row.label === choice)?.item;
}

function diffFor(currentText: string, targetText: string): string {
  return createPiDiff(currentText, targetText).diff;
}

function previewOf(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= PREVIEW_LINES) return diff;
  return `${lines.slice(0, PREVIEW_LINES).join("\n")}\n... (${lines.length - PREVIEW_LINES} more diff lines)`;
}

async function currentTextOf(file: StoredFile): Promise<string> {
  try {
    return textOfBytes(await readFile(file.absolutePath));
  } catch {
    return "";
  }
}

async function rewindFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;

  const files = await listTrackedFiles(ctx.cwd);
  if (files.length === 0) {
    ui.notify(`No file history recorded for ${ctx.cwd} yet. Every edit and rewind records one transaction.`, "info");
    return;
  }

  const file = await pick(ui, "File history", files, (entry) =>
    `${entry.displayPath}  (${entry.versions} version${entry.versions === 1 ? "" : "s"}, last ${relativeTime(entry.lastChangedAt)})`,
  );
  if (!file) return;

  const versions = await listVersions(file.absolutePath);
  if (versions.length === 0) {
    ui.notify(`No recorded versions of ${file.displayPath}.`, "info");
    return;
  }

  const version = await pick(ui, `${file.displayPath} — pick a version to restore`, versions, (entry) =>
    `${timestampOf(entry.createdAt)}  +${entry.added} -${entry.deleted}  ${entry.id.slice(0, 7)}`,
  );
  if (!version) return;

  const transaction = await getTransaction(version.id, ctx.cwd);
  if (!transaction) {
    const recent = await recentTransactionIds(ctx.cwd).catch(() => []);
    ui.notify(`Transaction ${version.id.slice(0, 7)} is no longer in the history.${recent.length > 0 ? ` Recent: ${recent.join(", ")}` : ""}`, "error");
    return;
  }

  const stored = transaction.files.find((candidate) => candidate.absolutePath === file.absolutePath);
  if (!stored?.after) {
    ui.notify(`${file.displayPath} has no content recorded at ${version.id.slice(0, 7)}.`, "warning");
    return;
  }

  const diff = diffFor(await currentTextOf(stored), textOfBytes(stored.after));
  const confirmed = await ui.confirm(
    `Restore ${file.displayPath} to ${timestampOf(version.createdAt)}?`,
    diff.length > 0 ? previewOf(diff) : "(no textual difference from the current file)",
  );
  if (!confirmed) return;

  const report = await restoreTransaction(transaction, [stored], {
    cwd: ctx.cwd,
    session: {
      id: ctx.sessionManager?.getSessionId?.(),
      dir: ctx.sessionManager?.getSessionDir?.(),
      file: ctx.sessionManager?.getSessionFile?.(),
    },
  });
  ui.notify(
    report.commitId
      ? `Restored ${file.displayPath} to ${timestampOf(version.createdAt)} (transaction ${report.commitId.slice(0, 7)}).`
      : `Restored ${file.displayPath}; history is unavailable, so this restore cannot be undone.`,
    "info",
  );
}

export function registerRewindCommand(pi: ExtensionAPI): void {
  pi.registerCommand("rewind", {
    description: "Browse a file's recorded versions and restore one",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("File history needs interactive mode; use the rewind tool instead.", "warning");
        return;
      }
      try {
        await rewindFlow(ctx);
      } catch (error) {
        ctx.ui.notify(`rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
