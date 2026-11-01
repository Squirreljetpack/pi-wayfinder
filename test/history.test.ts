import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit/tool.js";
import {
  captureBaseBlobs,
  getTransaction,
  historyRepoPath,
  listTrackedFiles,
  listVersions,
  recordTransaction,
  resolveTransactionId,
  toRepoPath,
} from "../src/history/store.js";
import { registerInsertSymbolTool } from "../src/tools/insert-symbol.js";
import { registerRenameSymbolTool } from "../src/tools/rename-symbol.js";
import { registerReplaceSymbolTool } from "../src/tools/replace-symbol.js";
import { registerRewindTool } from "../src/tools/rewind.js";
import { SymbolCache } from "../src/symbols/symbol-cache.js";
import { SymbolScanner } from "../src/symbols/symbol-scanner.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];
let historyHome: string;

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-history-"));
  tempDirs.push(dir);
  return dir;
}

function collect(register: (pi: unknown) => void): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  register({ registerTool: (tool: RegisteredTool) => { registeredTool = tool; } });
  expect(registeredTool).toBeDefined();
  return registeredTool as RegisteredTool;
}

function editTool(): RegisteredTool {
  return collect((pi) => registerEditTool(pi as ExtensionAPI));
}

function rewindTool(): RegisteredTool {
  return collect((pi) => registerRewindTool(pi as ExtensionAPI));
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

function runGit(args: string[], input?: string): string {
  const result = spawnSync("git", ["--git-dir", historyRepoPath(), ...args], { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function editOnce(cwd: string, before: string, after: string, path = "a.ts"): Promise<string> {
  const result = await editTool().execute(
    "call-edit",
    { edits: [{ path, mode: "exact", old: before, new: after }] },
    undefined,
    undefined,
    { cwd } as never,
  );
  return (result.details as { transactionId: string }).transactionId;
}

async function rewind(cwd: string, params: Record<string, unknown>): Promise<Awaited<ReturnType<RegisteredTool["execute"]>>> {
  return rewindTool().execute("call-rewind", params, undefined, undefined, { cwd } as never);
}

async function record(cwd: string, absolutePath: string, before: string, after: string, baseBlob: string | null = null): Promise<string> {
  const id = await recordTransaction({
    cwd,
    kind: "edit",
    headline: "test transaction",
    session: { id: "session-1", dir: "/sessions", file: "/sessions/s.jsonl" },
    files: [
      {
        absolutePath,
        displayPath: absolutePath.slice(cwd.length + 1),
        before: Buffer.from(before),
        after: Buffer.from(after),
        mode: 0o644,
        baseBlob,
      },
    ],
  });
  expect(id).not.toBeNull();
  return id as string;
}

beforeEach(async () => {
  historyHome = await createTempDir();
  process.env.PI_WAYFINDER_HOME = historyHome;
});

afterEach(async () => {
  delete process.env.PI_WAYFINDER_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("git history store", () => {
  it("records a transaction and reads it back", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "src/a.ts");
    await record(cwd, path, "earliest\n", "old\n");
    const id = await record(cwd, path, "old\n", "new\n", runGit(["rev-parse", `main:${toRepoPath(path)}`]).trim());

    const transaction = await getTransaction(id, cwd);
    expect(transaction?.id).toBe(id);
    expect(transaction?.kind).toBe("edit");
    expect(transaction?.subject).toBe("test transaction");
    expect(transaction?.session).toEqual({ id: "session-1", dir: "/sessions", file: "/sessions/s.jsonl" });
    expect(transaction?.files.map((file) => file.displayPath)).toEqual(["src/a.ts"]);
    expect(transaction?.files[0].before?.toString()).toBe("old\n");
    expect(transaction?.files[0].after?.toString()).toBe("new\n");
    expect(historyRepoPath()).toBe(join(historyHome, "history.git"));
  });

  it("mirrors absolute paths under the repository root", async () => {
    const cwd = await createTempDir();
    const absolutePath = join(cwd, "nested/deep/a.ts");
    await record(cwd, absolutePath, "one\n", "two\n");

    expect(toRepoPath(absolutePath)).toBe(absolutePath.slice(1));
    const tree = runGit(["ls-tree", "-r", "--name-only", "main"]).trim().split("\n");
    expect(tree).toContain(absolutePath.slice(1));
    expect(tree).toContain(`.pi-wayfinder/${absolutePath.slice(1)}`);
  });

  it("writes the session id and directory into the commit message", async () => {
    const cwd = await createTempDir();
    const id = await record(cwd, join(cwd, "a.ts"), "one\n", "two\n");
    const message = runGit(["show", "-s", "--format=%B", id]);

    expect(message).toContain("session: session-1");
    expect(message).toContain("session-dir: /sessions");
    expect(message).toContain(`cwd: ${cwd}`);
    expect(message).toContain(`  ${join(cwd, "a.ts").slice(1)}`);
    expect(message).not.toContain("branch:");
  });

  it("records the project branch, including an unborn one", async () => {
    const cwd = await createTempDir();
    spawnSync("git", ["init", "--quiet", "-b", "trunk", cwd]);

    const id = await record(cwd, join(cwd, "a.ts"), "one\n", "two\n");

    expect(runGit(["show", "-s", "--format=%B", id])).toContain("branch: trunk");
  });

  it("stores the exact bytes, including a BOM and CRLF line endings", async () => {
    const cwd = await createTempDir();
    const id = await record(cwd, join(cwd, "a.ts"), "\uFEFFone\r\n", "\uFEFFtwo\r\n");
    const blob = runGit(["cat-file", "blob", `${id}:${toRepoPath(join(cwd, "a.ts"))}`]);

    expect(blob).toBe("\uFEFFtwo\r\n");
  });

  it("caps compression for loose objects and packs", async () => {
    const cwd = await createTempDir();
    await record(cwd, join(cwd, "a.ts"), "one\n", "two\n");

    expect(runGit(["config", "core.compression"]).trim()).toBe("9");
    expect(runGit(["config", "core.looseCompression"]).trim()).toBe("9");
    expect(runGit(["config", "pack.compression"]).trim()).toBe("9");
  });

  it("retries onto the new parent when another session commits concurrently", async () => {
    const cwd = await createTempDir();
    const first = join(cwd, "a.ts");
    const second = join(cwd, "b.ts");

    const ids = await Promise.all([
      record(cwd, first, "one\n", "two\n"),
      record(cwd, second, "alpha\n", "beta\n"),
    ]);

    const log = runGit(["log", "--format=%H", "main"]).trim().split("\n");
    expect(log).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Whichever commit landed last sits on top of the other, so both files survive in one tree.
    expect(runGit(["cat-file", "blob", `main:${toRepoPath(first)}`])).toBe("two\n");
    expect(runGit(["cat-file", "blob", `main:${toRepoPath(second)}`])).toBe("beta\n");
  });

  it("reports a conflict instead of overwriting a file another session committed", async () => {
    const cwd = await createTempDir();
    const absolutePath = join(cwd, "a.ts");
    const first = await record(cwd, absolutePath, "one\n", "two\n");
    const staleBase = runGit(["rev-parse", `${first}:${toRepoPath(absolutePath)}`]).trim();
    await record(cwd, absolutePath, "two\n", "three\n", staleBase);

    await expect(record(cwd, absolutePath, "two\n", "four\n", staleBase)).rejects.toThrow(
      /a\.ts was changed by another pi session since you read it/,
    );
    expect(runGit(["cat-file", "blob", `main:${toRepoPath(absolutePath)}`])).toBe("three\n");
  });

  it("captures the history blob a tool read before editing", async () => {
    const cwd = await createTempDir();
    const absolutePath = join(cwd, "a.ts");
    const id = await record(cwd, absolutePath, "one\n", "two\n");

    const [actual] = (await captureBaseBlobs([absolutePath])).values();
    expect(actual).toBe(runGit(["rev-parse", `${id}:${toRepoPath(absolutePath)}`]).trim());
  });

  it("resolves 'last' per working directory", async () => {
    const a = await createTempDir();
    const b = await createTempDir();
    await record(a, join(a, "a.ts"), "one\n", "two\n");
    const newestB = await record(b, join(b, "a.ts"), "one\n", "two\n");

    expect(await resolveTransactionId("last", b)).toBe(newestB);
    expect(await resolveTransactionId("last", a)).not.toBe(newestB);
    expect(await getTransaction("missing-id", b)).toBeNull();
  });
});

describe("edit transaction logging", () => {
  it("returns the history commit id and mentions how to undo it", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "const a = 1;\n", "utf8");

    const result = await editTool().execute(
      "call-1",
      { edits: [{ path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 2;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    const transactionId = (result.details as { transactionId: string }).transactionId;
    expect(transactionId).toMatch(/^[0-9a-f]{40}$/);
    expect(textOf(result)).toContain(`Transaction ${transactionId.slice(0, 12)} — undo with rewind({ id: "${transactionId.slice(0, 12)}", mode: "undo" })`);

    const transaction = await getTransaction(transactionId, cwd);
    expect(transaction?.files[0].before?.toString()).toBe("const a = 1;\n");
    expect(transaction?.files[0].after?.toString()).toBe("const a = 2;\n");
  });

  it("still edits when the history repository cannot be created", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "const a = 1;\n", "utf8");

    // A file where the repository directory should be makes the init fail.
    const blocked = join(historyHome, "blocked");
    await writeFile(blocked, "", "utf8");
    process.env.PI_WAYFINDER_HOME = blocked;

    const result = await editTool().execute(
      "call-2",
      { edits: [{ path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 2;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe("const a = 2;\n");
    expect((result.details as { transactionId: string | null }).transactionId).toBeNull();
    expect(textOf(result)).toContain("History unavailable");
  });
});

describe("rewind tool listings", () => {
  it("lists files with history, then the versions of one file", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n", "utf8");
    await editOnce(cwd, "one", "ONE");
    await editOnce(cwd, "three", "THREE");

    const files = textOf(await rewind(cwd, {}));
    expect(files).toContain("a.ts");
    expect(files).toContain("2 versions");

    const versions = textOf(await rewind(cwd, { path: "a.ts" }));
    expect(versions).toContain("Versions of a.ts (newest first)");
    expect(await listTrackedFiles(cwd)).toHaveLength(1);
    const entries = await listVersions(join(cwd, "a.ts"));
    expect(entries).toHaveLength(2);
    // The newest transaction changed one line; the oldest is where the file entered history.
    expect([entries[0].added, entries[0].deleted]).toEqual([1, 1]);
    expect(entries[1].added).toBeGreaterThan(1);
  });

  it("records a transaction for every symbol-level edit", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(
      filePath,
      "export function alpha() { return 1; }\nexport const caller = () => alpha();\n",
      "utf8",
    );
    const scanner = new SymbolScanner(new SymbolCache());
    const hint = /Transaction [0-9a-f]{12} — undo with rewind\(\{ id: "[0-9a-f]{12}", mode: "undo" \}\)/;

    const replaced = await collect((pi) => registerReplaceSymbolTool(pi as ExtensionAPI, scanner)).execute(
      "call-replace",
      { replacements: [{ path: "sample.ts", symbol: "alpha", text: "export function alpha() { return 2; }" }] },
      undefined,
      undefined,
      { cwd } as never,
    );
    const inserted = await collect((pi) => registerInsertSymbolTool(pi as ExtensionAPI)).execute(
      "call-insert",
      { insertions: [{ path: "sample.ts", symbol: "alpha", position: "after", text: "export const added = 3;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );
    const renamed = await collect((pi) => registerRenameSymbolTool(pi as ExtensionAPI, scanner)).execute(
      "call-rename",
      { paths: ["sample.ts"], existing_symbol: "caller", new_symbol: "consumer" },
      undefined,
      undefined,
      { cwd } as never,
    );

    for (const result of [replaced, inserted, renamed]) expect(textOf(result)).toMatch(hint);
    expect(await listVersions(filePath)).toHaveLength(3);
    expect((await listVersions(filePath))[0].subject).toContain("Renamed 'caller' to 'consumer'");
  });

  it("says so when nothing is recorded", async () => {
    const cwd = await createTempDir();
    expect(textOf(await rewind(cwd, {}))).toContain("No file history is recorded");
    expect(textOf(await rewind(cwd, { path: "missing.ts" }))).toContain("No recorded versions of missing.ts");
  });
});

describe("rewind tool history", () => {
  async function setup(): Promise<{ cwd: string; filePath: string; id: string }> {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "one\ntwo\nthree\nfour\nfive\n", "utf8");
    const id = await editOnce(cwd, "two", "TWO");
    return { cwd, filePath, id };
  }

  it("shows what the transaction changed", async () => {
    const { cwd, id } = await setup();
    const result = await rewind(cwd, { id, mode: "show" });
    const text = textOf(result);

    expect(text).toContain(`-2 two`);
    expect(text).toContain(`+2 TWO`);
  });

  it("previews the file as of the transaction", async () => {
    const { cwd, id } = await setup();
    const text = textOf(await rewind(cwd, { id, mode: "preview" }));

    expect(text).toContain("1│one");
    expect(text).toContain("2│TWO");
    expect(text).toContain("5│five");
  });

  it("undoes the change and records the undo", async () => {
    const { cwd, filePath, id } = await setup();
    const result = await rewind(cwd, { id, mode: "undo" });

    await expect(readFile(filePath, "utf8")).resolves.toBe("one\ntwo\nthree\nfour\nfive\n");
    const undoId = (result.details as { transactionId: string }).transactionId;
    expect(textOf(result)).toContain(`Reverted 1 file from ${id.slice(0, 8)}.`);
    expect((await getTransaction(undoId, cwd))?.kind).toBe("rewind");
  });

  it("keeps a later unrelated edit when undoing", async () => {
    const { cwd, filePath, id } = await setup();
    await writeFile(filePath, "one\nTWO\nthree\nfour\nFIVE\n", "utf8");

    await rewind(cwd, { id, mode: "undo" });

    await expect(readFile(filePath, "utf8")).resolves.toBe("one\ntwo\nthree\nfour\nFIVE\n");
  });

  it("refuses to undo when the changed lines moved on", async () => {
    const { cwd, filePath, id } = await setup();
    await writeFile(filePath, "one\nHAND\nthree\nfour\nfive\n", "utf8");

    await expect(rewind(cwd, { id, mode: "undo" })).rejects.toThrow(/changed since .* and the reverse patch no longer applies/);
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\nHAND\nthree\nfour\nfive\n");
  });

  it("restores the recorded version, discarding later edits", async () => {
    const { cwd, filePath, id } = await setup();
    await writeFile(filePath, "hand\nedited\n", "utf8");

    await rewind(cwd, { id, mode: "restore" });

    await expect(readFile(filePath, "utf8")).resolves.toBe("one\nTWO\nthree\nfour\nfive\n");
  });

  it("reverses a restore with undo", async () => {
    const { cwd, filePath, id } = await setup();
    await writeFile(filePath, "hand\n", "utf8");
    const restored = await rewind(cwd, { id, mode: "restore" });
    const restoreId = (restored.details as { transactionId: string }).transactionId;

    await rewind(cwd, { id: restoreId, mode: "undo" });

    await expect(readFile(filePath, "utf8")).resolves.toBe("hand\n");
  });

  it("rejects an unknown id and lists recent ones", async () => {
    const { cwd, id } = await setup();
    await expect(rewind(cwd, { id: "nope", mode: "undo" })).rejects.toThrow(
      new RegExp(`Transaction nope not found\\.\\nRecent transactions in this directory: ${id.slice(0, 7)}`),
    );
  });

  it("needs an id for the action modes", async () => {
    const cwd = await createTempDir();
    await expect(rewind(cwd, { mode: "undo" })).rejects.toThrow('mode "undo" needs an id; use "last" for the newest transaction');
  });

  it("targets the newest transaction with id: \"last\"", async () => {
    const { cwd, filePath } = await setup();
    await rewind(cwd, { id: "last", mode: "undo" });
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\ntwo\nthree\nfour\nfive\n");
  });
});
