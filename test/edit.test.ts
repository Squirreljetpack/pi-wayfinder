import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRanges } from "../src/edit/apply.js";
import { lineStarts, resolveEdit, validateEdit, type EditSpec } from "../src/edit/resolve.js";
import { normalizeEditArguments } from "../src/edit/shims.js";
import { readSnapshot, writeSnapshot } from "../src/edit/snapshot.js";
import { registerEditTool } from "../src/edit/tool.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-edit-"));
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

  registerEditTool(pi as unknown as ExtensionAPI);

  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("edit");
  return registeredTool as RegisteredTool;
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

function spec(partial: Partial<EditSpec> & { path: string }): EditSpec {
  return { mode: "exact", new: "", ...partial } as EditSpec;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit range resolution", () => {
  it("replaces every occurrence in exact mode", () => {
    const text = "a();\nb();\na();\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", old: "a();", new: "a(1);" }));

    expect(resolved.ranges).toHaveLength(2);
    expect(applyRanges(text, resolved.ranges)).toBe("a(1);\nb();\na(1);\n");
  });

  it("tolerates CRLF in the model's old text", () => {
    const text = "one\ntwo\nthree\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", old: "one\r\ntwo", new: "ONE\nTWO" }));

    expect(resolved.ranges).toHaveLength(1);
    expect(applyRanges(text, resolved.ranges)).toBe("ONE\nTWO\nthree\n");
  });

  it("tolerates trailing whitespace on a single-line match only", () => {
    const text = "  const value = 1;   \nnext();\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", old: "  const value = 1;", new: "  const value = 2;" }));

    expect(applyRanges(text, resolved.ranges)).toBe("  const value = 2;   \nnext();\n");
  });

  it("does not match a multi-line old text that differs in trailing whitespace", () => {
    const text = "a  \nb\n";
    expect(() => resolveEdit(text, spec({ path: "x.ts", old: "a\nb", new: "c" }))).toThrow(/No match/);
  });

  it("rejects an empty old text", () => {
    expect(() => validateEdit({ path: "x.ts", mode: "exact", old: "", new: "x" }, 0)).toThrow(/old is required/);
  });

  it("rejects a missing mode and missing required mode fields", () => {
    expect(() => validateEdit({ path: "x.ts", new: "x" }, 0)).toThrow(/mode must be/);
    expect(() => validateEdit({ path: "x.ts", mode: "between", start: "a", new: "x" }, 0)).toThrow(/end is required/);
    expect(() => validateEdit({ path: "x.ts", mode: "lines", new: "x" }, 0)).toThrow(/start_line/);
  });

  it("infers exact mode from old/new", () => {
    const validated = validateEdit({ path: "x.ts", old: "a", new: "b" }, 0);
    expect(validated.mode).toBe("exact");
  });

  it("replaces whole lines and keeps line breaks intact", () => {
    const text = "a\nb\nc\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 2, end_line: 2, new: "B" }));
    expect(applyRanges(text, resolved.ranges)).toBe("a\nB\nc\n");

    const multi = resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 1, end_line: 2, new: "first\nsecond" }));
    expect(applyRanges(text, multi.ranges)).toBe("first\nsecond\nc\n");
  });

  it("deletes whole lines without leaving a blank line", () => {
    const text = "a\nb\nc\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 2, end_line: 2, new: "" }));
    expect(applyRanges(text, resolved.ranges)).toBe("a\nc\n");
  });

  it("inserts before a line with end_line = start_line - 1", () => {
    const text = "a\nb\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 2, end_line: 1, new: "inserted" }));
    expect(applyRanges(text, resolved.ranges)).toBe("a\ninserted\nb\n");
  });

  it("does not add a trailing newline when the file had none", () => {
    const text = "a\nb";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 2, end_line: 2, new: "B" }));
    expect(applyRanges(text, resolved.ranges)).toBe("a\nB");
  });

  it("reports out-of-range line numbers against the real line count", () => {
    const text = "a\nb\n";
    expect(lineStarts(text)).toEqual([0, 2]);
    expect(() => resolveEdit(text, spec({ path: "x.ts", mode: "lines", start_line: 9, new: "x" }))).toThrow(
      /Lines 9-9 are beyond the end of x\.ts \(2 lines\)/,
    );
  });

  it("enforces expected_matches and reports where the matches are", () => {
    const text = "a();\nb();\n";
    expect(() => resolveEdit(text, spec({ path: "x.ts", old: "();", new: "()", expected_matches: 1 }))).toThrow(
      /matched 2, expected 1/,
    );
  });

  it("treats expected_matches 0 as an assertion that resolves to nothing", () => {
    const resolved = resolveEdit("a\n", spec({ path: "x.ts", old: "nope", new: "", expected_matches: 0 }));
    expect(resolved.ranges).toEqual([]);
    expect(applyRanges("a\n", resolved.ranges)).toBe("a\n");
  });

  it("strips a pasted line-number gutter from replacement text", () => {
    const text = "const a = 1;\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", old: "const a = 1;", new: "2│const a = 2;\n3│const b = 3;" }));
    expect(applyRanges(text, resolved.ranges)).toBe("const a = 2;\nconst b = 3;\n");
  });
});

describe("edit overlap handling", () => {
  it("rejects overlapping ranges from two edits on the same file", () => {
    const text = "alpha beta gamma\n";
    expect(() =>
      applyRanges(text, [
        { mode: "exact", start: 0, end: 5, text: "A" },
        { mode: "exact", start: 3, end: 9, text: "B" },
      ]),
    ).toThrow(/Overlapping edits/);
  });

  it("applies disjoint ranges bottom-up regardless of input order", () => {
    const text = "one two three\n";
    const applied = applyRanges(text, [
      { mode: "exact", start: 8, end: 13, text: "THREE" },
      { mode: "exact", start: 0, end: 3, text: "ONE" },
    ]);
    expect(applied).toBe("ONE two THREE\n");
  });
});

describe("edit snapshot", () => {
  it("preserves BOM and CRLF line endings", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "\uFEFFconst a = 1;\r\nconst b = 2;\r\n", "utf8");

    const snapshot = await readSnapshot("sample.ts", cwd);
    expect(snapshot.text).toBe("const a = 1;\nconst b = 2;\n");
    expect(snapshot.eol).toBe("\r\n");

    const resolved = resolveEdit(snapshot.text, spec({ path: "sample.ts", old: "const a = 1;", new: "const a = 9;" }));
    await writeSnapshot(snapshot, applyRanges(snapshot.text, resolved.ranges));

    await expect(readFile(filePath, "utf8")).resolves.toBe("\uFEFFconst a = 9;\r\nconst b = 2;\r\n");
  });

  it("refuses to write when the file changed after it was read", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "before\n", "utf8");

    const snapshot = await readSnapshot("sample.ts", cwd);
    await writeFile(filePath, "changed by another agent\n", "utf8");

    await expect(writeSnapshot(snapshot, "after\n")).rejects.toThrow(/changed while editing \(expected .*, found .*\); re-read/);
    await expect(readFile(filePath, "utf8")).resolves.toBe("changed by another agent\n");
    expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("edit tool", () => {
  it("edits several files in one call and reports counts", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    await writeFile(join(cwd, "b.ts"), "export const c = 3;\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-1",
      {
        edits: [
          { path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 10;" },
          { path: "a.ts", mode: "lines", start_line: 2, end_line: 2, new: "const b = 20;" },
          { path: "b.ts", mode: "exact", old: "const c = 3;", new: "const c = 30;" },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(join(cwd, "a.ts"), "utf8")).resolves.toBe("const a = 10;\nconst b = 20;\n");
    await expect(readFile(join(cwd, "b.ts"), "utf8")).resolves.toBe("export const c = 30;\n");
    expect(textOf(result)).toContain("Updated 2 files: 3 edits, 3 replacements.");
    expect(textOf(result)).toContain("  a.ts: 2 edits, 2 replacements");
    expect(result.details).toMatchObject({ edits: 3, replacements: 3, paths: ["a.ts", "b.ts"] });
    expect((result.details as { patch: string }).patch).toContain("--- a/a.ts");
  });

  it("writes nothing when any edit in the call fails", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");
    await writeFile(join(cwd, "b.ts"), "const b = 2;\n", "utf8");

    const tool = registerToolForTest();
    const call = tool.execute(
      "call-2",
      {
        edits: [
          { path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 10;" },
          { path: "b.ts", mode: "exact", old: "not there", new: "x" },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(call).rejects.toThrow(/No match for edits on b\.ts/);
    await expect(readFile(join(cwd, "a.ts"), "utf8")).resolves.toBe("const a = 1;\n");
    await expect(readFile(join(cwd, "b.ts"), "utf8")).resolves.toBe("const b = 2;\n");
  });

  it("rejects a call that changes nothing", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");

    const tool = registerToolForTest();
    const call = tool.execute(
      "call-3",
      { edits: [{ path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 1;" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(call).rejects.toThrow(/produced no changes/);
  });

  it("rejects missing edits and invalid mode fields before touching disk", async () => {
    const cwd = await createTempDir();
    const tool = registerToolForTest();

    await expect(tool.execute("call-4", { edits: [] }, undefined, undefined, { cwd } as never)).rejects.toThrow(
      "Missing required parameter: edits",
    );
    await expect(
      tool.execute("call-5", { edits: [{ path: "a.ts", mode: "between", start: "a", new: "x" }] }, undefined, undefined, {
        cwd,
      } as never),
    ).rejects.toThrow(/end is required/);
  });
});

describe("edit between mode", () => {
  it("replaces the text between delimiters and keeps the delimiters", () => {
    const text = "function outer() {\n  oldBody();\n}\n";
    const resolved = resolveEdit(
      text,
      spec({ path: "x.ts", mode: "between", start: "function outer() {", end: "\n}", new: "\n  newBody();" }),
    );

    expect(applyRanges(text, resolved.ranges)).toBe("function outer() {\n  newBody();\n}\n");
  });

  it("replaces the delimiters too when include_delimiters is set", () => {
    const text = "// BEGIN\npayload\n// END\n";
    const resolved = resolveEdit(
      text,
      spec({ path: "x.ts", mode: "between", start: "// BEGIN\n", end: "// END", include_delimiters: true, new: "// BEGIN\nnew payload\n// END" }),
    );

    expect(applyRanges(text, resolved.ranges)).toBe("// BEGIN\nnew payload\n// END\n");
  });

  it("inserts between adjacent delimiters with an empty region and empty old text", () => {
    const text = "first();\nsecond();\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "between", start: "first();\n", end: "second();", new: "inserted();\n" }));

    expect(applyRanges(text, resolved.ranges)).toBe("first();\ninserted();\nsecond();\n");
  });

  it("replaces every delimiter pair in the file", () => {
    const text = "<a>\none\n</a>\n<a>\ntwo\n</a>\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "between", start: "<a>", end: "</a>", new: "<a>X</a>", include_delimiters: true }));

    expect(applyRanges(text, resolved.ranges)).toBe("<a>X</a>\n<a>X</a>\n");
  });

  it("pairs greedily, so a start nested before the end delimiter belongs to the same region", () => {
    const text = "A start\nB start\nB end\nA end\n";
    const resolved = resolveEdit(text, spec({ path: "x.ts", mode: "between", start: "start\n", end: "B end", new: "X" }));

    expect(resolved.ranges).toHaveLength(1);
    expect(applyRanges(text, resolved.ranges)).toBe("A start\nX\nB end\nA end\n");
  });

  it("reports a dangling start delimiter with its line", () => {
    const text = "open\nnothing after\n";
    expect(() => resolveEdit(text, spec({ path: "x.ts", mode: "between", start: "open", end: "close", new: "x" }))).toThrow(
      /No end delimiter found after the start delimiter:\n {2}1: open/,
    );
  });

  it("reports a missing start delimiter", () => {
    expect(() => resolveEdit("nothing\n", spec({ path: "x.ts", mode: "between", start: "open", end: "close", new: "x" }))).toThrow(
      /Start delimiter "open" not found in x\.ts/,
    );
  });
});

describe("edit argument shims", () => {
  it("normalizes pi-style oldText/newText entries", () => {
    const shimmed = normalizeEditArguments({
      edits: [{ path: "a.ts", oldText: "a", newText: "b" }],
    }) as { edits: Array<Record<string, unknown>> };

    expect(shimmed.edits[0]).toEqual({ path: "a.ts", mode: "exact", old: "a", new: "b" });
  });

  it("wraps a single edit object and parses a stringified edits array", () => {
    const single = normalizeEditArguments({ edits: { path: "a.ts", old: "a", new: "b" } }) as {
      edits: Array<Record<string, unknown>>;
    };
    expect(single.edits).toHaveLength(1);
    expect(single.edits[0]).toMatchObject({ path: "a.ts", mode: "exact" });

    const stringified = normalizeEditArguments({ edits: JSON.stringify([{ path: "a.ts", old: "a", new: "b" }]) }) as {
      edits: Array<Record<string, unknown>>;
    };
    expect(stringified.edits).toHaveLength(1);
    expect(stringified.edits[0]).toMatchObject({ path: "a.ts", old: "a", mode: "exact" });
  });

  it("pushes a top-level path down into each edit", () => {
    const shimmed = normalizeEditArguments({
      path: "a.ts",
      edits: [
        { old: "a", new: "b" },
        { old: "c", new: "d" },
      ],
    }) as { path?: string; edits: Array<Record<string, unknown>> };

    expect(shimmed.path).toBeUndefined();
    expect(shimmed.edits.map((edit) => edit.path)).toEqual(["a.ts", "a.ts"]);
  });

  it("folds a flat top-level oldText/newText pair into edits", () => {
    const shimmed = normalizeEditArguments({ path: "a.ts", oldText: "a", newText: "b" }) as {
      edits: Array<Record<string, unknown>>;
    };

    expect(shimmed.edits).toEqual([{ path: "a.ts", mode: "exact", old: "a", new: "b" }]);
  });

  it("leaves a modern call untouched", () => {
    const modern = { edits: [{ path: "a.ts", mode: "lines", start_line: 1, new: "x" }] };
    expect(normalizeEditArguments(modern)).toEqual(modern);
  });

  it("executes a shimmed call end to end", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");

    const tool = registerToolForTest();
    const shimmed = normalizeEditArguments({ edits: [{ path: "a.ts", oldText: "const a = 1;", newText: "const a = 2;" }] });
    await tool.execute("call-shim", shimmed, undefined, undefined, { cwd } as never);

    await expect(readFile(join(cwd, "a.ts"), "utf8")).resolves.toBe("const a = 2;\n");
  });
});

describe("edit regressions", () => {
  it("rejects the same exact edit twice instead of applying it twice", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n", "utf8");

    const call = registerToolForTest().execute(
      "call-dup",
      {
        edits: [
          { path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 2;" },
          { path: "a.ts", mode: "exact", old: "const a = 1;", new: "const a = 3;" },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(call).rejects.toThrow(/Overlapping edits/);
    await expect(readFile(join(cwd, "a.ts"), "utf8")).resolves.toBe("const a = 1;\n");
  });

  it("keeps BOM and CRLF when the replacement text carries a pasted gutter", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "a.ts");
    await writeFile(filePath, "\uFEFFone\r\ntwo\r\n", "utf8");

    await registerToolForTest().execute(
      "call-bom",
      { edits: [{ path: "a.ts", mode: "lines", start_line: 2, end_line: 2, new: "2│TWO" }] },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe("\uFEFFone\r\nTWO\r\n");
  });
});
