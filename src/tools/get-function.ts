import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SymbolLocator, type GetFunctionsResult } from "../ast/symbol-locator.js";
import { formatLine } from "./line-numbers.js";
import { renderCodeLikeCall, renderCodeLikeResult } from "../rendering/pi-renderers.js";
import type { SymbolScanner } from "../symbols/symbol-scanner.js";
import {
  appendOutputLine,
  appendTruncationNotice,
  createOutputAccumulator,
  throwIfAborted,
  type OutputAccumulator,
} from "./output-limits.js";
import { GetFunctionSchema } from "./schemas.js";

const NEXT_JS_TS_DEFINITION_LINE = /^(export\s+)?(default\s+)?(async\s+)?(function|class|const)\b/;

/** Definition sites a whole-workspace scan renders before it stops and says how many it skipped. */
const MAX_SCAN_SITES = 20;

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

interface GetFunctionOptions {
  lines?: boolean;
  context?: number;
}

interface ScanTarget {
  absolutePath: string;
  displayPath: string;
  names: string[];
}

function appendText(output: ReturnType<typeof createOutputAccumulator>, text: string): void {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!appendOutputLine(output, line)) break;
  }
}

function appendSeparator(output: OutputAccumulator): void {
  appendOutputLine(output, "");
  appendOutputLine(output, "---");
  appendOutputLine(output, "");
}

/** The definition's own name: a dot-separated request is narrowed by its last segment before the AST match. */
function lastSegment(name: string): string {
  const parts = name.split(/::|\./);
  return parts[parts.length - 1] ?? name;
}

async function resolveScanTargets(
  scanner: SymbolScanner,
  names: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ targets: ScanTarget[]; totalSites: number }> {
  const requestedBySegment = new Map<string, string[]>();
  for (const name of names) {
    const segment = lastSegment(name);
    const bucket = requestedBySegment.get(segment) ?? [];
    if (!bucket.includes(name)) bucket.push(name);
    requestedBySegment.set(segment, bucket);
  }

  const locations = await scanner.scanPaths(["."], cwd, signal);
  const sites = locations
    .filter((location) => location.type === "definition" && requestedBySegment.has(location.name))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath) || a.startLine - b.startLine);

  const targets: ScanTarget[] = [];
  const byFile = new Map<string, ScanTarget>();
  for (const site of sites.slice(0, MAX_SCAN_SITES)) {
    let target = byFile.get(site.absolutePath);
    if (!target) {
      target = { absolutePath: site.absolutePath, displayPath: site.displayPath, names: [] };
      byFile.set(site.absolutePath, target);
      targets.push(target);
    }
    for (const requested of requestedBySegment.get(site.name) ?? []) {
      if (!target.names.includes(requested)) target.names.push(requested);
    }
  }

  return { targets, totalSites: sites.length };
}

/** Appends one file's definitions; a scan target that does not resolve through the AST is skipped. */
async function emitFile(
  output: OutputAccumulator,
  target: ScanTarget,
  options: GetFunctionOptions,
  signal: AbortSignal | undefined,
  requireAst: boolean,
): Promise<void> {
  throwIfAborted(signal, "get_function aborted");

  let astResult: GetFunctionsResult | null = null;
  try {
    astResult = await SymbolLocator.getFunctions(target.absolutePath, target.displayPath, target.names, options);
  } catch {
    astResult = null;
  }
  throwIfAborted(signal, "get_function aborted");

  if (astResult && !isFallbackAstResult(astResult)) {
    if (astResult.foundNames.length === 0) return;
    if (output.lineCount > 0) appendSeparator(output);
    appendText(output, astResult.formattedContent);
    return;
  }

  if (requireAst) return;

  const content = await readFile(target.absolutePath, { encoding: "utf8", signal });

  for (const name of target.names) {
    throwIfAborted(signal, "get_function aborted");

    if (output.lineCount > 0) appendSeparator(output);
    appendText(output, getRegexFunction(content, target.displayPath, name, options.lines, options.context));
  }
}

export function registerGetFunctionTool(pi: ExtensionAPI, scanner: SymbolScanner): void {
  pi.registerTool({
    name: "get_function",
    label: "Get Function",
    description:
      "Source of the named definitions, with their local imports and class context. Pass lines: true to number each line, context: N for extra surrounding lines.",
    promptSnippet: "Use get_function after get_file_skeleton to read only the relevant implementations.",
    promptGuidelines: [
      "Use read only if the needed context is not represented by a symbol or a narrow line range is clearer.",
      "Pass lines: true when the next step is a line edit, so edit's lines mode can use the numbers.",
      "Pass context: N to print N extra lines before and after each symbol body."
    ],
    parameters: GetFunctionSchema,
    renderCall(args, theme) {
      const paths = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : ["(workspace)"];
      const names = Array.isArray(args.function_names) ? args.function_names.join(", ") : "";
      const suffix = names ? theme.fg("dim", ` (${names})`) : "";
      return renderCodeLikeCall("get_function", paths, theme, suffix);
    },
    renderResult(result, options, theme, context) {
      return renderCodeLikeResult(result, options, theme, context);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const output = createOutputAccumulator();
      const names = params.function_names as string[] | undefined;
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error("Missing required parameter: function_names");
      }

      const options: GetFunctionOptions = { lines: params.lines, context: params.context };
      const requestedPaths = Array.isArray(params.paths) ? params.paths : [];

      if (requestedPaths.length === 0) {
        const scan = await resolveScanTargets(scanner, names, ctx.cwd, signal);
        for (const target of scan.targets) {
          await emitFile(output, target, options, signal, true);
        }

        if (output.lineCount === 0) {
          return {
            content: [{ type: "text", text: `No definitions found for: ${names.join(", ")} in ${ctx.cwd}.` }],
            details: { paths: requestedPaths, function_names: names, scanned: true },
          };
        }

        const shown = Math.min(scan.totalSites, MAX_SCAN_SITES);
        if (scan.totalSites > shown) {
          appendSeparator(output);
          appendText(
            output,
            `[Scanned the working directory: showing the first ${shown} of ${scan.totalSites} matching definitions. Pass paths to narrow the scan.]`,
          );
        }
      } else {
        for (const requestedPath of requestedPaths) {
          const target: ScanTarget = {
            absolutePath: resolve(ctx.cwd, requestedPath.replace(/^@/, "")),
            displayPath: requestedPath,
            names,
          };
          await emitFile(output, target, options, signal, false);
        }
      }

      return {
        content: [{ type: "text", text: appendTruncationNotice(output.parts.join(""), output) }],
        details: {
          paths: requestedPaths,
          function_names: names,
          ...(requestedPaths.length === 0 ? { scanned: true } : {}),
        },
      };
    }
  });
}
