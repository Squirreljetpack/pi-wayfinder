import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerReadTool } from "../src/read/tool.js";
import { stripLineNumbers } from "../src/tools/line-numbers.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-read-"));
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

  registerReadTool(pi as unknown as ExtensionAPI);

  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("read");
  return registeredTool as RegisteredTool;
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

const theme = {
  bold: (text: string) => `**${text}**`,
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
};

beforeAll(() => {
  initTheme(undefined, false);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("read tool", () => {
  it("prefixes every line with its absolute line number", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-1", { path: "sample.ts" }, undefined, undefined, { cwd } as never));

    expect(text).toBe("1│const a = 1;\n2│const b = 2;");
  });

  it("keeps numbers absolute when offset and limit are used", async () => {
    const cwd = await createTempDir();
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(cwd, "sample.txt"), lines.join("\n"), "utf8");

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-2", { path: "sample.txt", offset: 4, limit: 2 }, undefined, undefined, { cwd } as never));

    expect(text).toContain("4│line 4\n5│line 5");
    expect(text).toContain("[5 more lines in file. Use offset=6 to continue.]");
  });

  it("does not leak carriage returns from CRLF files into the gutter output", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "win.txt"), "one\r\ntwo\r\n", "utf8");

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-crlf", { path: "win.txt" }, undefined, undefined, { cwd } as never));

    expect(text).toBe("1│one\n2│two");
  });

  it("rejects an offset past the end of the file", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.txt"), "only\n", "utf8");

    const tool = registerToolForTest();
    await expect(
      tool.execute("call-3", { path: "sample.txt", offset: 5 }, undefined, undefined, { cwd } as never),
    ).rejects.toThrow("Offset 5 is beyond end of file (2 lines total)");
  });

  it("adds a continuation notice when the line limit truncates", async () => {
    const cwd = await createTempDir();
    const lines = Array.from({ length: 2100 }, (_, index) => `l${index + 1}`);
    await writeFile(join(cwd, "big.txt"), lines.join("\n"), "utf8");

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-4", { path: "big.txt" }, undefined, undefined, { cwd } as never));

    expect(text).toContain("1│l1");
    expect(text).toContain("2000│l2000");
    expect(text).not.toContain("2001│l2001");
    expect(text).toContain("[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]");
  });

  it("resolves @-prefixed and absolute paths", async () => {
    const cwd = await createTempDir();
    const absolute = join(cwd, "sample.txt");
    await writeFile(absolute, "x\n", "utf8");

    const tool = registerToolForTest();
    const relative = textOf(await tool.execute("call-5", { path: "@sample.txt" }, undefined, undefined, { cwd } as never));
    const direct = textOf(await tool.execute("call-6", { path: absolute }, undefined, undefined, { cwd } as never));

    expect(relative).toBe("1│x");
    expect(direct).toBe("1│x");
  });

  it("reports binary files instead of dumping them", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-7", { path: "blob.bin" }, undefined, undefined, { cwd } as never));

    expect(text).toContain("[Binary file (4B), not shown: blob.bin.");
    expect(text).not.toContain("│");
  });

  it("delegates images to pi's built-in read", async () => {
    const cwd = await createTempDir();
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(1, 8);
    ihdr.writeUInt32BE(1, 12);
    ihdr[16] = 8;
    ihdr[17] = 6;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
    await writeFile(join(cwd, "pic.png"), png);

    const tool = registerToolForTest();
    const result = await tool.execute("call-8", { path: "pic.png" }, undefined, undefined, { cwd } as never);
    const text = textOf(result);

    expect(text).toContain("Read image file [image/png]");
    expect(text).not.toMatch(/^\d+│/m);
    expect(await readFile(join(cwd, "pic.png"))).toEqual(png);
  });

  it("strips the gutter in the TUI renderer", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "const value = 1;\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute("call-9", { path: "sample.ts" }, undefined, undefined, { cwd } as never);
    const rendered = tool
      .renderResult?.(
        result as never,
        { expanded: true, isPartial: false } as never,
        theme as never,
        {
          args: { path: "sample.ts" },
          toolCallId: "call-9",
          invalidate: vi.fn(),
          lastComponent: undefined,
          state: {},
          cwd,
          executionStarted: true,
          showImages: false,
          isError: false,
        } as never,
      )
      ?.render(120)
      .join("\n");

    expect(rendered).toContain("value");
    expect(rendered).not.toContain("1│");
  });

  it("round-trips a copied gutter through stripLineNumbers", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "  indented();\n", "utf8");

    const tool = registerToolForTest();
    const text = textOf(await tool.execute("call-10", { path: "sample.ts" }, undefined, undefined, { cwd } as never));

    expect(stripLineNumbers(text)).toBe("  indented();");
  });
});
