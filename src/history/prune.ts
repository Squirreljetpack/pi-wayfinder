import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_BRANCH,
  ensureRepo,
  fromRepoPath,
  git,
  historyRepoPath,
  literal,
  preimagePath,
  text,
} from "./store.js";

/** One file a transaction recorded, as it appears in the commit message manifest. */
interface ManifestEntry {
  path: string;
  summary: string;
}

interface CommitRecord {
  id: string;
  tree: string;
  authorDate: string;
  committerDate: string;
  createdAt: number;
  message: string;
  entries: ManifestEntry[];
  /** A commit whose message carries no manifest (older format): kept as-is, never rewritten. */
  opaque: boolean;
}

export interface PruneOptions {
  /** Drop records for paths that no longer exist on this machine. Default true. */
  missing?: boolean;
  /** Drop transactions created before this epoch-ms. */
  olderThan?: number;
  /** Compute the report without rewriting anything. */
  dryRun?: boolean;
}

export interface PruneReport {
  commitsBefore: number;
  commitsAfter: number;
  rewritten: number;
  droppedByAge: number;
  droppedEmpty: number;
  prunedEntries: number;
  /** Absolute paths whose records were dropped because the file is gone. */
  missingPaths: string[];
  headBefore: string | null;
  headAfter: string | null;
  reclaimedBytes: number;
}

const EMPTY_REPORT: PruneReport = {
  commitsBefore: 0,
  commitsAfter: 0,
  rewritten: 0,
  droppedByAge: 0,
  droppedEmpty: 0,
  prunedEntries: 0,
  missingPaths: [],
  headBefore: null,
  headAfter: null,
  reclaimedBytes: 0,
};

/**
 * Rebuilds the history branch without records for deleted files and, optionally, without
 * transactions older than a cutoff.
 *
 * Every surviving commit is re-created from the same blobs with the same message, dates and parent
 * order, so the log still reads oldest to newest; only the dropped entries disappear from the trees
 * and the `manifest:` line. Rewriting a commit changes its id (the parent changed), so ids quoted in
 * older transcripts stop resolving - the transaction log is not append-only by design.
 *
 * After the branch moves, the old commits are unreachable and a `git gc --prune=now` reclaims them.
 */
export async function pruneHistory(options: PruneOptions = {}): Promise<PruneReport> {
  const repo = historyRepoPath();
  await ensureRepo(repo);
  const sizeBefore = await repoSizeKb(repo);

  for (let attempt = 0; attempt < 3; attempt++) {
    const headBefore = await headOf(repo);
    if (!headBefore) return EMPTY_REPORT;

    const commits = await readCommits(repo);
    const missing = new Set<string>();
    const removed = new Set<string>();
    for (const commit of commits) {
      for (const entry of commit.entries) {
        if (options.missing === false || existsSync(fromRepoPath(entry.path))) continue;
        missing.add(entry.path);
        removed.add(entry.path);
      }
    }

    const plans = commits.map((commit) => {
      const droppedByAge = options.olderThan !== undefined && commit.createdAt < options.olderThan;
      const kept = commit.entries.filter((entry) => !removed.has(entry.path));
      const droppedEmpty = !droppedByAge && !commit.opaque && commit.entries.length > 0 && kept.length === 0;
      return { commit, kept, droppedByAge, droppedEmpty };
    });

    const firstDirty = plans.findIndex(
      (plan) => plan.droppedByAge || plan.droppedEmpty || plan.kept.length !== plan.commit.entries.length,
    );
    const droppedByAge = plans.filter((plan) => plan.droppedByAge).length;
    const droppedEmpty = plans.filter((plan) => plan.droppedEmpty).length;
    const prunedEntries = plans.reduce((sum, plan) => sum + (plan.commit.entries.length - plan.kept.length), 0);
    const base = {
      commitsBefore: commits.length,
      commitsAfter: commits.length - droppedByAge - droppedEmpty,
      droppedByAge,
      droppedEmpty,
      prunedEntries,
      missingPaths: Array.from(missing).map(fromRepoPath).sort(),
      headBefore,
    };

    if (firstDirty === -1) {
      return { ...EMPTY_REPORT, ...base, headAfter: headBefore };
    }

    if (options.dryRun) {
      const kept = plans
        .slice(firstDirty)
        .filter((plan) => !plan.droppedByAge && !plan.droppedEmpty).length;
      return { ...EMPTY_REPORT, ...base, rewritten: kept, headAfter: headBefore };
    }

    // Everything before the first dirty commit is untouched, so it anchors the rewritten chain.
    const prefix = firstDirty === 0 ? null : { id: commits[firstDirty - 1].id, tree: commits[firstDirty - 1].tree };
    const rewritten = await rewriteFrom(repo, plans.slice(firstDirty), prefix);
    const moved = await moveBranch(repo, rewritten.head, headBefore);
    if (!moved) continue;

    await git(repo, ["reflog", "expire", "--expire=now", "--all"], { allowFailure: true });
    await git(repo, ["gc", "--prune=now", "--quiet"], { allowFailure: true });
    const sizeAfter = await repoSizeKb(repo);

    return {
      ...EMPTY_REPORT,
      ...base,
      rewritten: rewritten.count,
      headAfter: rewritten.head,
      reclaimedBytes: Math.max(0, sizeBefore - sizeAfter) * 1024,
    };
  }

  throw new Error("the file history repository is busy: another transaction kept advancing it; retry the prune");
}

async function headOf(repo: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", "--verify", "-q", HISTORY_BRANCH], { allowFailure: true });
  const head = text(result).trim();
  return result.code === 0 && head.length > 0 ? head : null;
}

async function readCommits(repo: string): Promise<CommitRecord[]> {
  const format = "%H%x1f%T%x1f%aI%x1f%cI%x1f%ct%x1f%B%x1e";
  const raw = text(await git(repo, ["log", "--reverse", `--format=${format}`, HISTORY_BRANCH]));

  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [id, tree, authorDate, committerDate, createdAt, message = ""] = record.split("\x1f");
      const entries = parseManifest(message);
      return {
        id,
        tree,
        authorDate,
        committerDate,
        createdAt: Number(createdAt) * 1000,
        message: message.replace(/\n$/, ""),
        entries,
        opaque: entries.length === 0 && !message.includes("manifest: "),
      };
    });
}

function parseManifest(message: string): ManifestEntry[] {
  const line = message.split("\n").find((candidate) => candidate.startsWith("manifest: "));
  if (!line) return [];
  try {
    const parsed = JSON.parse(line.slice("manifest: ".length)) as Array<{ path?: unknown; summary?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry?.path === "string" && String(entry.path).length > 0)
      .map((entry) => ({ path: String(entry.path), summary: String(entry.summary ?? "") }));
  } catch {
    return [];
  }
}

/** Re-creates commits oldest to newest, keeping only each commit's surviving entries. */
async function rewriteFrom(
  repo: string,
  plans: Array<{ commit: CommitRecord; kept: ManifestEntry[]; droppedByAge: boolean; droppedEmpty: boolean }>,
  base: { id: string; tree: string } | null,
): Promise<{ head: string | null; count: number }> {
  const indexDir = await mkdtemp(join(tmpdir(), "pi-wayfinder-prune-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  let parentTree: string | null = base?.tree ?? null;
  let parentId: string | null = base?.id ?? null;
  let count = 0;

  try {
    for (const plan of plans) {
      if (plan.droppedByAge || plan.droppedEmpty) continue;
      const { commit, kept } = plan;

      await git(repo, parentTree ? ["read-tree", parentTree] : ["read-tree", "--empty"], { env });

      const removedEntries = commit.entries.filter(
        (entry) => !kept.some((candidate) => candidate.path === entry.path),
      );
      const paths = [
        ...removedEntries.flatMap((entry) => [literal(entry.path), literal(preimagePath(entry.path))]),
        ...kept.flatMap((entry) => [literal(entry.path), literal(preimagePath(entry.path))]),
      ];
      const listing = await git(repo, ["ls-tree", commit.id, "--", ...paths], { env, allowFailure: true });
      const blobs = parseTreeListing(text(listing));
      const present = kept.filter((entry) => blobs.has(entry.path));

      // update-index is plumbing: it takes plain repo-relative paths, so a `--` separator only works
      // in a call that carries nothing else.
      if (removedEntries.length > 0) {
        await git(
          repo,
          ["update-index", "--force-remove", "--", ...removedEntries.flatMap((entry) => [entry.path, preimagePath(entry.path)])],
          { env, allowFailure: true },
        );
      }
      if (present.length > 0) {
        const args = ["update-index", "--add"];
        for (const entry of present) {
          const after = blobs.get(entry.path);
          if (after) args.push("--cacheinfo", `${after.mode},${after.blob},${entry.path}`);
          const before = blobs.get(preimagePath(entry.path));
          if (before) args.push("--cacheinfo", `${before.mode},${before.blob},${preimagePath(entry.path)}`);
        }
        await git(repo, args, { env });
      }

      parentTree = text(await git(repo, ["write-tree"], { env })).trim();
      const message = rewriteMessage(commit.message, present);
      const commitArgs: string[] = [
        "commit-tree",
        parentTree,
        ...(parentId ? ["-p", parentId] : []),
        "-F",
        "-",
      ];
      parentId = text(
        await git(repo, commitArgs, {
          input: message,
          env: { ...env, GIT_AUTHOR_DATE: commit.authorDate, GIT_COMMITTER_DATE: commit.committerDate },
        }),
      ).trim();
      count++;
    }
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }

  return { head: parentId, count };
}

function parseTreeListing(listing: string): Map<string, { mode: string; blob: string }> {
  const entries = new Map<string, { mode: string; blob: string }>();
  for (const line of listing.split("\n")) {
    const match = /^(\d{6}) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) entries.set(match[3], { mode: match[1], blob: match[2] });
  }
  return entries;
}

function rewriteMessage(message: string, entries: ManifestEntry[]): string {
  const lines = message.replace(/\n+$/, "").split("\n");
  const subject = lines[0] ?? "";
  const filesIndex = lines.indexOf("files:");
  const middle = (filesIndex >= 0 ? lines.slice(1, filesIndex) : lines.slice(1)).filter(
    (line) => !line.startsWith("manifest: "),
  );
  while (middle[0] === "") middle.shift();

  const result = [subject, "", `manifest: ${JSON.stringify(entries)}`, ...middle, "files:"];
  for (const entry of entries) result.push(`  ${entry.path}${entry.summary ? ` (${entry.summary})` : ""}`);
  return `${result.join("\n")}\n`;
}

async function moveBranch(repo: string, newHead: string | null, oldHead: string): Promise<boolean> {
  const args = newHead
    ? ["update-ref", HISTORY_BRANCH, newHead, oldHead]
    : ["update-ref", "-d", HISTORY_BRANCH, oldHead];
  const result = await git(repo, args, { allowFailure: true });
  return result.code === 0;
}

/** Loose plus packed object size in KB, from `git count-objects -v`. */
async function repoSizeKb(repo: string): Promise<number> {
  const result = await git(repo, ["count-objects", "-v"], { allowFailure: true });
  let total = 0;
  for (const line of text(result).split("\n")) {
    const match = /^(size|size-pack): (\d+)$/.exec(line.trim());
    if (match) total += Number(match[2]);
  }
  return total;
}
