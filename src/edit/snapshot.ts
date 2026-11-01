import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expandPath } from "../read/paths.js";

const BOM = "\uFEFF";

export interface TextSnapshot {
  absolutePath: string;
  displayPath: string;
  /** LF-normalized, BOM-stripped content used for matching. */
  text: string;
  /** Exactly the bytes that were on disk, for rollback and restore-on-failure. */
  raw: Buffer;
  bom: string;
  eol: "\r\n" | "\n";
  sha: string;
  mode: number;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectEol(text: string): "\r\n" | "\n" {
  return text.match(/\r\n|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

export async function readSnapshot(displayPath: string, cwd: string): Promise<TextSnapshot> {
  const absolutePath = expandPath(displayPath, cwd);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`${displayPath} is not a regular file`);

  const raw = await readFile(absolutePath);
  const decoded = raw.toString("utf-8");
  const bom = decoded.startsWith(BOM) ? BOM : "";
  const withoutBom = bom ? decoded.slice(BOM.length) : decoded;

  return {
    absolutePath,
    displayPath,
    text: normalizeToLF(withoutBom),
    raw,
    bom,
    eol: detectEol(withoutBom),
    sha: sha256(raw),
    mode: info.mode & 0o777,
  };
}

/** Restores a snapshot's exact bytes, bypassing the concurrency check. */
export async function restoreSnapshot(snapshot: TextSnapshot): Promise<void> {
  await writeFile(snapshot.absolutePath, snapshot.raw);
}

// The temp file name keeps the real name as a prefix so editors and watchers can still tell what
// it belongs to; the leading dot keeps it out of globs and the file scanner.
function tempPathFor(absolutePath: string): string {
  return join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
}

/**
 * Writes modified content back with BOM and line endings restored.
 *
 * The write goes to a sibling temp file and is renamed into place, so a crash cannot leave a
 * half-written source file. Immediately before the rename the current on-disk hash is compared
 * with the hash we read: another agent writing the same file in the meantime makes this call fail
 * instead of silently clobbering their change.
 */
/** The exact bytes `writeSnapshot` would put on disk for this content. */
export function serializeSnapshot(snapshot: TextSnapshot, text: string): string {
  return snapshot.bom + (snapshot.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

export async function writeSnapshot(snapshot: TextSnapshot, text: string, signal?: AbortSignal): Promise<void> {
  const restored = serializeSnapshot(snapshot, text);
  const tempPath = tempPathFor(snapshot.absolutePath);

  try {
    await writeFile(tempPath, restored, { encoding: "utf-8", signal });
    await chmod(tempPath, snapshot.mode);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  let currentSha: string;
  try {
    currentSha = sha256(await readFile(snapshot.absolutePath));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  if (currentSha !== snapshot.sha) {
    await rm(tempPath, { force: true });
    throw new Error(
      `${snapshot.displayPath} changed while editing (expected ${snapshot.sha.slice(0, 8)}, found ${currentSha.slice(0, 8)}); re-read the file and retry`,
    );
  }

  await rename(tempPath, snapshot.absolutePath);
}

/**
 * Acquires pi's per-file mutation queues in sorted order, so several files can be held for the
 * duration of one transaction without two callers deadlocking on each other.
 */
export async function withFileMutationQueues<T>(absolutePaths: string[], fn: () => Promise<T>): Promise<T> {
  const uniquePaths = Array.from(new Set(absolutePaths)).sort();
  const run = async (index: number): Promise<T> => {
    if (index >= uniquePaths.length) return fn();
    return withFileMutationQueue(uniquePaths[index], () => run(index + 1));
  };
  return run(0);
}
