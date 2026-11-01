import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SymbolLocator, type SymbolRange } from "../ast/symbol-locator.js";
import { combineDiffs, createUnifiedDiff, type DiffDetails } from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderDiffResult } from "../rendering/pi-renderers.js";
import { stripLineNumbers } from "./line-numbers.js";
import { InsertSymbolSchema } from "./schemas.js";

export type InsertPosition = "before" | "after";

export interface SymbolInsertion {
  path: string;
  symbol: string;
  position: InsertPosition;
  text: string;
  type?: string;
}

export interface FileInsertionBatch {
  absolutePath: string;
  displayPath: string;
  insertions: SymbolInsertion[];
}

export interface ResolvedSymbolInsertion {
  insertion: SymbolInsertion;
  range: SymbolRange;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.match(/\r\n|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

export function normalizeInsertionText(text: string, lineEnding: "\r\n" | "\n"): string {
  const normalized = stripLineNumbers(text).replace(/\r\n|\r|\n/g, lineEnding);
  return normalized.replace(/\s+$/g, "");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("insert_symbol aborted");
}

function missingSymbolMessage(insertion: SymbolInsertion): string {
  return `Symbol '${insertion.symbol}'${insertion.type ? ` of type '${insertion.type}'` : ""} not found in ${insertion.path}.`;
}

export interface PreparedFileInsertionBatch {
  batch: FileInsertionBatch;
  finalContent: string;
  diff: DiffDetails;
}

interface InsertSymbolToolDetails {
  paths: string[];
  symbols: string[];
  diff: string;
  diffs: DiffDetails[];
  firstChangedLine?: number;
}

async function withFileMutationQueues<T>(absolutePaths: string[], fn: () => Promise<T>): Promise<T> {
  const uniquePaths = Array.from(new Set(absolutePaths)).sort();

  const runWithQueue = async (index: number): Promise<T> => {
    if (index >= uniquePaths.length) return fn();
    return withFileMutationQueue(uniquePaths[index], () => runWithQueue(index + 1));
  };

  return runWithQueue(0);
}

export function groupInsertionsByPath(insertions: SymbolInsertion[], cwd: string): FileInsertionBatch[] {
  const batches = new Map<string, FileInsertionBatch>();

  for (const insertion of insertions) {
    const cleanedPath = insertion.path.replace(/^@/, "");
    const absolutePath = resolve(cwd, cleanedPath);
    const existing = batches.get(absolutePath);
    if (existing) {
      existing.insertions.push(insertion);
    } else {
      batches.set(absolutePath, {
        absolutePath,
        displayPath: insertion.path,
        insertions: [insertion],
      });
    }
  }

  return Array.from(batches.values());
}

/**
 * Builds the text spliced at a symbol boundary.
 *
 * `SymbolRange.startIndex` is clamped to the start of the symbol's first line
 * (doc comments included) and `endIndex` sits right after the symbol's final
 * token (e.g. the closing brace), so "before" and "after" both land on their
 * own lines without disturbing the target symbol.
 */
export function insertionText(insertion: SymbolInsertion, lineEnding: "\r\n" | "\n"): string {
  const text = normalizeInsertionText(insertion.text, lineEnding);
  return insertion.position === "before" ? `${text}${lineEnding}` : `${lineEnding}${text}`;
}

export function applyResolvedSymbolInsertions(
  content: string,
  resolvedInsertions: ResolvedSymbolInsertion[],
  lineEnding: "\r\n" | "\n",
): string {
  // Bottom-to-top so earlier indices stay valid as later insertions shift the buffer.
  const sorted = [...resolvedInsertions].sort((a, b) => b.range.startIndex - a.range.startIndex);
  let nextContent = content;
  for (const item of sorted) {
    const boundary = item.insertion.position === "before" ? item.range.startIndex : item.range.endIndex;
    nextContent = nextContent.slice(0, boundary) + insertionText(item.insertion, lineEnding) + nextContent.slice(boundary);
  }
  return nextContent;
}

export function registerInsertSymbolTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "insert_symbol",
    label: "Insert Symbol",
    description: "Insert code before or after a named AST symbol definition using tree-sitter ranges.",
    promptSnippet: "Use insert_symbol to add sibling/helper code adjacent to a known symbol definition.",
    promptGuidelines: [
      "Use insert_symbol with position 'before' to add code above a symbol's definition (including its doc comment).",
      "Use insert_symbol with position 'after' to add code below a symbol's definition.",
      "Provide complete raw code without line-number prefixes; prefixes are stripped if accidentally included.",
    ],
    parameters: InsertSymbolSchema,
    renderCall(args, theme) {
      const paths = Array.isArray(args.insertions)
        ? args.insertions.map((insertion) => insertion.path).filter((path): path is string => typeof path === "string")
        : [];
      return renderCodeLikeCall("insert_symbol", paths, theme);
    },
    renderResult(result, options, theme, context) {
      return renderDiffResult(result as never, options, theme, context, "Inserting");
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const insertions = params.insertions as SymbolInsertion[] | undefined;
      if (!Array.isArray(insertions) || insertions.length === 0) {
        throw new Error("Missing required parameter: insertions");
      }
      for (const insertion of insertions) {
        if (insertion.position !== "before" && insertion.position !== "after") {
          throw new Error(`Invalid position '${String(insertion.position)}' for symbol '${insertion.symbol}'. Use 'before' or 'after'.`);
        }
      }

      const batches = groupInsertionsByPath(insertions, ctx.cwd);
      const summaries: string[] = [];
      let diffs: DiffDetails[] = [];

      await withFileMutationQueues(batches.map((batch) => batch.absolutePath), async () => {
        const preparedBatches: PreparedFileInsertionBatch[] = [];

        for (const batch of batches) {
          throwIfAborted(signal);
          const originalContent = await readFile(batch.absolutePath, { encoding: "utf8", signal });
          const lineEnding = detectLineEnding(originalContent);

          const resolved: ResolvedSymbolInsertion[] = [];
          for (const insertion of batch.insertions) {
            throwIfAborted(signal);
            const range = await SymbolLocator.getSymbolRange(batch.absolutePath, insertion.symbol, insertion.type);
            if (!range) throw new Error(missingSymbolMessage(insertion));
            resolved.push({ insertion, range });
          }

          throwIfAborted(signal);
          const finalContent = applyResolvedSymbolInsertions(originalContent, resolved, lineEnding);
          preparedBatches.push({
            batch,
            finalContent,
            diff: createUnifiedDiff(batch.displayPath, originalContent, finalContent),
          });
        }

        diffs = preparedBatches.map((prepared) => prepared.diff).filter((diff) => diff.diff.length > 0);

        for (const prepared of preparedBatches) {
          throwIfAborted(signal);
          await mkdir(dirname(prepared.batch.absolutePath), { recursive: true });
          throwIfAborted(signal);
          await writeFile(prepared.batch.absolutePath, prepared.finalContent, { encoding: "utf8", signal });

          const labelList = prepared.batch.insertions
            .map((insertion) => `'${insertion.symbol}' (${insertion.position})`)
            .join(", ");
          summaries.push(`Successfully inserted ${prepared.batch.insertions.length} ${prepared.batch.insertions.length === 1 ? "insertion" : "insertions"} adjacent to ${labelList} in ${prepared.batch.displayPath}.`);
        }
      });

      return {
        content: [{ type: "text", text: summaries.join("\n\n") }],
        details: {
          paths: batches.map((batch) => batch.displayPath),
          symbols: insertions.map((insertion) => insertion.symbol),
          diffs,
          diff: combineDiffs(diffs),
          firstChangedLine: diffs[0]?.firstChangedLine,
        } satisfies InsertSymbolToolDetails,
      };
    },
  });
}
