import { applyPatch, createPatch } from "diff";
import {
  readSnapshot,
  serializeSnapshot,
  textOfBytes,
  withFileMutationQueues,
  writeNewFile,
  writeSnapshotBytes,
  type TextSnapshot,
} from "../edit/snapshot.js";
import { combineDiffs, createPiDiff, createUnifiedPatch, type DiffDetails } from "../rendering/diff-output.js";
import {
  captureBaseBlobs,
  readCommitBlobs,
  recordTransaction,
  type HistorySession,
  type StoredFile,
  type StoredTransaction,
} from "./store.js";

export interface PendingWrite {
  snapshot: TextSnapshot;
  /** Exact bytes the file must have afterwards. */
  after: Buffer;
  /** Create the file instead of updating it: it was recorded in history but is gone from disk. */
  create?: boolean;
  summary?: string;
}

export interface WriteReport {
  commitId: string | null;
  diffs: DiffDetails[];
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export class RestoreConflictError extends Error {}

/** The parts of a tool context that a transaction records about the session. */
export interface SessionSource {
  sessionManager?: {
    getSessionId?: () => string | undefined;
    getSessionDir?: () => string | undefined;
    getSessionFile?: () => string | undefined;
  };
}

export function sessionOf(ctx: SessionSource): HistorySession {
  return {
    id: ctx.sessionManager?.getSessionId?.(),
    dir: ctx.sessionManager?.getSessionDir?.(),
    file: ctx.sessionManager?.getSessionFile?.(),
  };
}

/** The model-facing line that tells the caller how to undo the transaction just recorded. */
export function undoHint(commitId: string | null): string {
  if (commitId === null) return "\n(History unavailable: this change cannot be undone.)";
  const shortId = commitId.slice(0, 12);
  return `\nTransaction ${shortId} — undo with rewind({ id: "${shortId}", mode: "undo" })`;
}

/**
 * Records a transaction, then writes every file from the content of the commit it just created.
 *
 * The commit is the source of truth: the bytes written to disk are read back out of it, so disk and
 * history cannot disagree. When history is unavailable the files are written from the in-memory
 * content instead, and the caller is told there is no undo id.
 *
 * Holds pi's per-file mutation queues for the whole transaction, so a concurrent edit tool call in
 * this process cannot interleave between recording and writing.
 */
export async function recordAndWrite(
  writes: PendingWrite[],
  options: { cwd: string; kind: string; headline: string; session?: HistorySession; signal?: AbortSignal; notes?: string[] },
): Promise<WriteReport> {
  return withFileMutationQueues(
    writes.map((write) => write.snapshot.absolutePath),
    () => recordAndWriteLocked(writes, options),
  );
}

/** Same as {@link recordAndWrite} for callers that already hold the per-file mutation queues. */
export async function recordAndWriteLocked(
  writes: PendingWrite[],
  options: { cwd: string; kind: string; headline: string; session?: HistorySession; signal?: AbortSignal; notes?: string[] },
): Promise<WriteReport> {
  const absolutePaths = writes.map((write) => write.snapshot.absolutePath);
  const baseBlobs = await captureBaseBlobs(absolutePaths);
  const commitId = await recordTransaction({
    cwd: options.cwd,
    kind: options.kind,
    headline: options.headline,
    session: options.session,
    notes: options.notes,
    files: writes.map((write) => ({
      absolutePath: write.snapshot.absolutePath,
      displayPath: write.snapshot.displayPath,
      before: write.snapshot.raw,
      after: write.after,
      mode: write.snapshot.mode,
      baseBlob: baseBlobs.get(write.snapshot.absolutePath) ?? null,
      summary: write.summary,
    })),
  });

  const committed = commitId ? await readCommitBlobs(commitId, absolutePaths) : null;

  const written: TextSnapshot[] = [];
  try {
    for (const write of writes) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("edit aborted");
      const bytes = committed?.get(write.snapshot.absolutePath) ?? write.after;
      if (write.create) await writeNewFile(write.snapshot.absolutePath, bytes, write.snapshot.mode, options.signal);
      else await writeSnapshotBytes(write.snapshot, bytes, options.signal);
      written.push(write.snapshot);
    }
  } catch (error) {
    for (const snapshot of written.reverse()) {
      try {
        await writeFileRaw(snapshot);
      } catch {
        // Best effort: the recorded transaction, when there is one, stays the authoritative undo.
      }
    }
    throw error;
  }

  const diffs = writes.map((write) => ({
    path: write.snapshot.displayPath,
    ...createPiDiff(write.snapshot.text, textOfBytes(write.after)),
  }));
  const changed = diffs.filter((diff) => diff.diff.length > 0);

  return {
    commitId,
    diffs,
    diff: combineDiffs(diffs),
    patch: createUnifiedPatch(
      writes.map((write) => ({ path: write.snapshot.displayPath, before: write.snapshot.text, after: textOfBytes(write.after) })),
    ),
    firstChangedLine: changed[0]?.firstChangedLine,
  };
}

async function writeFileRaw(snapshot: TextSnapshot): Promise<void> {
  await writeNewFile(snapshot.absolutePath, snapshot.raw, snapshot.mode);
}

/** A snapshot of a file that history knows but disk does not, ready to be created. */
function missingSnapshot(file: StoredFile): TextSnapshot {
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    text: "",
    raw: Buffer.alloc(0),
    bom: "",
    eol: "\n",
    sha: "",
    mode: file.mode,
  };
}

async function snapshotOf(file: StoredFile, cwd: string): Promise<{ snapshot: TextSnapshot; exists: boolean }> {
  try {
    return { snapshot: await readSnapshot(file.absolutePath, cwd), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { snapshot: missingSnapshot(file), exists: false };
    throw error;
  }
}

/** Sets the files back to exactly the bytes they had at a commit. */
export async function restoreTransaction(
  transaction: StoredTransaction,
  files: StoredFile[],
  options: { cwd: string; session?: HistorySession; signal?: AbortSignal },
): Promise<WriteReport> {
  const missing = files.filter((file) => file.after === null);
  if (missing.length > 0) {
    throw new RestoreConflictError(`No recorded version of ${missing.map((file) => file.displayPath).join(", ")} at ${transaction.id.slice(0, 8)}.`);
  }

  const writes: PendingWrite[] = [];
  for (const file of files) {
    const { snapshot, exists } = await snapshotOf(file, options.cwd);
    writes.push({ snapshot, after: file.after as Buffer, create: !exists, summary: `restored ${transaction.id.slice(0, 8)}` });
  }

  return recordAndWrite(writes, {
    cwd: options.cwd,
    kind: "rewind",
    headline: `restore ${files.length} file${files.length === 1 ? "" : "s"} to ${transaction.id.slice(0, 8)}`,
    session: options.session,
    signal: options.signal,
    notes: [`restores: ${transaction.id}`, `restore-mode: restore`],
  });
}

/**
 * Reverts the change a transaction made.
 *
 * A file that still holds the transaction's output is restored byte for byte from the recorded
 * earlier version. A file that moved on since is patched in reverse, keeping the unrelated edits
 * that landed in between; when even that does not apply cleanly, nothing is written and the
 * conflict is reported.
 */
export async function undoTransaction(
  transaction: StoredTransaction,
  files: StoredFile[],
  options: { cwd: string; session?: HistorySession; signal?: AbortSignal },
): Promise<WriteReport> {
  const writes: PendingWrite[] = [];
  const conflicts: string[] = [];

  for (const file of files) {
    if (file.before === null) {
      conflicts.push(`${file.displayPath}: no earlier version recorded, so this change cannot be reverted`);
      continue;
    }
    const { snapshot, exists } = await snapshotOf(file, options.cwd);

    if (!exists) {
      writes.push({ snapshot, after: file.before, create: true, summary: "recreated" });
      continue;
    }

    const afterText = file.after ? textOfBytes(file.after) : "";
    if (snapshot.text === afterText) {
      writes.push({ snapshot, after: file.before, summary: "reverted" });
      continue;
    }

    const patched = reversePatch(snapshot.text, afterText, textOfBytes(file.before));
    if (patched === null) {
      conflicts.push(`${file.displayPath}: changed since ${transaction.id.slice(0, 8)} and the reverse patch no longer applies`);
      continue;
    }
    writes.push({ snapshot, after: Buffer.from(serializeSnapshot(snapshot, patched), "utf-8"), summary: "patched" });
  }

  if (conflicts.length > 0) {
    throw new RestoreConflictError(
      `Cannot undo ${transaction.id.slice(0, 8)} cleanly, nothing was written:\n${conflicts.map((line) => `  ${line}`).join("\n")}\n` +
        "Re-read the files and edit the affected regions directly, or use mode \"restore\" for the recorded version.",
    );
  }

  return recordAndWrite(writes, {
    cwd: options.cwd,
    kind: "rewind",
    headline: `undo ${files.length} file change${files.length === 1 ? "" : "s"} from ${transaction.id.slice(0, 8)}`,
    session: options.session,
    signal: options.signal,
    notes: [`undoes: ${transaction.id}`, `restore-mode: undo`],
  });
}

/** Applies the change in reverse to current content; null when a hunk does not fit. */
function reversePatch(currentText: string, afterText: string, beforeText: string): string | null {
  if (afterText === beforeText) return currentText;
  const patch = createPatch("file", afterText, beforeText, "", "", { context: 3 });
  const applied = applyPatch(currentText, patch, { fuzzFactor: 1 });
  return typeof applied === "string" ? applied : null;
}
