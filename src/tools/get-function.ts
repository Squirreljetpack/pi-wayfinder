import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SymbolLocator, type GetFunctionsResult } from "../ast/symbol-locator.js";
import { formatLine } from "./line-numbers.js";
import { renderCodeLikeCall, renderCodeLikeResult } from "../rendering/pi-renderers.js";
import { appendOutputLine, appendTruncationNotice, createOutputAccumulator, throwIfAborted } from "./output-limits.js";
import { GetFunctionSchema } from "./schemas.js";

const NEXT_JS_TS_DEFINITION_LINE = /^(export\s+)?(default\s+)?(async\s+)?(function|class|const)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pythonCodeBeforeInlineComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, i);
  }

  return line;
}

function isPythonHeaderComplete(line: string): boolean {
  return pythonCodeBeforeInlineComment(line).trimEnd().endsWith(":");
}

function hasPythonInlineBody(line: string): boolean {
  const code = pythonCodeBeforeInlineComment(line);
  const colonIndex = code.lastIndexOf(":");
  return colonIndex !== -1 && code.slice(colonIndex + 1).trim().length > 0;
}

function hasPythonMultilineClassContext(lines: string[], start: number, escapedName: string): boolean {
  const classHeader = new RegExp(`^\\s*class\\s+${escapedName}\\b[^{}:]*\\(`);
  if (!classHeader.test(lines[start])) return false;

  let parenDepth = 0;
  for (let i = start; i < lines.length; i++) {
    const code = pythonCodeBeforeInlineComment(lines[i]);
    if (code.includes("{")) return false;

    for (const char of code) {
      if (char === "(") parenDepth++;
      if (char === ")") parenDepth--;
    }

    if (parenDepth <= 0) return isPythonHeaderComplete(lines[i]);
  }

  return false;
}

function isPythonStartLine(lines: string[], start: number, escapedName: string): boolean {
  const line = lines[start];
  if (new RegExp(`^\\s*(async\\s+)?def\\s+${escapedName}\\b`).test(line)) return true;
  if (new RegExp(`^\\s*class\\s+${escapedName}\\b[^{}]*:`).test(line)) return true;
  return hasPythonMultilineClassContext(lines, start, escapedName);
}

type BraceCounterState = {
  mode: "code" | "single" | "double" | "template" | "blockComment";
  escaped: boolean;
};

function countBraceDelta(line: string, state: BraceCounterState): { delta: number; sawOpeningBrace: boolean } {
  let delta = 0;
  let sawOpeningBrace = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (state.mode === "blockComment") {
      if (char === "*" && next === "/") {
        state.mode = "code";
        i++;
      }
      continue;
    }

    if (state.mode === "single" || state.mode === "double" || state.mode === "template") {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }

      if (char === "\\") {
        state.escaped = true;
        continue;
      }

      if (
        (state.mode === "single" && char === "'") ||
        (state.mode === "double" && char === '"') ||
        (state.mode === "template" && char === "`")
      ) {
        state.mode = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") break;
    if (char === "/" && next === "*") {
      state.mode = "blockComment";
      i++;
      continue;
    }
    if (char === "'") {
      state.mode = "single";
      state.escaped = false;
      continue;
    }
    if (char === '"') {
      state.mode = "double";
      state.escaped = false;
      continue;
    }
    if (char === "`") {
      state.mode = "template";
      state.escaped = false;
      continue;
    }

    if (char === "{") {
      delta++;
      sawOpeningBrace = true;
    }
    if (char === "}") delta--;
  }

  if (state.mode === "single" || state.mode === "double") state.escaped = false;
  return { delta, sawOpeningBrace };
}

function isOneLineExpressionArrow(line: string): boolean {
  const arrowIndex = line.indexOf("=>");
  if (arrowIndex === -1) return false;

  const expression = line.slice(arrowIndex + 2).trim();
  return expression.length > 0 && !expression.startsWith("{");
}

function findPythonRange(lines: string[], start: number): [number, number] {
  const baseIndent = lines[start].match(/^\s*/)?.[0].length ?? 0;
  let end = start;
  let headerComplete = isPythonHeaderComplete(lines[start]);
  let bodyBegun = headerComplete && hasPythonInlineBody(lines[start]);

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      end = i;
      continue;
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (bodyBegun && indent <= baseIndent) break;

    end = i;
    if (!headerComplete) {
      headerComplete = isPythonHeaderComplete(line);
      continue;
    }
    if (indent > baseIndent) bodyBegun = true;
  }

  return [start, end];
}

function findJsTsRange(lines: string[], start: number): [number, number] {
  if (isOneLineExpressionArrow(lines[start])) return [start, start];

  let depth = 0;
  let sawBody = false;
  const braceState: BraceCounterState = { mode: "code", escaped: false };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const { delta, sawOpeningBrace } = countBraceDelta(line, braceState);
    if (sawOpeningBrace) sawBody = true;
    depth += delta;

    if (sawBody && depth <= 0) return [start, i];

    if (!sawBody && i > start && NEXT_JS_TS_DEFINITION_LINE.test(line.trim())) {
      return [start, i - 1];
    }
  }

  return [start, lines.length - 1];
}

export function findFunctionRange(lines: string[], name: string): [number, number] | undefined {
  const escaped = escapeRegExp(name);
  const startRegex = new RegExp(
    `(^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${escaped}\\b)|` +
      `(^\\s*(export\\s+)?const\\s+${escaped}\\s*=)|` +
      `(^\\s*(async\\s+)?def\\s+${escaped}\\b)|` +
      `(^\\s*(export\\s+)?(default\\s+)?class\\s+${escaped}\\b)|` +
      `(^\\s*class\\s+${escaped}\\b)`
  );
  const start = lines.findIndex((line) => startRegex.test(line));
  if (start === -1) return undefined;

  if (isPythonStartLine(lines, start, escaped)) return findPythonRange(lines, start);
  return findJsTsRange(lines, start);
}

export function getRegexFunction(
  content: string,
  absolutePath: string,
  requestedPath: string,
  name: string,
  numbered: boolean | undefined,
  surrounding = 0,
): string {
  const lines = content.split(/\r?\n/);
  const range = findFunctionRange(lines, name);

  if (!range) return `${requestedPath}::${name}\nNot found.`;

  const firstLine = Math.max(0, range[0] - surrounding);
  const lastLine = Math.min(lines.length - 1, range[1] + surrounding);
  const formattedBody = lines
    .slice(firstLine, lastLine + 1)
    .map((line, offset) => formatLine(firstLine + offset + 1, line, numbered))
    .join("\n");
  return `${requestedPath}::${name}\n${formattedBody}`;
}

function isFallbackAstResult(result: GetFunctionsResult | null): boolean {
  if (!result) return true;
  return (
    result.formattedContent.startsWith("Unsupported file type:") ||
    result.formattedContent.startsWith("Could not parse file:")
  );
}

function appendText(output: ReturnType<typeof createOutputAccumulator>, text: string): void {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!appendOutputLine(output, line)) break;
  }
}

export function registerGetFunctionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "get_function",
    label: "Get Function",
    description:
      "After get_file_skeleton, extract implementations of the specific named functions/classes needed for the task. Pass lines: true to number each line, context: N for extra surrounding lines.",
    promptSnippet: "Use get_function after get_file_skeleton to read only the relevant implementations.",
    promptGuidelines: [
      "Prefer get_function after a skeleton has identified the symbols relevant to the task.",
      "Use read only if the needed context is not represented by a symbol or a narrow line range is clearer.",
      "Pass lines: true when the next step is a line edit, so edit's lines mode can use the numbers.",
      "Pass context: N to print N extra lines before and after each symbol body."
    ],
    parameters: GetFunctionSchema,
    renderCall(args, theme) {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const names = Array.isArray(args.function_names) ? args.function_names.join(", ") : "";
      const suffix = names ? theme.fg("dim", ` (${names})`) : "";
      return renderCodeLikeCall("get_function", paths, theme, suffix);
    },
    renderResult(result, options, theme, context) {
      return renderCodeLikeResult(result, options, theme, context);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const output = createOutputAccumulator();
      let hasOutput = false;

      for (const requestedPath of params.paths) {
        throwIfAborted(signal, "get_function aborted");

        const normalizedPath = requestedPath.replace(/^@/, "");
        const absolutePath = resolve(ctx.cwd, normalizedPath);

        let astResult: GetFunctionsResult | null = null;
        try {
          astResult = await SymbolLocator.getFunctions(absolutePath, requestedPath, params.function_names, {
            lines: params.lines,
            context: params.context,
          });
        } catch {
          astResult = null;
        }
        throwIfAborted(signal, "get_function aborted");

        if (astResult && !isFallbackAstResult(astResult)) {
          if (hasOutput) {
            appendOutputLine(output, "");
            appendOutputLine(output, "---");
            appendOutputLine(output, "");
          }
          appendText(output, astResult.formattedContent);
          hasOutput = true;
          continue;
        }

        const content = await readFile(absolutePath, { encoding: "utf8", signal });

        for (const name of params.function_names) {
          throwIfAborted(signal, "get_function aborted");

          if (hasOutput) {
            appendOutputLine(output, "");
            appendOutputLine(output, "---");
            appendOutputLine(output, "");
          }

          appendText(output, getRegexFunction(content, absolutePath, requestedPath, name, params.lines, params.context));
          hasOutput = true;
        }
      }

      return {
        content: [{ type: "text", text: appendTruncationNotice(output.parts.join(""), output) }],
        details: { paths: params.paths, function_names: params.function_names },
      };
    }
  });
}
