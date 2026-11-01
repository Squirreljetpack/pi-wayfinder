import { Type } from "typebox";

export const EditSchema = Type.Object({
	edits: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("exact"), Type.Literal("between"), Type.Literal("lines")], {
					description:
						'How the region is named: "exact" text, "between" delimiters, "lines" line numbers. Defaults to "exact" when old is set, otherwise required',
				}),
			),
			expected_matches: Type.Optional(
				Type.Integer({
					minimum: 0,
					description:
						"Abort the whole call unless this edit matches exactly this many times",
				}),
			),
			old: Type.Optional(
				Type.String({
					description: 'mode "exact": the text to find; every occurrence is replaced',
				}),
			),
			new: Type.Optional(
				Type.String({ description: 'Replacement text; "" deletes the region' }),
			),
			start: Type.Optional(
				Type.String({
					description: 'mode "between": delimiter that opens the region',
				}),
			),
			end: Type.Optional(
				Type.String({
					description: 'mode "between": delimiter that closes the region',
				}),
			),
			include_delimiters: Type.Optional(
				Type.Boolean({
					description:
						'mode "between": also replace the delimiters themselves (default: keep them)',
				}),
			),
			start_line: Type.Optional(
				Type.Integer({ minimum: 1, description: 'mode "lines": 1-indexed first line' }),
			),
			end_line: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						'mode "lines": last line, inclusive; omit to target start_line only; pass start_line - 1 to insert before it',
				}),
			),
		}),
	),
});

export const RewindSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"File to look at, relative to the working directory; omit to list every file with recorded history",
		}),
	),
	id: Type.Optional(
		Type.String({
			description:
				'Transaction id from a tool result or a rewind listing, or "last" for the newest transaction in the working directory',
		}),
	),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("show"),
				Type.Literal("preview"),
				Type.Literal("undo"),
				Type.Literal("restore"),
			],
			{
				description:
					'show: what the transaction changed; preview: the file at that transaction; undo: revert the change; restore: set the files to that transaction. Requires id; defaults to "show"',
			},
		),
	),
});

export const GetFileSkeletonSchema = Type.Object({
	paths: Type.Array(
		Type.String({ description: "Relative or absolute source file paths" }),
	),
	lines: Type.Optional(
		Type.Boolean({
			description: "Prefix each output line with its line number, for use with edit's lines mode",
		}),
	),
});

export const GetFunctionSchema = Type.Object({
	paths: Type.Array(
		Type.String({ description: "Relative or absolute source file paths" }),
	),
	function_names: Type.Array(
		Type.String({ description: "Function, class, or method names to read" }),
	),
	lines: Type.Optional(
		Type.Boolean({
			description: "Prefix each output line with its line number, for use with edit's lines mode",
		}),
	),
	context: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 200,
			description: "Extra lines to print before and after each symbol body",
		}),
	),
});

export const ReplaceSymbolSchema = Type.Object({
	replacements: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			symbol: Type.String({
				description: "Dot-separated symbol path or suffix to replace; a suffix that matches several different symbols is refused with the candidates",
			}),
			text: Type.String({
				description: "Complete replacement source for the symbol",
			}),
			type: Type.Optional(
				Type.String({
					description:
						"Only match this kind of definition (function, method, class, interface), for when two definitions share a name",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Delete even when references to the symbol survive (text: \"\" only)",
				}),
			),
		}),
	),
});

export const InsertSymbolSchema = Type.Object({
	insertions: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			symbol: Type.String({
				description:
					"Dot-separated symbol path or suffix to insert adjacent to; a suffix that matches several different symbols is refused with the candidates",
			}),
			position: Type.Union([Type.Literal("before"), Type.Literal("after")], {
				description: "Insert before or after the symbol definition",
			}),
			text: Type.String({ description: "Code to insert" }),
			type: Type.Optional(
				Type.String({
					description:
						"Only match this kind of definition (function, method, class, interface), for when two definitions share a name",
				}),
			),
		}),
	),
});

export const FindSymbolReferencesSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			description: "Relative or absolute files/directories to search",
		}),
	),
	symbols: Type.Array(
		Type.String({ description: "Exact symbol names to find" }),
	),
	context: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 200,
			description: "Lines to print before and after each hit, like grep -C",
		}),
	),
	find_type: Type.Optional(
		Type.Union([Type.Literal("definition"), Type.Literal("reference"), Type.Literal("both")], {
			description: '"definition", "reference", or "both" (default)',
		}),
	),
});

export const RenameSymbolSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			description: "Relative or absolute files/directories to rename within",
		}),
	),
	existing_symbol: Type.String({ description: "Exact symbol text to rename" }),
	new_symbol: Type.String({ description: "Replacement symbol text" }),
});
