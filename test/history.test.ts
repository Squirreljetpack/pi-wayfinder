import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEditTool } from "../src/edit/tool.js";
import { appendTransaction, getTransaction, historyDbPath, resetHistoryConnection } from "../src/history/db.js";
import { registerRollbackTool } from "../src/history/rollback.js";

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

function rollbackTool(): RegisteredTool {
  return collect((pi) => registerRollbackTool(pi as ExtensionAPI));
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

beforeEach(async () => {
  historyHome = await createTempDir();
  process.env.PI_WAYFINDER_HOME = historyHome;
  resetHistoryConnection();
});

afterEach(async () => {
  resetHistoryConnection();
  delete process.env.PI_WAYFINDER_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("history store", () => {
  it("records a transaction with its pre-edit bytes and reads it back", async () => {
    const id = await appendTransaction({
      cwd: "/repo",
      kind: "edit",
      summary: "test",
      changes: [{ path: "src/a.ts", absolutePath: "/repo/src/a.ts", before: Buffer.from("old\n"), afterSha: "abc" }],
    });

    expect(id).not.toBeNull();
    const transaction = await getTransaction(id as string, "/repo");
    expect(transaction?.changes).toHaveLength(1);
    expect(transaction?.changes[0].path).toBe("src/a.ts");
    expect(transaction?.changes[0].before.toString()).toBe("old\n");
    expect(historyDbPath()).toBe(join(historyHome, "history.db"));
  });

  it("resolves 'last' per repository", async () => {
    await appendTransaction({ cwd: "/repo-a", kind: "edit", summary: "a", changes: [] });
    const b = await appendTransaction({ cwd: "/repo-b", kind: "edit", summary: "b", changes: [] });

    expect((await getTransaction("last", "/repo-b"))?.id).toBe(b);
    expect((await getTransaction("last", "/repo-a"))?.id).not.toBe(b);
    expect(await getTransaction("missing-id", "/repo-b")).toBeNull();
  });
});

describe("edit transaction logging", () => {
  it("returns a transaction id and records the pre-edit bytes", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");

    const result = await editTool().execute(
      "call-1",
      { edits: [{ path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 2;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    const transactionId = (result.details as { transactionId: string }).transactionId;
    expect(transactionId).toMatch(/^[0-9a-z]+-[0-9a-f]{6}$/);
    expect(textOf(result)).toContain(`Transaction ${transactionId} — undo with rollback`);

    const transaction = await getTransaction(transactionId, cwd);
    expect(transaction?.changes[0].before.toString()).toBe("const a = 1;\n");
    expect(transaction?.changes[0].afterSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still edits when the history database cannot be opened", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");

    // A file where the database directory should be makes open() fail.
    await writeFile(join(historyHome, "blocked"), "", "utf8");
    process.env.PI_WAYFINDER_HOME = join(historyHome, "blocked");
    resetHistoryConnection();

    const result = await editTool().execute(
      "call-2",
      { edits: [{ path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 2;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(join(cwd, "a.ts"), "utf8")).resolves.toBe("const a = 2;\n");
    expect((result.details as { transactionId: string | null }).transactionId).toBeNull();
    expect(textOf(result)).toContain("History unavailable");
  });
});

describe("rollback tool", () => {
  async function editOnce(cwd: string, before: string, after: string): Promise<string> {
    const result = await editTool().execute(
      "call-edit",
      { edits: [{ path: "a.ts", mode: "exact", old: before, new: after }] },
      undefined,
      undefined,
      { cwd } as never,
    );
    return (result.details as { transactionId: string }).transactionId;
  }

  it("restores the exact bytes a transaction replaced", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "before\r\nline\r\n", "utf8");

    const transactionId = await editOnce(cwd, "line", "changed");
    await expect(readFile(filePath, "utf8")).resolves.toBe("before\r\nchanged\r\n");

    const result = await rollbackTool().execute("call-rb", { transaction_id: transactionId }, undefined, undefined, { cwd } as never);

    await expect(readFile(filePath, "utf8")).resolves.toBe("before\r\nline\r\n");
    expect(textOf(result)).toContain(`Restored 1 file from transaction ${transactionId}.`);
  });

  it("targets the last transaction with transaction_id: \"last\"", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "one\n", "utf8");
    await editOnce(cwd, "one", "two");

    await rollbackTool().execute("call-rb", { transaction_id: "last" }, undefined, undefined, { cwd } as never);
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\n");
  });

  it("records the rollback as its own transaction so it can be undone", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "one\n", "utf8");
    const transactionId = await editOnce(cwd, "one", "two");

    const rolledBack = await rollbackTool().execute("call-rb", { transaction_id: transactionId }, undefined, undefined, { cwd } as never);
    const undoId = (rolledBack.details as { transactionId: string }).transactionId;
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\n");

    await rollbackTool().execute("call-undo", { transaction_id: undoId }, undefined, undefined, { cwd } as never);
    await expect(readFile(filePath, "utf8")).resolves.toBe("two\n");
  });

  it("refuses to roll back a file that changed afterwards, unless forced", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "one\n", "utf8");
    const transactionId = await editOnce(cwd, "one", "two");
    await writeFile(filePath, "hand edited\n", "utf8");

    const refusal = rollbackTool().execute("call-rb", { transaction_id: transactionId }, undefined, undefined, { cwd } as never);
    await expect(refusal).rejects.toThrow(/changed after transaction .*, refusing to roll back/);
    await expect(readFile(filePath, "utf8")).resolves.toBe("hand edited\n");

    await rollbackTool().execute("call-force", { transaction_id: transactionId, force: true }, undefined, undefined, { cwd } as never);
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\n");
  });

  it("lists recent transaction ids when the id is unknown", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "one\n", "utf8");
    const transactionId = await editOnce(cwd, "one", "two");

    const call = rollbackTool().execute("call-rb", { transaction_id: "nope" }, undefined, undefined, { cwd } as never);
    await expect(call).rejects.toThrow(new RegExp(`Transaction nope not found\\.\\nRecent transactions in this repository: ${transactionId}`));
  });

  it("rejects a missing transaction_id", async () => {
    const cwd = await createTempDir();
    await expect(rollbackTool().execute("call-rb", {}, undefined, undefined, { cwd } as never)).rejects.toThrow(
      "Missing required parameter: transaction_id",
    );
  });
});

describe("rollback edge cases", () => {
  it("treats a deleted file as drift and can recreate it when forced", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "one\n", "utf8");

    const edited = await editTool().execute(
      "call-edit",
      { edits: [{ path: "a.ts", mode: "exact", old: "one", new: "two" }] },
      undefined,
      undefined,
      { cwd } as never,
    );
    const transactionId = (edited.details as { transactionId: string }).transactionId;
    await rm(filePath);

    await expect(
      rollbackTool().execute("call-rb", { transaction_id: transactionId }, undefined, undefined, { cwd } as never),
    ).rejects.toThrow(/a\.ts: missing/);

    await rollbackTool().execute("call-force", { transaction_id: transactionId, force: true }, undefined, undefined, {
      cwd,
    } as never);
    await expect(readFile(filePath, "utf8")).resolves.toBe("one\n");
  });
});
