import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * File history as a git repository.
 *
 * One bare repository holds every project: an absolute path maps onto the tree by dropping the
 * leading slash, so `/home/me/app/a.ts` lives at `home/me/app/a.ts`. Each transaction is one
 * commit whose parent is the previous transaction, which means the tree at any commit is the
 * recorded state of every file the history has ever seen.
 *
 * A transaction never checks anything out. Blobs go in with `hash-object`, the tree is assembled
 * in a private index file, the commit is created with `commit-tree`, and the branch is advanced
 * with a compare-and-swap `update-ref`. Two pi sessions can therefore commit concurrently without
 * ever sharing a worktree; the loser of the swap rebuilds on the new parent, and a real conflict
 * (both sessions changing the same file) is reported instead of silently merged.
 */

export const HISTORY_BRANCH = "refs/heads/main";

/**
 * Where a commit keeps the bytes each file had before the transaction.
 *
 * The mirror tree holds the post-edit state at the commit's own path. Recording the pre-edit bytes
 * in the same commit (instead of reading them from the parent) makes undo exact even for the first
 * transaction that ever touched a file, and keeps them reachable for git's garbage collector.
 */
const PREIMAGE_PREFIX = ".pi-wayfinder";

/** Pathspec that matches this exact path, not its glob interpretation. */
function literal(repoPath: string): string {
  return `:(literal)${repoPath}`;
}

function preimagePath(repoPath: string): string {
  return `${PREIMAGE_PREFIX}/${repoPath}`;
}

function isPreimagePath(repoPath: string): boolean {
  return repoPath === PREIMAGE_PREFIX || repoPath.startsWith(`${PREIMAGE_PREFIX}/`);
}

const COMMIT_CONFIG: Record<string, string> = {
  // Maximum compression for both the loose objects written per transaction and later packfiles.
  "core.compression": "9",
  "core.looseCompression": "9",
  "pack.compression": "9",
  // Bytes are stored exactly as they were on disk, so git must never rewrite line endings.
  "core.autocrlf": "false",
  "core.safecrlf": "false",
  "commit.gpgsign": "false",
  "tag.gpgsign": "false",
  "user.name": "pi-wayfinder",
  "user.email": "wayfinder@pi.local",
};

export class HistoryUnavailableError extends Error {}

export class HistoryConflictError extends Error {}

export interface HistorySession {
  id?: string;
  dir?: string;
  file?: string;
}

export interface HistoryFile {
  absolutePath: string;
  displayPath: string;
  /** Raw bytes the file had when the transaction read it. */
  before: Buffer;
  /** Raw bytes the transaction wants on disk afterwards. */
  after: Buffer;
  mode: number;
  /** Blob `HEAD:path` pointed at when the file was read; null when history had no version. */
  baseBlob: string | null;
  /** Human summary for this file, e.g. `2 edits, 3 replacements`. */
  summary?: string;
}

export interface RecordOptions {
  cwd: string;
  kind: string;
  headline: string;
  files: HistoryFile[];
  session?: HistorySession;
  notes?: string[];
}

export interface StoredFile {
  repoPath: string;
  absolutePath: string;
  displayPath: string;
  before: Buffer | null;
  after: Buffer | null;
  mode: number;
  status: string;
}

export interface StoredTransaction {
  id: string;
  parent: string | null;
  kind: string;
  subject: string;
  createdAt: number;
  session?: HistorySession;
  cwd?: string;
  files: StoredFile[];
}

export interface VersionEntry {
  id: string;
  createdAt: number;
  subject: string;
  added: number;
  deleted: number;
}

export interface TrackedFile {
  repoPath: string;
  absolutePath: string;
  displayPath: string;
  versions: number;
  lastCommitId: string;
  lastChangedAt: number;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface GitOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

/** `~/.cache/pi-wayfinder/history.git`, overridable so tests get their own repository. */
export function historyRepoPath(): string {
  const home = process.env.PI_WAYFINDER_HOME ?? join(homedir(), ".cache", "pi-wayfinder");
  return join(home, "history.git");
}

function git(repo: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir", repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => reject(new HistoryUnavailableError(`git is not available: ${error.message}`)));
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf-8") };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`));
        return;
      }
      resolve(result);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function text(result: GitResult): string {
  return result.stdout.toString("utf-8");
}

const ensuredRepos = new Map<string, Promise<void>>();

async function initRepo(repo: string): Promise<void> {
  await mkdir(dirname(repo), { recursive: true });
  const init = await git(repo, ["init", "--bare", "--quiet", "-b", "main", repo], { allowFailure: true });
  if (init.code !== 0) throw new HistoryUnavailableError(`cannot initialize the history repository: ${init.stderr.trim()}`);
  for (const [key, value] of Object.entries(COMMIT_CONFIG)) {
    const result = await git(repo, ["config", key, value], { allowFailure: true });
    if (result.code !== 0) throw new HistoryUnavailableError(`cannot configure the history repository: ${result.stderr.trim()}`);
  }
}

async function ensureRepo(repo: string): Promise<void> {
  const existing = ensuredRepos.get(repo);
  if (existing) return existing;
  const pending = initRepo(repo).catch((error: unknown) => {
    ensuredRepos.delete(repo);
    throw error;
  });
  ensuredRepos.set(repo, pending);
  return pending;
}

/** A path as it appears in the history tree: `/home/me/a.ts` becomes `home/me/a.ts`. */
export function toRepoPath(absolutePath: string): string {
  if (!absolutePath.startsWith("/")) throw new Error(`history needs an absolute path, got ${absolutePath}`);
  return absolutePath.replace(/^\/+/, "");
}

export function fromRepoPath(repoPath: string): string {
  return `/${repoPath}`;
}

function modeEntry(mode: number): string {
  return mode & 0o111 ? "100755" : "100644";
}

function timestamp(value: number): string {
  return `${value} +0000`;
}

async function revParse(repo: string, revision: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", "--verify", "-q", revision], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = text(result).trim();
  return value.length > 0 ? value : null;
}

/**
 * Records the history blob ids for these paths as they are right now.
 *
 * Captured when a tool reads its files, so a later commit can tell an unrelated concurrent
 * transaction from one that moved the same file out from under the caller.
 */
export async function captureBaseBlobs(absolutePaths: string[]): Promise<Map<string, string | null>> {
  const blobs = new Map<string, string | null>();
  const repo = historyRepoPath();
  try {
    await ensureRepo(repo);
  } catch {
    return blobs;
  }
  for (const absolutePath of absolutePaths) {
    blobs.set(absolutePath, await revParse(repo, `${HISTORY_BRANCH}:${toRepoPath(absolutePath)}`));
  }
  return blobs;
}

function buildMessage(options: RecordOptions): string {
  const lines = [options.headline, ""];
  lines.push(
    `manifest: ${JSON.stringify(options.files.map((file) => ({ path: toRepoPath(file.absolutePath), summary: file.summary ?? "" })))}`,
  );
  lines.push(`kind: ${options.kind}`);
  if (options.session?.id) lines.push(`session: ${options.session.id}`);
  if (options.session?.dir) lines.push(`session-dir: ${options.session.dir}`);
  if (options.session?.file) lines.push(`session-file: ${options.session.file}`);
  lines.push(`cwd: ${options.cwd}`);
  for (const note of options.notes ?? []) lines.push(note);
  lines.push("files:");
  for (const file of options.files) {
    lines.push(`  ${toRepoPath(file.absolutePath)}${file.summary ? ` (${file.summary})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function conflictMessage(cwd: string, absolutePath: string, baseBlob: string | null): string {
  const displayPath = absolutePath.startsWith(`${cwd}/`) ? absolutePath.slice(cwd.length + 1) : absolutePath;
  const expected = baseBlob ? baseBlob.slice(0, 8) : "no recorded version";
  return (
    `${displayPath} was changed by another pi session since you read it (history recorded ${expected}). ` +
    `Re-read ${displayPath} and make the edit again; if the other change must be kept, rebase your edit onto the current file.`
  );
}

async function commitOnce(repo: string, options: RecordOptions, files: HistoryFile[]): Promise<string | null> {
  const parent = await revParse(repo, HISTORY_BRANCH);

  for (const file of files) {
    const repoPath = toRepoPath(file.absolutePath);
    const parentBlob = parent ? await revParse(repo, `${parent}:${repoPath}`) : null;
    if (parentBlob !== file.baseBlob) throw new HistoryConflictError(conflictMessage(options.cwd, file.absolutePath, file.baseBlob));
  }

  const indexDir = await mkdtemp(join(tmpdir(), "pi-wayfinder-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    if (parent) await git(repo, ["read-tree", parent], { env });

    for (const file of files) {
      const repoPath = toRepoPath(file.absolutePath);
      const after = text(await git(repo, ["hash-object", "-w", "--stdin"], { input: file.after })).trim();
      const before = text(await git(repo, ["hash-object", "-w", "--stdin"], { input: file.before })).trim();
      const mode = modeEntry(file.mode);
      await git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${after},${repoPath}`], { env });
      await git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${before},${preimagePath(repoPath)}`], { env });
    }

    const tree = text(await git(repo, ["write-tree"], { env })).trim();
    const now = Math.floor(Date.now() / 1000);
    const commitArgs = ["commit-tree", tree];
    if (parent) commitArgs.push("-p", parent);
    const commit = text(
      await git(repo, commitArgs, {
        input: buildMessage(options),
        env: { GIT_AUTHOR_DATE: timestamp(now), GIT_COMMITTER_DATE: timestamp(now) },
      }),
    ).trim();

    const swap = await git(repo, ["update-ref", HISTORY_BRANCH, commit, parent ?? "0".repeat(40)], { allowFailure: true });
    return swap.code === 0 ? commit : null;
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/**
 * Records one transaction and returns its commit id, or null when history is unavailable.
 *
 * Concurrent transactions on other files are retried by rebuilding on the new parent; a
 * transaction that would overwrite a file another session just committed throws
 * {@link HistoryConflictError} so the caller can stop before writing anything.
 */
export async function recordTransaction(options: RecordOptions): Promise<string | null> {
  const repo = historyRepoPath();
  try {
    await ensureRepo(repo);
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const commit = await commitOnce(repo, options, options.files);
      if (commit) {
        await git(repo, ["gc", "--auto", "--quiet"], { allowFailure: true });
        return commit;
      }
    } catch (error) {
      if (error instanceof HistoryConflictError) throw error;
      return null;
    }
  }
  throw new Error("the file history repository is busy: another transaction kept advancing it; retry the edit");
}

/** Resolves `last`, a full id, or any abbreviation git accepts. */
export async function resolveTransactionId(id: string, cwd: string): Promise<string | null> {
  const repo = historyRepoPath();
  await ensureRepo(repo);
  if (id === "last") {
    const result = await git(repo, ["log", "-1", "--format=%H", HISTORY_BRANCH, "--", literal(toRepoPath(cwd))], { allowFailure: true });
    const value = text(result).trim();
    return result.code === 0 && value.length > 0 ? value : null;
  }
  return revParse(repo, `${id}^{commit}`);
}

export async function recentTransactionIds(cwd: string, limit = 5): Promise<string[]> {
  const repo = historyRepoPath();
  await ensureRepo(repo);
  const result = await git(repo, ["log", `-${limit}`, "--format=%h", HISTORY_BRANCH, "--", literal(toRepoPath(cwd))], { allowFailure: true });
  if (result.code !== 0) return [];
  return text(result)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function displayPathOf(repoPath: string, cwd: string): string {
  const cwdPath = toRepoPath(cwd);
  return repoPath.startsWith(`${cwdPath}/`) ? repoPath.slice(cwdPath.length + 1) : fromRepoPath(repoPath);
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

interface TransactionMeta {
  kind: string;
  subject: string;
  session: HistorySession;
  cwd?: string;
  /** Files the transaction touched, in the order the caller listed them. */
  manifest: string[];
}

function parseMeta(message: string): TransactionMeta {
  const lines = message.split("\n");
  const subject = lines[0] ?? "";
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z-]+): (.*)$/.exec(line);
    if (match) fields.set(match[1], match[2]);
  }

  let manifest: string[] = [];
  const rawManifest = fields.get("manifest");
  if (rawManifest) {
    try {
      const parsed = JSON.parse(rawManifest) as Array<{ path?: unknown }>;
      if (Array.isArray(parsed)) {
        manifest = parsed.map((entry) => String(entry.path ?? "")).filter((path) => path.length > 0);
      }
    } catch {
      manifest = [];
    }
  }

  return {
    kind: fields.get("kind") ?? "unknown",
    subject: stripBom(subject).trim(),
    cwd: fields.get("cwd"),
    session: { id: fields.get("session"), dir: fields.get("session-dir"), file: fields.get("session-file") },
    manifest,
  };
}

export async function getTransaction(id: string, cwd: string): Promise<StoredTransaction | null> {
  const repo = historyRepoPath();
  await ensureRepo(repo);

  const commit = await resolveTransactionId(id, cwd);
  if (!commit) return null;

  const meta = text(await git(repo, ["show", "-s", "--format=%P%x00%ct%x00%B", commit]));
  const [parents, createdRaw, ...messageParts] = meta.split("\u0000");
  const message = messageParts.join("\u0000");
  const parent = parents.trim().split(" ").filter(Boolean)[0] ?? null;

  const parsed = parseMeta(message);
  const files: StoredFile[] = [];
  for (const repoPath of parsed.manifest) {
    if (isPreimagePath(repoPath)) continue;
    const afterResult = await git(repo, ["cat-file", "blob", `${commit}:${repoPath}`], { allowFailure: true });
    const beforeResult = await git(repo, ["cat-file", "blob", `${commit}:${preimagePath(repoPath)}`], { allowFailure: true });
    const tree = text(await git(repo, ["ls-tree", commit, "--", literal(repoPath)])).trim();
    const mode = Number.parseInt(tree.split(" ")[0] ?? "100644", 8) || 0o644;
    const before = beforeResult.code === 0 ? beforeResult.stdout : null;
    const after = afterResult.code === 0 ? afterResult.stdout : null;
    files.push({
      repoPath,
      absolutePath: fromRepoPath(repoPath),
      displayPath: displayPathOf(repoPath, cwd),
      before,
      after,
      mode,
      status: before === null ? "A" : after === null ? "D" : "M",
    });
  }

  return {
    id: commit,
    parent,
    kind: parsed.kind,
    subject: parsed.subject,
    createdAt: Number.parseInt(createdRaw, 10) * 1000,
    session: parsed.session,
    cwd: parsed.cwd,
    files: files.sort((a, b) => a.repoPath.localeCompare(b.repoPath)),
  };
}

/** Files recorded under `cwd`, newest first, with how many transactions touched each. */
export async function listTrackedFiles(cwd: string): Promise<TrackedFile[]> {
  const repo = historyRepoPath();
  await ensureRepo(repo);

  const result = await git(repo, ["log", "--format=\u0001%H %ct", "--name-only", HISTORY_BRANCH, "--", literal(toRepoPath(cwd))], {
    allowFailure: true,
  });
  if (result.code !== 0) return [];

  const seen = new Map<string, TrackedFile>();
  let current: { id: string; at: number } | null = null;
  for (const line of text(result).split("\n")) {
    if (line.startsWith("\u0001")) {
      const [id, at] = line.slice(1).trim().split(" ");
      current = { id, at: Number.parseInt(at, 10) * 1000 };
      continue;
    }
    const repoPath = line.trim();
    if (!current || repoPath.length === 0) continue;
    const entry = seen.get(repoPath);
    if (entry) {
      entry.versions += 1;
    } else {
      seen.set(repoPath, {
        repoPath,
        absolutePath: fromRepoPath(repoPath),
        displayPath: displayPathOf(repoPath, cwd),
        versions: 1,
        lastCommitId: current.id,
        lastChangedAt: current.at,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

/** Versions of one file, newest first, with the line counts each transaction changed. */
export async function listVersions(absolutePath: string): Promise<VersionEntry[]> {
  const repo = historyRepoPath();
  await ensureRepo(repo);

  const result = await git(
    repo,
    ["log", "--format=\u0001%H %ct %s", "--numstat", HISTORY_BRANCH, "--", literal(toRepoPath(absolutePath))],
    { allowFailure: true },
  );
  if (result.code !== 0) return [];

  const versions: VersionEntry[] = [];
  let current: VersionEntry | null = null;
  for (const line of text(result).split("\n")) {
    if (line.startsWith("\u0001")) {
      const [id, at, ...subject] = line.slice(1).trim().split(" ");
      current = { id, createdAt: Number.parseInt(at, 10) * 1000, subject: stripBom(subject.join(" ")).trim(), added: 0, deleted: 0 };
      versions.push(current);
      continue;
    }
    if (!current || line.length === 0) continue;
    const [added, deleted] = line.split("\t");
    current.added += Number.parseInt(added, 10) || 0;
    current.deleted += Number.parseInt(deleted, 10) || 0;
  }
  return versions;
}

/** Reads the recorded bytes of these paths at one commit. */
export async function readCommitBlobs(commit: string, absolutePaths: string[]): Promise<Map<string, Buffer>> {
  const repo = historyRepoPath();
  await ensureRepo(repo);
  const blobs = new Map<string, Buffer>();
  for (const absolutePath of absolutePaths) {
    const result = await git(repo, ["cat-file", "blob", `${commit}:${toRepoPath(absolutePath)}`], { allowFailure: true });
    if (result.code === 0) blobs.set(absolutePath, result.stdout);
  }
  return blobs;
}
