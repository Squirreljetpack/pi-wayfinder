import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { formatNumberedLine, stripLineNumbers } from "../tools/line-numbers.js";
import { resolveReadPath } from "./paths.js";

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (buffer: Buffer) => boolean }> = [
  { mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", matches: (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a" },
  { mimeType: "image/webp", matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { mimeType: "image/bmp", matches: (b) => b.subarray(0, 2).toString("latin1") === "BM" },
];

const BINARY_SNIFF_BYTES = 8192;

function isImage(buffer: Buffer): boolean {
  return IMAGE_SIGNATURES.some((signature) => signature.matches(buffer));
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function binaryNotice(absolutePath: string, byteLength: number): string {
  return `[Binary file (${formatSize(byteLength)}), not shown: ${absolutePath}. Use bash to inspect its bytes]`;
}

function numberLines(content: string, startLineDisplay: number): string {
  if (content.length === 0) return "";
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  // CRLF files would otherwise show a trailing "\r" on every line, which models then copy into
  // edit payloads. The gutter already delimits lines, so the carriage return carries no content.
  return lines
    .map((line, index) => formatNumberedLine(startLineDisplay + index, line.endsWith("\r") ? line.slice(0, -1) : line))
    .join("\n");
}

/**
 * Numbers a text read exactly like pi's built-in read: same offset/limit semantics, same truncation
 * limits, same continuation notices, with a line-number gutter in front of every line.
 */
function readNumberedText(
  textContent: string,
  requestedPath: string,
  offset?: number,
  limit?: number,
): { text: string; truncation: ReturnType<typeof truncateHead> } {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;

  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }

  const userLimitedLines = limit !== undefined ? Math.min(startLine + limit, allLines.length) - startLine : undefined;
  const selectedContent =
    limit !== undefined ? allLines.slice(startLine, startLine + limit).join("\n") : allLines.slice(startLine).join("\n");
  const truncation = truncateHead(selectedContent);

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
    return {
      text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${requestedPath} | head -c ${DEFAULT_MAX_BYTES}]`,
      truncation,
    };
  }

  const body = numberLines(truncation.content, startLineDisplay);

  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const limitLabel =
      truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
    return {
      text: `${body}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitLabel}. Use offset=${nextOffset} to continue.]`,
      truncation,
    };
  }

  if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return { text: `${body}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`, truncation };
  }

  return { text: body, truncation };
}

export function registerReadTool(pi: ExtensionAPI): void {
  const definitions = new Map<string, ReturnType<typeof createReadToolDefinition>>();
  const definitionFor = (cwd: string): ReturnType<typeof createReadToolDefinition> => {
    const existing = definitions.get(cwd);
    if (existing) return existing;
    const created = createReadToolDefinition(cwd);
    definitions.set(cwd, created);
    return created;
  };

  const base = definitionFor(process.cwd());

  pi.registerTool({
    ...base,
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Text output is prefixed with a line-number gutter (${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, whichever is hit first) and can be used directly with edit's lines mode. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
      "Every line of read output starts with its line number; use those numbers with edit's lines mode.",
    ],
    renderResult(result, options, theme, context) {
      const text = result.content.find((block) => block.type === "text");
      const numbered = text && "text" in text ? stripLineNumbers(text.text) : undefined;
      const stripped =
        numbered === undefined || !text
          ? result
          : { ...result, content: result.content.map((block) => (block === text ? { ...text, text: numbered } : block)) };
      return base.renderResult!(stripped as Parameters<NonNullable<typeof base.renderResult>>[0], options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const builtin = definitionFor(ctx.cwd);
      const absolutePath = await resolveReadPath(params.path, ctx.cwd);
      const buffer = await readFile(absolutePath);

      if (isImage(buffer)) {
        return builtin.execute(toolCallId, { ...params, path: absolutePath }, signal, onUpdate, ctx);
      }

      if (isBinary(buffer)) {
        const text = binaryNotice(params.path, buffer.byteLength);
        return { content: [{ type: "text" as const, text }], structuredContent: text, details: undefined };
      }

      const { text, truncation } = readNumberedText(buffer.toString("utf-8"), params.path, params.offset, params.limit);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: text,
        details: truncation ? { truncation } : undefined,
      };
    },
  });
}
