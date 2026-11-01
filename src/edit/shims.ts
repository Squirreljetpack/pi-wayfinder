import type { Static } from "typebox";
import type { EditSchema } from "../tools/schemas.js";

type EditParams = Static<typeof EditSchema>;

/**
 * Argument shims for models that call this tool with pi's built-in edit shape.
 *
 * The harness validates parameters before routing them to `execute`, so normalising has to happen
 * in `prepareArguments`. Everything here rewrites the *shape* only; mode validation stays in
 * `validateEdit`.
 */
export function normalizeEditArguments(args: unknown): EditParams {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args as EditParams;

  const input = { ...(args as Record<string, unknown>) };

  // `edits` sent as a JSON string instead of an array.
  if (typeof input.edits === "string") {
    try {
      input.edits = JSON.parse(input.edits);
    } catch {
      // Leave it untouched: execute() reports "Missing required parameter: edits".
    }
  }

  // A single edit object instead of a one-element array.
  if (input.edits && typeof input.edits === "object" && !Array.isArray(input.edits)) {
    input.edits = [input.edits];
  }

  // A legacy flat { path, oldText, newText } call.
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    const flat: Record<string, unknown> = { old: input.oldText, new: input.newText };
    if (typeof input.path === "string") flat.path = input.path;
    delete input.oldText;
    delete input.newText;
    delete input.path;
    input.edits = [...(Array.isArray(input.edits) ? input.edits : []), flat];
  }

  if (!Array.isArray(input.edits)) return input as unknown as EditParams;

  const parentPath = typeof input.path === "string" ? input.path : undefined;
  let pathPushedDown = false;

  input.edits = input.edits.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const edit = { ...(raw as Record<string, unknown>) };

    if (edit.path === undefined && parentPath !== undefined) {
      edit.path = parentPath;
      pathPushedDown = true;
    }
    if (typeof edit.oldText === "string" && edit.old === undefined) edit.old = edit.oldText;
    if (typeof edit.newText === "string" && edit.new === undefined) edit.new = edit.newText;
    delete edit.oldText;
    delete edit.newText;
    if (edit.mode === undefined && edit.old !== undefined) edit.mode = "exact";

    return edit;
  });

  if (pathPushedDown) delete input.path;
  return input as unknown as EditParams;
}
