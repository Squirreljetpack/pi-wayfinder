# pi-wayfinder

Structure-aware code navigation and transactional editing tools for pi agents.

A fork of [pi-wayfinder](https://github.com/deevus/pi-wayfinder) that keeps its tree-sitter half and
replaces the anchor-based editing half with three ways to name a region that need no state: the
exact text, a pair of delimiters, or line numbers. Every edit is validated before anything is
written, count-verified, and recorded as one commit in a git-backed file history, so any change can
be undone — by the agent or from `/rewind`.

## Tools

| Tool | What it does |
| --- | --- |
| `edit` | One transactional call, many edits, many files. Modes `exact`, `between`, `lines`. Replaces the built-in `edit`. |
| `rewind` | Browses the recorded file history per file and undoes or restores a transaction's changes. |
| `get_file_skeleton` | Compact outline of functions, classes, methods and exports. `lines: true` numbers every line. |
| `get_function` | Full bodies of the requested symbols with their local imports and class context. `lines: true` numbers every line. |
| `replace_symbol` | Replace a whole function/method/class/interface by tree-sitter range; `text: ""` deletes it. |
| `insert_symbol` | Insert code before or after a named symbol, doc comment included. |
| `find_symbol_references` | Exact tree-sitter definitions and references across paths. |
| `rename_symbol` | Rename definitions and references together across files. |

## Editing

`edit` takes `edits[]`, each naming its own `path`, so one call can rewrite a whole refactor step:

```json
{
  "edits": [
    { "path": "src/a.ts", "mode": "exact", "old": "const retries = 3;", "new": "const retries = 5;", "expected_matches": 1 },
    { "path": "src/b.ts", "mode": "between", "start": "export function run() {", "end": "\n}", "new": "\n  return start();" },
    { "path": "src/c.ts", "mode": "lines", "start_line": 12, "end_line": 14, "new": "  const value = compute();" }
  ]
}
```

- **exact** replaces every occurrence of `old`. `expected_matches` aborts the whole call when the
  count differs; `0` asserts the text is absent.
- **between** replaces what lies between `start` and `end`. Use it when the region is large enough
  that retyping it is pointless. `include_delimiters: true` replaces the delimiters too; adjacent
  delimiters with `new` text insert.
- **lines** replaces whole lines from `start_line` to `end_line` (inclusive, defaulting to
  `start_line`). `end_line = start_line - 1` inserts before `start_line`. Numbers come from
  `get_file_skeleton` / `get_function` with `lines: true`, or from `bash: grep -n`.

Every edit is matched against the original file, never against an earlier edit in the same call.
Overlapping ranges are an error. Any failing edit aborts the call before the first byte is written,
and a failure during the write phase restores the files already written.

Line-number gutters copied from `get_file_skeleton` or `get_function` output (`lines: true`) are
stripped from replacement text, so pasting numbered lines cannot inject the gutter into a file.

### File history

Every successful edit returns a transaction id, which is the id of the commit that records it:

```
Updated 2 files: 5 edits, 7 replacements.
  src/a.ts: 3 edits, 5 replacements
  src/b.ts: 2 edits, 2 replacements
Transaction ac666590a66f — undo with rewind({ id: "ac666590a66f", mode: "undo" })
```

`rewind` is the tool for reading and using that history:

| Call | Result |
| --- | --- |
| `rewind({})` | files with recorded history in the working directory, with version counts |
| `rewind({ path })` | that file's versions: id, time, `+added -deleted`, subject |
| `rewind({ id })` / `mode: "show"` | the diff the transaction applied |
| `rewind({ id, mode: "preview" })` | the file as of that transaction, numbered |
| `rewind({ id, mode: "undo" })` | revert the change, patching around edits that landed afterwards |
| `rewind({ id, mode: "restore" })` | set the files to their content at that transaction |

`id: "last"` means the newest transaction in the working directory. Undo refuses, and writes
nothing, when the changed lines no longer match; restore overwrites. Both are recorded as their own
transaction, so the opposite mode reverses them.

`/rewind` is the same history for a human: pick a file, pick a version (timestamp and `+n -n`),
confirm against a diff preview, and the file is restored.

### Where the history lives

One bare git repository holds every project:

```
~/.cache/pi-wayfinder/history.git          # $PI_WAYFINDER_HOME overrides the directory
```

An absolute path maps onto the tree without its leading slash, so `/home/me/app/a.ts` is
`home/me/app/a.ts` in the repository, and `git show <id>:home/me/app/a.ts` is that file at that
transaction. Each commit also stores the bytes each touched file had beforehand under
`.pi-wayfinder/<path>`, so undo works for the very first transaction that touched a file and does
not depend on what the parent commit recorded.

The commit message carries the session id, session directory, working directory and the list of
files, which is what makes a transaction traceable back to the conversation that produced it.
Objects are compressed at level 9 and `git gc --auto` runs after each commit.

Concurrent sessions never share a worktree: blobs are written with `hash-object`, the tree is
assembled in a private index, and the branch advances with a compare-and-swap `update-ref`. A
transaction that loses the race rebuilds on the new parent; if another session changed one of the
same files in the meantime, the call fails before writing anything and tells you to re-read the file.

Inspect it with plain git:

```bash
git --git-dir ~/.cache/pi-wayfinder/history.git log --oneline -20
git --git-dir ~/.cache/pi-wayfinder/history.git show --stat <id>
git --git-dir ~/.cache/pi-wayfinder/history.git log -p -- home/me/app/a.ts
```

## Install

```bash
pi install git:github.com/Squirreljetpack/pi-wayfinder
```

For local development:

```bash
pi -e .
```

This package registers a tool named `edit`, so it cannot be enabled alongside the original
`pi-wayfinder` (pi rejects two extensions that register the same tool). Remove one.

There are no flags and no modes: the extension always replaces `edit`.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
```

The tree-sitter query assets and several tools are adapted from
[Dirac](https://github.com/dirac-run/dirac) via pi-wayfinder; see `NOTICE`.

`PLAN.md` documents the architecture and the per-milestone implementation log.
