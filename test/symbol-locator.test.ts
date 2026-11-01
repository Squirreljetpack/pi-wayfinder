import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolLocator } from "../src/ast/symbol-locator.js";

const tempDirs: string[] = [];
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-locator-"));
  tempDirs.push(dir);
  return dir;
}

describe("SymbolLocator", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns numbered skeleton lines from tree-sitter definitions", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "export class Service {",
      "  run() { return 1; }",
      "}",
      "export const helper = () => 2;"
    ].join("\n"), "utf8");

    const text = await SymbolLocator.getFileSkeleton(filePath, { lines: true });

    expect(text).toContain("|----");
    expect(text).toContain("1│export class Service {");
    expect(text).toContain("2│  run() { return 1; }");
    expect(text).toContain("4│export const helper = () => 2;");
  });

  it("omits line numbers unless they are asked for", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "export class Service {",
      "  run() { return 1; }",
      "}",
    ].join("\n"), "utf8");

    const skeleton = await SymbolLocator.getFileSkeleton(filePath);
    const functions = await SymbolLocator.getFunctions(filePath, "sample.ts", ["run"]);

    expect(skeleton).toContain("export class Service {");
    expect(skeleton).not.toContain("│");
    expect(functions?.formattedContent).toContain("  run() { return 1; }");
    expect(functions?.formattedContent).not.toContain("│");
  });

  it("extracts nested method implementations by suffix name", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "import { dep } from './dep';",
      "class Service {",
      "  private value = 1;",
      "  run() {",
      "    return dep(this.value);",
      "  }",
      "}"
    ].join("\n"), "utf8");

    const result = await SymbolLocator.getFunctions(filePath, "sample.ts", ["run"], { lines: true });

    expect(result?.foundNames).toEqual(["run"]);
    expect(result?.formattedContent).toContain("sample.ts::Service.run");
    expect(result?.formattedContent).toContain("4│  run() {");
    expect(result?.formattedContent).toContain("5│    return dep(this.value);");
    expect(result?.formattedContent).toContain("6│  }");
  });

  it("includes adjacent comments/decorators in extended ranges", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "/** Docs for helper */",
      "export function helper() {",
      "  return 1;",
      "}"
    ].join("\n"), "utf8");

    const result = await SymbolLocator.getFunctions(filePath, "sample.ts", ["helper"], { lines: true });

    expect(result?.formattedContent).toContain("1│/** Docs for helper */");
    expect(result?.formattedContent).toContain("2│export function helper() {");
  });

  it("does not include non-adjacent previous comments in function ranges", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "// Detached docs",
      "",
      "export function helper() {",
      "  return 1;",
      "}"
    ].join("\n"), "utf8");

    const result = await SymbolLocator.getFunctions(filePath, "sample.ts", ["helper"], { lines: true });

    expect(result?.formattedContent).not.toContain("1│// Detached docs");
    expect(result?.formattedContent).toContain("3│export function helper() {");
  });

  it("adds class property context only for this/self member usage and avoids unrelated imports", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "import { dep } from './dep';",
      "import { unused } from './used';",
      "",
      "class Service {",
      "  used = 1;",
      "  value = 2;",
      "  run(value: number) {",
      "    const local = value;",
      "    return dep(this.used + local);",
      "  }",
      "}"
    ].join("\n"), "utf8");

    const result = await SymbolLocator.getFunctions(filePath, "sample.ts", ["run"], { lines: true });

    expect(result?.formattedContent).toContain("1│import { dep } from './dep';");
    expect(result?.formattedContent).not.toContain("2│import { unused } from './used';");
    expect(result?.formattedContent).toContain("5│  used = 1;");
    expect(result?.formattedContent).not.toContain("6│  value = 2;");
  });

  it("does not duplicate target class fields while collecting context", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "class Service {",
      "  run = () => this.used;",
      "  used = 1;",
      "}"
    ].join("\n"), "utf8");

    const result = await SymbolLocator.getFunctions(filePath, "sample.ts", ["run"], { lines: true });
    const marker = "│  run = () => this.used";

    expect(result?.formattedContent.split(marker).length).toBe(2);
    expect(result?.formattedContent).toContain("3│  used = 1;");
  });

  it("returns symbol ranges with adjacent comments, nameText, and no detached comments", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    const source = [
      "class Service {",
      "  // method docs",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "// detached docs",
      "",
      "export function helper() {",
      "  return 2;",
      "}"
    ].join("\n");
    await writeFile(filePath, source, "utf8");

    const methodRange = await SymbolLocator.getSymbolRange(filePath, "run", "method");
    const functionRange = await SymbolLocator.getSymbolRange(filePath, "helper", "function");

    expect(methodRange?.nameText).toBe("run");
    expect(methodRange && source.slice(methodRange.startIndex, methodRange.endIndex)).toContain("  // method docs");
    expect(functionRange?.nameText).toBe("helper");
    expect(functionRange && source.slice(functionRange.startIndex, functionRange.endIndex)).not.toContain("// detached docs");
    expect(functionRange && source.slice(functionRange.startIndex, functionRange.endIndex)).toContain("export function helper() {");
  });
});
