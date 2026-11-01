export function getWayfinderPromptGuidance(): string {
	return `
## Wayfinder source editing

Explore before reading:
1. Start with get_file_skeleton to map functions, classes, methods, and exports, with line numbers, without reading the whole file.
2. Use get_function next for the specific definitions you need, with their local imports and class context.
3. Use read for narrow line ranges, non-symbol context, small/config files, or when skeleton/function output is insufficient; it prints raw file text.
4. Pass lines: true to get_file_skeleton or get_function when you need line numbers; the gutter is only printed on request. Those numbers are details of the tool output, never part of the file, and they are what lines mode refers to. For a region no tool numbered, get the numbers with bash: grep -n.

Editing:
- Prefer replace_symbol for whole functions, methods, classes, interfaces, or exported const/arrow functions: it replaces the tree-sitter range, doc comment included.
- replace_symbol with text: "" deletes a symbol. It refuses while references survive unless force is true.
- Use insert_symbol to add sibling/helper code next to a named symbol: position 'before' places code above the definition including its doc comment, 'after' below the closing token.
- Use edit for everything else. Choose the mode that costs least to describe:
  - "exact" for small changes: old is matched against the file and every occurrence is replaced. Pass expected_matches when the count matters.
  - "between" when the region is large: name it with its surrounding delimiters instead of retyping it, and set include_delimiters to replace those delimiters too.
  - "lines" when you already read the file in this session and know the line numbers.
- Batch all edits for a task into one edit call; entries may span multiple files. Edits are matched against the original file, so do not compensate for edits made earlier in the same call.
- Every write (edit, replace_symbol, insert_symbol, rename_symbol) returns a transaction id. If one went wrong, do not hand-repair it: rewind({ id, mode: "show" }) shows what it changed, mode "undo" reverts it, mode "restore" puts the files back to that transaction's version.
- rewind({}) lists files with recorded history in the working directory and rewind({ path }) lists one file's versions, so you can also walk further back than the last edit.

Symbol navigation:
- Use find_symbol_references to inspect exact AST definitions and references before broad rename work.
- Use rename_symbol for exact symbol renames across files or directories; it renames definitions and references together.
- Tool output lines carry a line-number gutter. The gutter is stripped from replacement text if pasted, but do not add it deliberately.
`;
}
