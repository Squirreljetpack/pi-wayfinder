/**
 * Model-facing line gutter: `12│const x = 1;`
 *
 * The separator is the box-drawing character rather than `|` or `:` so a copied gutter can be
 * stripped again without mistaking ordinary content (`8080: host`) for one.
 */
export const LINE_NUMBER_SEPARATOR = "│";

export function formatNumberedLine(lineNumber: number, content: string): string {
  return `${lineNumber}${LINE_NUMBER_SEPARATOR}${content}`;
}

const NUMBERED_LINE_PREFIX = /^\s*\d+│/;

/** Drops a copied gutter from model-provided text, one line at a time. */
export function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(NUMBERED_LINE_PREFIX, ""))
    .join("\n");
}

/** Numbered or raw, depending on whether the caller asked for line numbers. */
export function formatLine(lineNumber: number, content: string, numbered: boolean | undefined): string {
  return numbered ? formatNumberedLine(lineNumber, content) : content;
}
