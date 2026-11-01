# pi-wayfinder

Structure-aware code navigation and transactional editing tools for pi agents.

A fork of [pi-wayfinder](https://github.com/deevus/pi-wayfinder) that keeps its tree-sitter half and
replaces the anchor-based editing half with three ways to name a region that need no state: the
exact text, a pair of delimiters, or line numbers. Every edit is validated before anything is
written, count-verified, and recorded in a transaction log that can be rolled back.

## Tools

| Tool | What it does |
| --- | --- |
| `read` | pi's `read` with a line-number gutter on every line (images and binary files unchanged). Replaces the built-in `read`. |
| `edit` | One transactional call, many edits, many files. Modes `exact`, `between`, `lines`. Replaces the built-in `edit`. |
| `rollback` | Restores the files a previous `edit` changed, from the transaction log. |
| `get_file_skeleton` | Compact outline of functions, classes, methods and exports, with line numbers. |
| `get_function` | Full bodies of the requested symbols, numbered, with their local imports and class context. |
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
  `start_line`). `end_line = start_line - 1` inserts before `start_line`.

Every edit is matched against the original file, never against an earlier edit in the same call.
Overlapping ranges are an error. Any failing edit aborts the call before the first byte is written,
and a failure during the write phase restores the files already written.

Line-number gutters copied from `read` output are stripped from replacement text, so pasting
numbered lines cannot inject the gutter into a file.

### Rollback

Every successful edit returns a transaction id:

```
Updated 2 files: 5 edits, 7 replacements.
  src/a.ts: 3 edits, 5 replacements
  src/b.ts: 2 edits, 2 replacements
Transaction m3k9x2-4f1a9c — undo with rollback({ transaction_id: "m3k9x2-4f1a9c" })
```

`rollback({ transaction_id })` (or `"last"`) restores the exact bytes from before that transaction.
It refuses when a file changed afterwards unless `force: true`, and it records itself as a
transaction, so a mistaken rollback can be rolled back.

The log is a SQLite database at `~/.cache/pi-wayfinder/history.db` (`$PI_WAYFINDER_HOME` overrides
the directory), scoped per repository by its `cwd` column and capped at 500 transactions / 128 MB:

```bash
sqlite3 ~/.cache/pi-wayfinder/history.db \
  "select t.id, datetime(t.created_at/1000,'unixepoch'), t.kind, c.path
     from txn t join change c on c.txn_id = t.id
    order by t.rowid desc limit 20"
```

## Install

```bash
pi install git:github.com/Squirreljetpack/pi-wayfinder
```

For local development:

```bash
pi -e .
```

This package registers tools named `edit` and `read`, so it cannot be enabled alongside the
original `pi-wayfinder` (pi rejects two extensions that register the same tool). Remove one.

There are no flags, no modes and no slash commands: the extension always replaces `read` and `edit`.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
```

The tree-sitter query assets and several tools are adapted from
[Dirac](https://github.com/dirac-run/dirac) via pi-wayfinder; see `NOTICE`.

`PLAN.md` documents the architecture and the per-milestone implementation log.
