import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePruneCutoff, registerPruneRewindCommand, summarizePrune } from "../src/commands/prune-rewind.js";
import { pruneHistory } from "../src/history/prune.js";
import {
  captureBaseBlobs,
  getTransaction,
  historyRepoPath,
  listTrackedFiles,
  listVersions,
  recordTransaction,
  toRepoPath,
} from "../src/history/store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-prune-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Each case gets its own bare history repo: pruning is a whole-store operation.
  const home = mkdtempSync(join(tmpdir(), "pi-wayfinder-prune-home-"));
  tempDirs.push(home);
  process.env.PI_WAYFINDER_HOME = home;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runGit(args: string[], input?: string): string {
  const result = spawnSync("git", ["--git-dir", historyRepoPath(), ...args], { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function tryGit(args: string[]): number | null {
  const result = spawnSync("git", ["--git-dir", historyRepoPath(), ...args], { encoding: "utf8" });
  return result.status === 0 ? null : result.status;
}

interface RecordedFile {
  path: string;
  before: string;
  after: string;
}

async function recordFiles(cwd: string, files: RecordedFile[]): Promise<string> {
  const baseBlobs = await captureBaseBlobs(files.map((file) => file.path));
  const id = await recordTransaction({
    cwd,
    kind: "edit",
    headline: `test transaction for ${files.map((file) => file.path.slice(cwd.length + 1)).join(", ")}`,
    session: { id: "session-1", dir: "/sessions", file: "/sessions/s.jsonl" },
    files: files.map((file) => ({
      absolutePath: file.path,
      displayPath: file.path.slice(cwd.length + 1),
      before: Buffer.from(file.before),
      after: Buffer.from(file.after),
      mode: 0o644,
      baseBlob: baseBlobs.get(file.path) ?? null,
    })),
  });
  if (!id) throw new Error("history is unavailable in this test");
  return id;
}

interface Setup {
  cwd: string;
  a: string;
  b: string;
}

async function setup(): Promise<Setup> {
  const cwd = await createTempDir();
  const a = join(cwd, "a.ts");
  const b = join(cwd, "b.ts");
  await writeFile(a, "export const a = 1;\n", "utf8");
  await writeFile(b, "export const b = 1;\n", "utf8");
  // One transaction touching both files, then a second version of a.ts only.
  await recordFiles(cwd, [
    { path: a, before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: b, before: "export const b = 1;\n", after: "export const b = 2;\n" },
  ]);
  await recordFiles(cwd, [{ path: a, before: "export const a = 2;\n", after: "export const a = 3;\n" }]);
  await writeFile(a, "export const a = 3;\n", "utf8");
  await writeFile(b, "export const b = 2;\n", "utf8");
  return { cwd, a, b };
}

describe("prune history", () => {
  it("drops records for files that no longer exist and keeps the rest", async () => {
    const { cwd, a, b } = await setup();
    await unlink(b);

    const report = await pruneHistory();

    expect(report.commitsBefore).toBe(2);
    expect(report.commitsAfter).toBe(2);
    expect(report.prunedEntries).toBe(1);
    expect(report.missingPaths).toEqual([b]);
    expect(report.headAfter).not.toBe(report.headBefore);

    // The surviving file still has both versions and a working pre-image.
    expect(await listVersions(a)).toHaveLength(2);
    const commits = runGit(["rev-list", "--reverse", report.headAfter as string]).trim().split("\n");
    expect(commits).toHaveLength(2);
    const oldest = await getTransaction(commits[0], cwd);
    expect(oldest?.files.map((file) => file.displayPath)).toEqual(["a.ts"]);
    expect(oldest?.files[0].before?.toString("utf8")).toBe("export const a = 1;\n");
    const manifests = runGit(["log", "--format=%B", report.headAfter as string])
      .split("\n")
      .filter((line) => line.startsWith("manifest: "));
    expect(manifests).toHaveLength(2);
    expect(manifests.join("\n")).not.toContain("b.ts");
    expect(tryGit(["cat-file", "-e", `${report.headAfter}:${toRepoPath(b)}`])).not.toBeNull();
    expect(await readFile(a, "utf8")).toBe("export const a = 3;\n");
  });

  it("keeps the clean prefix of the chain", async () => {
    const cwd = await createTempDir();
    const a = join(cwd, "a.ts");
    const b = join(cwd, "b.ts");
    await writeFile(a, "a2\n", "utf8");
    await writeFile(b, "b2\n", "utf8");
    await recordFiles(cwd, [{ path: a, before: "a1\n", after: "a2\n" }]);
    await recordFiles(cwd, [
      { path: a, before: "a2\n", after: "a3\n" },
      { path: b, before: "b1\n", after: "b2\n" },
    ]);
    await unlink(b);

    const report = await pruneHistory();

    expect(report.commitsAfter).toBe(2);
    const log = runGit(["log", "--format=%s", report.headAfter as string]).trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[1]).toBe("test transaction for a.ts");
    expect(await listVersions(a)).toHaveLength(2);
  });

  it("drops a transaction whose files are all gone", async () => {
    const cwd = await createTempDir();
    const b = join(cwd, "b.ts");
    const a = join(cwd, "a.ts");
    await writeFile(b, "b\n", "utf8");
    await writeFile(a, "a\n", "utf8");
    await recordFiles(cwd, [{ path: b, before: "b\n", after: "b2\n" }]);
    await recordFiles(cwd, [{ path: a, before: "a\n", after: "a2\n" }]);
    await unlink(b);

    const report = await pruneHistory();

    expect(report.commitsBefore).toBe(2);
    expect(report.commitsAfter).toBe(1);
    expect(report.droppedEmpty).toBe(1);
    expect(runGit(["rev-list", report.headAfter as string]).trim().split("\n")).toHaveLength(1);
    expect(await listTrackedFiles(cwd)).toHaveLength(1);
  });

  it("drops transactions older than the cutoff and can empty the history", async () => {
    const { cwd } = await setup();

    const report = await pruneHistory({ olderThan: Date.now() + 60_000 });

    expect(report.droppedByAge).toBe(2);
    expect(report.commitsAfter).toBe(0);
    expect(report.headAfter).toBeNull();
    expect(await listTrackedFiles(cwd)).toHaveLength(0);
    expect(tryGit(["rev-parse", "--verify", "-q", "refs/heads/main"])).not.toBeNull();
  });

  it("does nothing when every file exists and no cutoff is given", async () => {
    const { a } = await setup();
    const head = runGit(["rev-parse", "refs/heads/main"]).trim();

    const report = await pruneHistory();

    expect(report.rewritten).toBe(0);
    expect(report.prunedEntries).toBe(0);
    expect(report.headBefore).toBe(head);
    expect(report.headAfter).toBe(head);
    expect(await listVersions(a)).toHaveLength(2);
  });

  it("reports a dry run without touching the branch", async () => {
    const { a, b } = await setup();
    await unlink(b);
    const head = runGit(["rev-parse", "refs/heads/main"]).trim();

    const report = await pruneHistory({ dryRun: true });

    expect(report.prunedEntries).toBe(1);
    expect(report.rewritten).toBe(2);
    expect(runGit(["rev-parse", "refs/heads/main"]).trim()).toBe(head);
    expect(await listVersions(a)).toHaveLength(2);

    const real = await pruneHistory();
    expect(real.rewritten).toBe(report.rewritten);
  });

  it("summarizes what it removed", async () => {
    const { b } = await setup();
    await unlink(b);

    const text = summarizePrune(await pruneHistory());

    expect(text).toContain("2 → 2 transactions");
    expect(text).toContain("1 missing files scrubbed");
    expect(text).toContain("Head ");
  });
});

describe("prune cutoff parsing", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("reads durations, dates and 'all'", () => {
    expect(parsePruneCutoff("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parsePruneCutoff("12h", now)).toBe(now - 12 * 3_600_000);
    expect(parsePruneCutoff("30m", now)).toBe(now - 30 * 60_000);
    expect(parsePruneCutoff("2w", now)).toBe(now - 14 * 86_400_000);
    expect(parsePruneCutoff("2026-10-01", now)).toBe(Date.parse("2026-10-01"));
    expect(parsePruneCutoff("all", now)).toBe(now);
    expect(parsePruneCutoff("  ", now)).toBeUndefined();
  });

  it("rejects nonsense", () => {
    expect(() => parsePruneCutoff("soon", now)).toThrow(/cannot read 'soon'/);
    expect(() => parsePruneCutoff("7 days", now)).toThrow(/cannot read/);
  });
});

describe("/prune-rewind command", () => {
  it("registers, refuses without a UI, and asks before touching anything", async () => {
    const { b } = await setup();
    await unlink(b);
    const head = runGit(["rev-parse", "refs/heads/main"]).trim();

    let command: { name?: string; handler?: (args: string, ctx: unknown) => Promise<void> } | undefined;
    registerPruneRewindCommand({
      registerCommand: (name: string, definition: Record<string, unknown>) => {
        command = { name, handler: definition.handler as never };
      },
    } as never);
    expect(command?.name).toBe("prune-rewind");

    const headless = { hasUI: false, ui: { notify: vi.fn() } };
    await command?.handler?.("", headless);
    expect(headless.ui.notify).toHaveBeenCalledWith("Pruning file history needs interactive mode.", "error");

    const declined = { hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn(async () => false) } };
    await command?.handler?.("", declined);
    expect(declined.ui.confirm).toHaveBeenCalledTimes(1);
    expect(String(declined.ui.confirm.mock.calls[0][1])).toContain("This cannot be undone.");
    expect(declined.ui.notify).toHaveBeenCalledWith("Pruning cancelled.", "info");
    expect(runGit(["rev-parse", "refs/heads/main"]).trim()).toBe(head);

    const accepted = { hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn(async () => true) } };
    await command?.handler?.("", accepted);
    expect(String(accepted.ui.notify.mock.calls.at(-1)?.[0])).toMatch(/^Pruned: /);
    expect(runGit(["rev-parse", "refs/heads/main"]).trim()).not.toBe(head);
  });
});
