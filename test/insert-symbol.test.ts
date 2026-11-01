import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyResolvedSymbolInsertions,
  groupInsertionsByPath,
  insertionText,
  registerInsertSymbolTool,
  type ResolvedSymbolInsertion,
  type SymbolInsertion,
} from "../src/tools/insert-symbol.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-insert-symbol-"));
  tempDirs.push(dir);
  return dir;
}

function registerToolForTest(): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
  };

  registerInsertSymbolTool(pi as unknown as ExtensionAPI);

  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("insert_symbol");
  return registeredTool as RegisteredTool;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("insert_symbol pure helpers", () => {
  it("builds before text with a trailing line ending", () => {
    const insertion: SymbolInsertion = { path: "a.ts", symbol: "target", position: "before", text: "export function helper() {\n  return 1;\n}" };
    expect(insertionText(insertion, "\n")).toBe("export function helper() {\n  return 1;\n}\n");
  });

  it("builds after text with a leading line ending and strips trailing whitespace", () => {
    const insertion: SymbolInsertion = { path: "a.ts", symbol: "target", position: "after", text: "export function helper() {}\n\n" };
    expect(insertionText(insertion, "\n")).toBe("\nexport function helper() {}");
  });

  it("strips line numbers and normalizes EOL to the target", () => {
    const insertion: SymbolInsertion = { path: "a.ts", symbol: "target", position: "before", text: "1│export function helper() {\r\n2│}\r\n" };
    expect(insertionText(insertion, "\n")).toBe("export function helper() {\n}\n");
  });

  it("applies before insertions at the symbol line start", () => {
    const content = "export function target() {\n  return 1;\n}\n";
    const resolved: ResolvedSymbolInsertion[] = [
      {
        insertion: { path: "a.ts", symbol: "target", position: "before", text: "export function helper() {}" },
        range: { startIndex: 0, endIndex: content.length - 1, startLine: 0, nameText: "target" },
      },
    ];
    expect(applyResolvedSymbolInsertions(content, resolved, "\n")).toBe(
      "export function helper() {}\nexport function target() {\n  return 1;\n}\n",
    );
  });

  it("applies after insertions at the symbol end and keeps bottom-to-top order", () => {
    const content = [
      "export function first() {",
      "  return 1;",
      "}",
      "",
      "export function second() {",
      "  return 2;",
      "}",
    ].join("\n");
    const firstStart = content.indexOf("export function first");
    const firstEnd = content.indexOf("\n\nexport function second");
    const secondStart = content.indexOf("export function second");
    const secondEnd = content.length;
    const resolved: ResolvedSymbolInsertion[] = [
      {
        insertion: { path: "a.ts", symbol: "first", position: "after", text: "export function between() {}" },
        range: { startIndex: firstStart, endIndex: firstEnd, startLine: 0, nameText: "first" },
      },
      {
        insertion: { path: "a.ts", symbol: "second", position: "before", text: "export function intro() {}" },
        range: { startIndex: secondStart, endIndex: secondEnd, startLine: 4, nameText: "second" },
      },
    ];
    expect(applyResolvedSymbolInsertions(content, resolved, "\n")).toBe([
      "export function first() {",
      "  return 1;",
      "}",
      "export function between() {}",
      "",
      "export function intro() {}",
      "export function second() {",
      "  return 2;",
      "}",
    ].join("\n"));
  });

  it("groups insertions by resolved absolute path while preserving display paths", () => {
    const cwd = "/tmp/project";
    const insertions: SymbolInsertion[] = [
      { path: "@src/a.ts", symbol: "a", position: "before", text: "x" },
      { path: "src/a.ts", symbol: "b", position: "after", text: "y" },
      { path: "src/b.ts", symbol: "c", position: "before", text: "z" },
    ];
    const batches = groupInsertionsByPath(insertions, cwd);
    expect(batches.map((batch) => batch.displayPath)).toEqual(["@src/a.ts", "src/b.ts"]);
    expect(batches.map((batch) => batch.insertions.map((insertion) => insertion.symbol))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("insert_symbol tool", () => {
  it("inserts before a TypeScript top-level function with its doc comment", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "/** Greets a user. */",
      "export function greet(name: string) {",
      "  return `hello ${name}`;",
      "}",
      "",
      "export const untouched = 1;",
    ].join("\n"), "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-1",
      {
        insertions: [
          {
            path: "sample.ts",
            symbol: "greet",
            position: "before",
            text: "export function shout(name: string) {\n  return name.toUpperCase();\n}",
          },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe([
      "export function shout(name: string) {",
      "  return name.toUpperCase();",
      "}",
      "/** Greets a user. */",
      "export function greet(name: string) {",
      "  return `hello ${name}`;",
      "}",
      "",
      "export const untouched = 1;",
    ].join("\n"));
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Successfully inserted 1 insertion adjacent to 'greet' (before) in sample.ts.",
    );
    expect(result.details).toMatchObject({ paths: ["sample.ts"], symbols: ["greet"] });
  });

  it("inserts after a class method by suffix", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
    ].join("\n"), "utf8");

    const tool = registerToolForTest();
    await tool.execute(
      "call-2",
      {
        insertions: [
          {
            path: "sample.ts",
            symbol: "run",
            type: "method",
            position: "after",
            text: "  stop() {\n    return 2;\n  }",
          },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe([
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "  stop() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n"));
  });

  it("applies a batch of insertions across two files in one call", async () => {
    const cwd = await createTempDir();
    const aPath = join(cwd, "a.ts");
    const bPath = join(cwd, "b.ts");
    await writeFile(aPath, "export function alpha() {}\n", "utf8");
    await writeFile(bPath, "export function beta() {}\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-3",
      {
        insertions: [
          { path: "a.ts", symbol: "alpha", position: "before", text: "export function preAlpha() {}" },
          { path: "b.ts", symbol: "beta", position: "after", text: "export function postBeta() {}" },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(aPath, "utf8")).resolves.toBe("export function preAlpha() {}\nexport function alpha() {}\n");
    await expect(readFile(bPath, "utf8")).resolves.toBe("export function beta() {}\nexport function postBeta() {}\n");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("adjacent to 'alpha' (before)");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("adjacent to 'beta' (after)");
  });

  it("reports a missing symbol without modifying the file", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "export function greet() {}\n", "utf8");

    const tool = registerToolForTest();
    await expect(
      tool.execute(
        "call-4",
        { insertions: [{ path: "sample.ts", symbol: "nope", position: "before", text: "export function x() {}" }] },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow(/Symbol 'nope' not found in sample\.ts/);
    await expect(readFile(filePath, "utf8")).resolves.toBe("export function greet() {}\n");
  });

  it("rejects an invalid position", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "export function greet() {}\n", "utf8");

    const tool = registerToolForTest();
    await expect(
      tool.execute(
        "call-5",
        { insertions: [{ path: "sample.ts", symbol: "greet", position: "sideways", text: "x" } as never] },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow(/Invalid position 'sideways' for symbol 'greet'/);
  });
});
