import fs from "node:fs/promises";
import * as path from "node:path";
import type { QueryMatch, SyntaxNode } from "web-tree-sitter";
import { loadRequiredLanguageParsers } from "./language-parser.js";
import { parseFile } from "./parse-file.js";
import { SymbolContextResolver } from "./symbol-context-resolver.js";
import { formatLine } from "../tools/line-numbers.js";

export interface SymbolRange {
  startIndex: number;
  endIndex: number;
  startLine: number;
  nameText: string;
}

export interface GetFunctionsResult {
  formattedContent: string;
  foundNames: string[];
}

/**
 * Tree-sitter symbol location: file outlines, symbol bodies and symbol ranges.
 * Line numbers are 0-based rows internally and 1-based in rendered output.
 */
export class SymbolLocator {
  /** Compact outline of every definition in a file, numbered on request. */
  static async getFileSkeleton(
    absolutePath: string,
    options?: { showCallGraph?: boolean; lines?: boolean },
  ): Promise<string | null> {
    const languageParsers = await loadRequiredLanguageParsers([absolutePath]);
    const definitions = await parseFile(absolutePath, languageParsers, options);
    if (!definitions) return null;

    let formattedOutput = "";
    let lastLineAdded = -1;

    for (const def of definitions) {
      const startLine = def.lineIndex;

      if (lastLineAdded !== -1 && startLine > lastLineAdded + 1) formattedOutput += "|----\n";

      if (startLine > lastLineAdded) {
        formattedOutput += `${formatLine(startLine + 1, def.text, options?.lines)}\n`;
        lastLineAdded = startLine;

        if (options?.showCallGraph) {
          if (def.lineCount !== undefined) formattedOutput += `${def.indentation}    # Lines: ${def.lineCount}\n`;
          if (def.calls?.length) formattedOutput += `${def.indentation}    # Calls: [${def.calls.sort().join(", ")}]\n`;
        }
      }
    }

    return formattedOutput.length > 0 ? `|----\n${formattedOutput}|----\n` : null;
  }

  /** Full bodies of the requested symbols, preceded by their local context, numbered on request. */
  static async getFunctions(
    absolutePath: string,
    relPath: string,
    functionNames: string[],
    options?: { lines?: boolean; context?: number },
  ): Promise<GetFunctionsResult | null> {
    let languageParsers;
    try {
      languageParsers = await loadRequiredLanguageParsers([absolutePath]);
    } catch {
      return {
        formattedContent: `Unsupported file type: ${relPath}`,
        foundNames: [],
      };
    }

    const ext = path.extname(absolutePath).toLowerCase().slice(1);
    const { parser, query } = languageParsers[ext] || {};

    if (!parser || !query) {
      return {
        formattedContent: `Unsupported file type: ${relPath}`,
        foundNames: [],
      };
    }

    const fileContent = await fs.readFile(absolutePath, "utf8");
    let tree;
    try {
      tree = parser.parse(fileContent);
    } catch {
      return {
        formattedContent: `Could not parse file: ${relPath}`,
        foundNames: [],
      };
    }

    if (!tree?.rootNode) {
      return {
        formattedContent: `Could not parse file: ${relPath}`,
        foundNames: [],
      };
    }

    const matches = query.matches(tree.rootNode);
    const nodeToMatch = SymbolLocator.buildNodeToMatch(matches);
    const fileResults: string[] = [];
    const foundNamesInFile = new Set<string>();
    const seenRanges = new Set<string>();

    for (const match of matches) {
      const nameCapture = match.captures.find((capture) => capture.name.includes("name.definition"));
      const defCapture =
        match.captures.find((capture) => capture.name.startsWith("definition.")) ||
        match.captures.find((capture) => !capture.name.includes("name"));

      if (!nameCapture || !defCapture) continue;

      const nameText = fileContent.slice(nameCapture.node.startIndex, nameCapture.node.endIndex);
      const fullName = SymbolLocator.deriveFullName(nameText, defCapture.node, match, nodeToMatch, fileContent);
      const normalizedFullName = fullName.replace(/::/g, ".");
      const matchedReqNames = functionNames.filter((reqName) => {
        const normalizedReqName = reqName.replace(/::/g, ".");
        return normalizedFullName === normalizedReqName || normalizedFullName.endsWith(`.${normalizedReqName}`);
      });

      if (matchedReqNames.length === 0) continue;
      matchedReqNames.forEach((reqName) => foundNamesInFile.add(reqName));

      const { startIndex, endIndex, startLine } = SymbolLocator.getExtendedRange(defCapture.node, fileContent);
      const rangeKey = `${startIndex}-${endIndex}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);

      const bodyLines = fileContent.slice(startIndex, endIndex).split(/\r?\n/);
      const context = await SymbolContextResolver.resolve({
        node: defCapture.node,
        fileContent,
        parser,
        ext,
        lines: options?.lines,
        rootNode: tree.rootNode,
      });
      const surrounding = options?.context ?? 0;
      const fileLines = fileContent.split(/\r?\n/);
      const firstLine = Math.max(0, startLine - surrounding);
      const lastLine = Math.min(fileLines.length - 1, startLine + bodyLines.length - 1 + surrounding);
      const formatted = fileLines
        .slice(firstLine, lastLine + 1)
        .map((line, index) => formatLine(firstLine + index + 1, line, options?.lines))
        .join("\n");

      fileResults.push(`${relPath}::${fullName}\n${context}${formatted}`);
    }

    if (fileResults.length > 0) {
      return {
        formattedContent: fileResults.join("\n\n---\n\n"),
        foundNames: Array.from(foundNamesInFile),
      };
    }

    return {
      formattedContent: `None of the requested functions (${functionNames.join(", ")}) were found in ${relPath}`,
      foundNames: [],
    };
  }

  /** Replacement range of a single symbol. */
  static async getSymbolRange(absolutePath: string, symbol: string, type?: string): Promise<SymbolRange | null> {
    let languageParsers;
    try {
      languageParsers = await loadRequiredLanguageParsers([absolutePath]);
    } catch {
      return null;
    }

    const ext = path.extname(absolutePath).toLowerCase().slice(1);
    const { parser, query } = languageParsers[ext] || {};
    if (!parser || !query) return null;

    const fileContent = await fs.readFile(absolutePath, "utf8");
    let tree;
    try {
      tree = parser.parse(fileContent);
    } catch {
      return null;
    }
    if (!tree?.rootNode) return null;

    const matches = query.matches(tree.rootNode);
    const nodeToMatch = SymbolLocator.buildNodeToMatch(matches);
    const normalizedRequestedSymbol = symbol.replace(/::/g, ".");

    for (const match of matches) {
      const nameCapture = match.captures.find((capture) => capture.name.startsWith("name.definition"));
      const defCapture =
        match.captures.find((capture) => capture.name.startsWith("definition.")) ||
        match.captures.find((capture) => !capture.name.startsWith("name."));

      if (!nameCapture || !defCapture) continue;

      const nameText = fileContent.slice(nameCapture.node.startIndex, nameCapture.node.endIndex);
      const defType = defCapture.name.split(".").pop() || "";
      const fullName = SymbolLocator.deriveFullName(nameText, defCapture.node, match, nodeToMatch, fileContent);
      const normalizedFullName = fullName.replace(/::/g, ".");

      if (
        (normalizedFullName === normalizedRequestedSymbol || normalizedFullName.endsWith(`.${normalizedRequestedSymbol}`)) &&
        SymbolLocator.areTypesCompatible(defType, type)
      ) {
        const range = SymbolLocator.getExtendedRange(defCapture.node, fileContent);
        return {
          ...range,
          nameText,
        };
      }
    }

    return null;
  }

  private static buildNodeToMatch(matches: QueryMatch[]): Map<number, QueryMatch> {
    const nodeToMatch = new Map<number, QueryMatch>();
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith("name.")) nodeToMatch.set(capture.node.id, match);
        if (capture.name.startsWith("definition.")) nodeToMatch.set(capture.node.id, match);
      }
    }
    return nodeToMatch;
  }

  private static deriveFullName(
    nameText: string,
    definitionNode: SyntaxNode,
    match: QueryMatch,
    nodeToMatch: Map<number, QueryMatch>,
    fileContent: string,
  ): string {
    let fullName = nameText;
    let currentNode: SyntaxNode | null = definitionNode;
    const seenMatches = new Set<QueryMatch>([match]);

    while (currentNode.parent) {
      currentNode = currentNode.parent;
      const parentMatch = nodeToMatch.get(currentNode.id);
      if (parentMatch && !seenMatches.has(parentMatch)) {
        const parentNameCap = parentMatch.captures.find((capture) => capture.name.startsWith("name."));
        if (parentNameCap) {
          const parentNameText = fileContent.slice(parentNameCap.node.startIndex, parentNameCap.node.endIndex);
          fullName = `${parentNameText}.${fullName}`;
          seenMatches.add(parentMatch);
        }
      }
    }

    return fullName;
  }

  private static areTypesCompatible(defType: string, reqType?: string): boolean {
    if (!reqType) return true;
    if (defType === reqType) return true;
    const synonyms = ["function", "method"];
    return synonyms.includes(defType) && synonyms.includes(reqType);
  }

  private static getExtendedRange(
    targetNode: SyntaxNode,
    fileContent: string,
  ): { startIndex: number; endIndex: number; startLine: number } {
    let startIndex = targetNode.startIndex;
    let endIndex = targetNode.endIndex;
    let startLine = targetNode.startPosition.row;
    let currentNode = targetNode;
    const wrapperTypes = [
      "export_statement",
      "export_declaration",
      "ambient_declaration",
      "decorated_definition",
      "internal_module",
    ];

    while (currentNode.parent && wrapperTypes.includes(currentNode.parent.type)) {
      currentNode = currentNode.parent;
      startIndex = currentNode.startIndex;
      endIndex = currentNode.endIndex;
      startLine = currentNode.startPosition.row;
    }

    while (currentNode.previousNamedSibling) {
      const prev = currentNode.previousNamedSibling;
      if (
        prev.endPosition.row === startLine - 1 &&
        (prev.type === "comment" ||
          prev.type === "decorator" ||
          prev.type === "attribute" ||
          prev.type.includes("comment"))
      ) {
        startIndex = prev.startIndex;
        startLine = prev.startPosition.row;
        currentNode = prev;
      } else {
        break;
      }
    }

    startIndex = fileContent.lastIndexOf("\n", startIndex - 1) + 1;

    return { startIndex, endIndex, startLine };
  }
}
