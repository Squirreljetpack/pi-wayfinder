import { stripLineNumbers } from "../tools/line-numbers.js";
import { lineOf, type ResolvedEdit } from "./resolve.js";

/**
 * Splices every resolved range into one new document.
 *
 * All ranges are computed against the original text, so they never see each other's output; that
 * makes overlap a hard error rather than a merge problem.
 */
export function applyRanges(text: string, ranges: ResolvedEdit[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.start < previous.end) {
      throw new Error(
        `Overlapping edits: one range covers line ${lineOf(text, previous.start)}-${lineOf(text, Math.max(previous.start, previous.end - 1))}, another starts on line ${lineOf(text, current.start)}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let next = text;
  for (let index = sorted.length - 1; index >= 0; index--) {
    const range = sorted[index];
    next = next.slice(0, range.start) + stripLineNumbers(range.text) + next.slice(range.end);
  }
  return next;
}
