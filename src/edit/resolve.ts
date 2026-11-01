import { normalizeToLF } from "./snapshot.js";

export type EditMode = "exact" | "between" | "lines";

/**
 * One edit as the model sends it. Every mode is a way to name a region; all of them resolve to
 * byte ranges over the original file, so exactly one applier runs afterwards.
 */
export interface EditSpec {
  path: string;
  mode?: EditMode;
  expected_matches?: number;
  old?: string;
  new?: string;
  start?: string;
  end?: string;
  include_delimiters?: boolean;
  start_line?: number;
  end_line?: number;
}

export interface ResolvedEdit {
  mode: EditMode;
  start: number;
  end: number;
  text: string;
}

export interface ResolvedSpec {
  edit: EditSpec;
  mode: EditMode;
  ranges: ResolvedEdit[];
}

export interface Hit {
  start: number;
  end: number;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  if (text.endsWith("\n")) starts.pop();
  return starts;
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") line++;
  }
  return line;
}

export function validateEdit(edit: unknown, index: number): EditSpec {
  if (!edit || typeof edit !== "object") throw new Error(`edits[${index}] must be an object`);
  const spec = edit as EditSpec;

  if (typeof spec.path !== "string" || spec.path.length === 0) {
    throw new Error(`edits[${index}].path is required`);
  }
  const mode = spec.mode ?? (spec.old !== undefined ? "exact" : undefined);
  if (mode !== "exact" && mode !== "between" && mode !== "lines") {
    throw new Error(`edits[${index}].mode must be "exact", "between" or "lines"`);
  }
  if (typeof spec.new !== "string") {
    throw new Error(`edits[${index}].new is required (use "" to delete)`);
  }

  if (mode === "exact") {
    if (typeof spec.old !== "string" || spec.old.length === 0) {
      throw new Error(`edits[${index}].old is required for mode "exact"`);
    }
  } else if (mode === "between") {
    if (typeof spec.start !== "string" || spec.start.length === 0) {
      throw new Error(`edits[${index}].start is required for mode "between"`);
    }
    if (typeof spec.end !== "string" || spec.end.length === 0) {
      throw new Error(`edits[${index}].end is required for mode "between"`);
    }
  } else {
    if (!Number.isInteger(spec.start_line) || (spec.start_line as number) < 1) {
      throw new Error(`edits[${index}].start_line must be a 1-indexed integer for mode "lines"`);
    }
    if (spec.end_line !== undefined && (!Number.isInteger(spec.end_line) || spec.end_line < 1)) {
      throw new Error(`edits[${index}].end_line must be a 1-indexed integer`);
    }
  }

  if (
    spec.expected_matches !== undefined &&
    (!Number.isInteger(spec.expected_matches) || spec.expected_matches < 0)
  ) {
    throw new Error(`edits[${index}].expected_matches must be a non-negative integer`);
  }

  return { ...spec, mode };
}

function allOccurrences(haystack: string, needle: string): Hit[] {
  const hits: Hit[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return hits;
}

/**
 * Single-line matches that differ only in trailing whitespace.
 *
 * Deliberately narrower than pi's fuzzy matching (no NFKC, no smart quotes, no multi-line
 * whitespace folding): the only drift this tolerates is one the model cannot see, and anything
 * larger is better served by `between` mode.
 */
function trimmedLineOccurrences(text: string, needle: string): Hit[] {
  if (needle.includes("\n")) return [];
  const target = needle.replace(/[ \t]+$/, "");
  if (target.length === 0) return [];

  const hits: Hit[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const candidate = line.slice(0, target.length);
    const rest = line.slice(target.length);
    if (candidate === target && rest.trim().length === 0) hits.push({ start: offset, end: offset + target.length });
    offset += line.length + 1;
  }
  return hits;
}

function matchLocations(text: string, hits: Hit[], limit = 20): string {
  return hits
    .slice(0, limit)
    .map((hit) => {
      const line = lineOf(text, hit.start);
      const lineText = text.split("\n")[line - 1] ?? "";
      return `  ${line}: ${lineText.trim()}`;
    })
    .join("\n");
}

function resolveExact(text: string, spec: EditSpec): Hit[] {
  const needle = normalizeToLF(spec.old as string);
  const hits = allOccurrences(text, needle);
  if (hits.length > 0) return hits;
  return trimmedLineOccurrences(text, needle);
}

function resolveBetween(text: string, spec: EditSpec): Hit[] {
  const startNeedle = normalizeToLF(spec.start as string);
  const endNeedle = normalizeToLF(spec.end as string);
  const includeDelimiters = spec.include_delimiters === true;
  const hits: Hit[] = [];
  const danglingStarts: number[] = [];

  let from = 0;
  while (from <= text.length) {
    const startIndex = text.indexOf(startNeedle, from);
    if (startIndex === -1) break;

    const afterStart = startIndex + startNeedle.length;
    const endIndex = text.indexOf(endNeedle, afterStart);
    if (endIndex === -1) {
      danglingStarts.push(startIndex);
      break;
    }

    const endAfter = endIndex + endNeedle.length;
    hits.push({
      start: includeDelimiters ? startIndex : afterStart,
      end: includeDelimiters ? endAfter : endIndex,
    });
    // Greedy pairing: a start nested inside this region is part of it, not a second region.
    from = endAfter;
  }

  if (hits.length === 0) {
    if (danglingStarts.length > 0) {
      const starts = danglingStarts.map((offset) => `  ${lineOf(text, offset)}: ${text.split("\n")[lineOf(text, offset) - 1]?.trim()}`).join("\n");
      throw new Error(`No end delimiter found after the start delimiter:\n${starts}`);
    }
    throw new Error(`Start delimiter ${JSON.stringify(spec.start)} not found in ${spec.path}`);
  }

  return hits;
}

/**
 * Line mode is line-oriented: the range covers whole lines including their line breaks, so a
 * replacement never splits a line and a deletion never leaves a blank one behind.
 */
function resolveLines(text: string, spec: EditSpec): Hit[] {
  const starts = lineStarts(text);
  const totalLines = starts.length;
  const startLine = spec.start_line as number;
  const endLine = spec.end_line ?? startLine;
  const isInsertion = endLine < startLine;

  if (isInsertion) {
    if (startLine > totalLines + 1) {
      throw new Error(`start_line ${startLine} is beyond the end of ${spec.path} (${totalLines} lines)`);
    }
    return [{ start: starts[startLine - 1] ?? text.length, end: starts[startLine - 1] ?? text.length }];
  }

  if (startLine > totalLines || endLine > totalLines) {
    throw new Error(`Lines ${startLine}-${endLine} are beyond the end of ${spec.path} (${totalLines} lines)`);
  }

  const start = starts[startLine - 1];
  const end = endLine < totalLines ? starts[endLine] : text.length;
  return [{ start, end }];
}

export function resolveEdit(text: string, spec: EditSpec): ResolvedSpec {
  const mode = spec.mode as EditMode;
  const hits = mode === "exact" ? resolveExact(text, spec) : mode === "between" ? resolveBetween(text, spec) : resolveLines(text, spec);
  const ranges = hits.map((hit) => ({
    mode,
    start: hit.start,
    end: hit.end,
    text: shapeReplacement(mode, text, hit, spec),
  }));

  if (ranges.length === 0 && spec.expected_matches === 0) {
    return { edit: spec, mode, ranges: [] };
  }

  if (ranges.length === 0) {
    const needle = normalizeToLF(spec.old ?? spec.start ?? "");
    throw new Error(
      `No match for edits on ${spec.path} (mode "${mode}"):\n  searched for: ${JSON.stringify(needle.slice(0, 120))}\n  the file contains ${text.split("\n").length} lines; re-read it and copy the text exactly`,
    );
  }

  if (spec.expected_matches !== undefined && ranges.length !== spec.expected_matches) {
    const locations = mode === "lines" ? "" : `\nMatches:\n${matchLocations(text, hits)}`;
    throw new Error(
      `edits on ${spec.path}: matched ${ranges.length}, expected ${spec.expected_matches} (mode "${mode}").${locations}`,
    );
  }

  return { edit: spec, mode, ranges };
}

/**
 * Whole-line and delimiter-region replacements inherit the newline that ended the replaced region,
 * so replacing "line 2" never joins it to line 3 and replacing a block body never runs into the
 * closing delimiter. `exact` never reshapes: it replaces precisely what was asked for.
 */
function shapeReplacement(mode: EditMode, text: string, hit: Hit, spec: EditSpec): string {
  const replacement = spec.new ?? "";
  if (mode === "exact" || replacement.length === 0) return replacement;
  if (replacement.endsWith("\n")) return replacement;

  const regionText = text.slice(hit.start, hit.end);
  if (regionText.endsWith("\n")) return `${replacement}\n`;
  // Pure insertion: the range is empty, so it cannot inherit a newline from itself.
  if (mode === "lines" && hit.start === hit.end) return `${replacement}\n`;
  return replacement;
}
