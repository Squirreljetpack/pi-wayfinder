import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { appendTransaction, getTransaction, recentTransactionIds } from "./db.js";
import { sha256, withFileMutationQueues } from "../edit/snapshot.js";
import { combineDiffs, createPiDiff, type DiffDetails } from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderDiffResult } from "../rendering/pi-renderers.js";
import { RollbackSchema } from "../tools/schemas.js";

export interface RollbackToolDetails {
  transactionId: string;
  rollsBack: string;
  files: string[];
  diffs: DiffDetails[];
  diff: string;
  firstChangedLine?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRollbackTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rollback",
    label: "Rollback",
    description:
      "Restore the files a previous edit changed, using the snapshots recorded in the transaction log. Refuses when a file changed after that edit unless force is true.",
    promptSnippet: "Restore a previous edit transaction instead of hand-repairing a bad edit",
    promptGuidelines: [
      'Every edit returns a transaction id; rollback({ transaction_id }) puts those files back exactly as they were.',
      'transaction_id: "last" targets the most recent edit in this repository.',
      "A rollback is recorded as its own transaction, so a mistaken rollback can be rolled back too.",
    ],
    parameters: RollbackSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    renderCall(args, theme) {
      return renderCodeLikeCall("rollback", [], theme, typeof args.transaction_id === "string" ? theme.fg("dim", ` (${args.transaction_id})`) : "");
    },
    renderResult(result, options, theme, context) {
      return renderDiffResult(result as never, options, theme, context, "Rolling back");
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const transactionId = params.transaction_id;
      if (typeof transactionId !== "string" || transactionId.length === 0) {
        throw new Error("Missing required parameter: transaction_id");
      }
      const force = params.force === true;

      const transaction = await getTransaction(transactionId, ctx.cwd).catch((error) => {
        throw new Error(`Cannot read the transaction log: ${messageOf(error)}`);
      });
      if (!transaction) {
        const recent = await recentTransactionIds(ctx.cwd).catch(() => []);
        const hint = recent.length > 0 ? `\nRecent transactions in this repository: ${recent.join(", ")}` : "";
        throw new Error(`Transaction ${transactionId} not found.${hint}`);
      }
      if (signal?.aborted) throw signal.reason ?? new Error("rollback aborted");

      const current = await Promise.all(
        transaction.changes.map(async (change) => {
          try {
            const bytes = await readFile(change.absolutePath);
            return { change, bytes };
          } catch {
            return { change, bytes: null };
          }
        }),
      );

      const drifted = current.filter(({ change, bytes }) => bytes === null || sha256(bytes) !== change.afterSha);
      if (drifted.length > 0 && !force) {
        const list = drifted
          .map(({ change, bytes }) =>
            bytes === null
              ? `  ${change.path}: missing`
              : `  ${change.path}: expected ${change.afterSha.slice(0, 8)}, found ${sha256(bytes).slice(0, 8)}`,
          )
          .join("\n");
        throw new Error(
          `${drifted.length} file(s) changed after transaction ${transaction.id}, refusing to roll back:\n${list}\n\nPass force: true to overwrite them anyway.`,
        );
      }

      const undoChanges = current
        .filter(({ bytes }) => bytes !== null)
        .map(({ change, bytes }) => ({ path: change.path, absolutePath: change.absolutePath, before: bytes as Buffer, afterSha: sha256(change.before) }));

      const undoneTransactionId = await appendTransaction({
        cwd: ctx.cwd,
        kind: "rollback",
        rollsBack: transaction.id,
        summary: `rollback of ${transaction.id} (${transaction.changes.length} file(s))`,
        changes: undoChanges,
      });

      const diffs: DiffDetails[] = [];
      for (const { change, bytes } of current) {
        const before = bytes === null ? "" : bytes.toString("utf-8");
        const after = change.before.toString("utf-8");
        diffs.push({ path: change.path, ...createPiDiff(before, after) });
      }

      await withFileMutationQueues(
        current.map(({ change }) => change.absolutePath),
        async () => {
          for (const { change } of current) {
            await writeFile(change.absolutePath, change.before);
          }
        },
      );

      const fileLabel = transaction.changes.length === 1 ? "file" : "files";
      const text = [
        `Restored ${transaction.changes.length} ${fileLabel} from transaction ${transaction.id}.`,
        ...diffs.filter((diff) => diff.diff.length > 0).map((diff) => `  ${diff.path}`),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          transactionId: undoneTransactionId ?? "",
          rollsBack: transaction.id,
          files: transaction.changes.map((change) => change.path),
          diffs: diffs.filter((diff) => diff.diff.length > 0),
          diff: combineDiffs(diffs),
          firstChangedLine: diffs[0]?.firstChangedLine,
        } satisfies RollbackToolDetails,
      };
    },
  });
}
