import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGetFileSkeletonTool } from "../src/tools/get-file-skeleton.js";
import { registerGetFunctionTool } from "../src/tools/get-function.js";
import { SymbolCache } from "../src/symbols/symbol-cache.js";
import { SymbolScanner } from "../src/symbols/symbol-scanner.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-ast-tools-ts-"));
  tempDirs.push(dir);
  return dir;
}

function registerSkeletonToolForTest(): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
  };

  registerGetFileSkeletonTool(pi as unknown as ExtensionAPI);

  expect(registeredTool).toBeDefined();
  return registeredTool as RegisteredTool;
}

function registerFunctionToolForTest(): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
  };

  registerGetFunctionTool(pi as unknown as ExtensionAPI, new SymbolScanner(new SymbolCache()));

  expect(registeredTool).toBeDefined();
  return registeredTool as RegisteredTool;
}

describe("tree-sitter AST read tool integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns class methods in file skeletons through the pi tool", async () => {
    const cwd = await createTempDir();
    const source = [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "const helper = () => 2;",
    ].join("\n");
    await writeFile(join(cwd, "sample.ts"), source, "utf8");

    const tool = registerSkeletonToolForTest();
    const result = await tool.execute("call-1", { paths: ["sample.ts"], lines: true }, undefined, undefined, { cwd } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("--- sample.ts ---");
    expect(text).toContain("1│class Service {");
    expect(text).toContain("2│  run() {");
    expect(text).toContain("7│const helper = () => 2;");
    expect(text).not.toContain("return 1;");
  });

  it("prints surrounding lines when context is requested", async () => {
    const cwd = await createTempDir();
    await writeFile(
      join(cwd, "sample.ts"),
      ["const SENTINEL_ABOVE = 1;", "function pick() {", "  return 2;", "}", "const SENTINEL_BELOW = 3;"].join("\n"),
      "utf8",
    );

    const tool = registerFunctionToolForTest();
    const plain = await tool.execute("call-c1", { paths: ["sample.ts"], function_names: ["pick"] }, undefined, undefined, {
      cwd,
    } as never);
    const wide = await tool.execute(
      "call-c2",
      { paths: ["sample.ts"], function_names: ["pick"], lines: true, context: 1 },
      undefined,
      undefined,
      { cwd } as never,
    );
    const plainText = plain.content[0]?.type === "text" ? plain.content[0].text : "";
    const wideText = wide.content[0]?.type === "text" ? wide.content[0].text : "";

    expect(plainText).not.toContain("SENTINEL_ABOVE");
    expect(plainText).not.toContain("SENTINEL_BELOW");
    expect(wideText).toContain("1│const SENTINEL_ABOVE = 1;\n2│function pick() {");
    expect(wideText).toContain("4│}\n5│const SENTINEL_BELOW = 3;");
  });

  it("prints raw source unless lines: true is given", async () => {
    const cwd = await createTempDir();
    const source = ["class Service {", "  run() {", "    return 1;", "  }", "}"].join("\n");
    await writeFile(join(cwd, "sample.ts"), source, "utf8");

    const skeleton = await registerSkeletonToolForTest().execute("call-0", { paths: ["sample.ts"] }, undefined, undefined, {
      cwd,
    } as never);
    const functions = await registerFunctionToolForTest().execute(
      "call-0b",
      { paths: ["sample.ts"], function_names: ["run"] },
      undefined,
      undefined,
      { cwd } as never,
    );
    const skeletonText = skeleton.content[0]?.type === "text" ? skeleton.content[0].text : "";
    const functionsText = functions.content[0]?.type === "text" ? functions.content[0].text : "";

    expect(skeletonText).toContain("class Service {");
    expect(skeletonText).not.toContain("│");
    expect(functionsText).toContain("    return 1;");
    expect(functionsText).not.toContain("│");
  });

  it("extracts class methods by suffix name through the pi tool", async () => {
    const cwd = await createTempDir();
    const source = [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "const helper = () => 2;",
    ].join("\n");
    await writeFile(join(cwd, "sample.ts"), source, "utf8");

    const tool = registerFunctionToolForTest();
    const result = await tool.execute(
      "call-2",
      { paths: ["sample.ts"], function_names: ["run"], lines: true },
      undefined,
      undefined,
      { cwd } as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("sample.ts::Service.run");
    expect(text).toContain("2│  run() {");
    expect(text).toContain("3│    return 1;");
    expect(text).toContain("4│  }");
    expect(text).not.toContain("const helper = () => 2;");
  });

  it("returns JavaScript class methods in file skeletons through the pi tool", async () => {
    const cwd = await createTempDir();
    const source = [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "const helper = () => 2;",
    ].join("\n");
    await writeFile(join(cwd, "sample.js"), source, "utf8");

    const tool = registerSkeletonToolForTest();
    const result = await tool.execute("call-3", { paths: ["sample.js"], lines: true }, undefined, undefined, { cwd } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("--- sample.js ---");
    expect(text).toContain("1│class Service {");
    expect(text).toContain("2│  run() {");
    expect(text).toContain("7│const helper = () => 2;");
    expect(text).not.toContain("return 1;");
  });

  it("extracts JavaScript class methods by suffix name through the pi tool", async () => {
    const cwd = await createTempDir();
    const source = [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "const helper = () => 2;",
    ].join("\n");
    await writeFile(join(cwd, "sample.js"), source, "utf8");

    const tool = registerFunctionToolForTest();
    const result = await tool.execute(
      "call-4",
      { paths: ["sample.js"], function_names: ["run"], lines: true },
      undefined,
      undefined,
      { cwd } as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("sample.js::Service.run");
    expect(text).toContain("2│  run() {");
    expect(text).toContain("3│    return 1;");
    expect(text).toContain("4│  }");
    expect(text).not.toContain("const helper = () => 2;");
  });

  it("scans the working directory when paths are omitted", async () => {
    const cwd = await createTempDir();
    await writeFile(
      join(cwd, "alpha.ts"),
      ["export function pick() {", "  return 'alpha';", "}"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(cwd, "beta.ts"),
      ["export class Beta {", "  pick() {", "    return 'beta';", "  }", "}"].join("\n"),
      "utf8",
    );
    await writeFile(join(cwd, "gamma.ts"), ["export const other = 1;"].join("\n"), "utf8");

    const tool = registerFunctionToolForTest();
    const result = await tool.execute("call-5", { function_names: ["pick"] }, undefined, undefined, {
      cwd,
    } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("alpha.ts::pick");
    expect(text).toContain("return 'alpha';");
    expect(text).toContain("beta.ts::Beta.pick");
    expect(text).toContain("return 'beta';");
    expect(text).not.toContain("gamma.ts");
    expect(text).not.toContain("Pass paths to narrow the scan");
  });

  it("bounds a workspace scan and says how many definitions it skipped", async () => {
    const cwd = await createTempDir();
    for (let index = 0; index < 21; index++) {
      await writeFile(
        join(cwd, `module-${String(index).padStart(2, "0")}.ts`),
        [`export function repeated() {`, `  return ${index};`, `}`].join("\n"),
        "utf8",
      );
    }

    const tool = registerFunctionToolForTest();
    const result = await tool.execute("call-6", { function_names: ["repeated"] }, undefined, undefined, {
      cwd,
    } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("showing the first 20 of 21 matching definitions");
    expect(text).toContain("module-19.ts::repeated");
    expect(text).not.toContain("module-20.ts::repeated");
  });

  it("reports when a workspace scan finds nothing", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "export const other = 1;\n", "utf8");

    const tool = registerFunctionToolForTest();
    const result = await tool.execute("call-7", { function_names: ["missing"] }, undefined, undefined, {
      cwd,
    } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("No definitions found for: missing");
  });
});
