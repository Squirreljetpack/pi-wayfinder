import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pruneHistory, type PruneReport } from "../history/prune.js";

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Reads the command argument: nothing, a duration (`7d`, `12h`, `30m`), a date (`2026-10-01`), or
 * `all`. A duration means "older than that long ago"; a date means "created before that moment".
 */
export function parsePruneCutoff(input: string, now = Date.now()): number | undefined {
  const text = input.trim();
  if (text.length === 0) return undefined;
  if (text.toLowerCase() === "all") return now;

  const relative = /^(\d+)\s*([mhdw])$/i.exec(text);
  if (relative) {
    const unit = UNITS[relative[2].toLowerCase()];
    return now - Number(relative[1]) * unit;
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot read '${text}' as a duration (30m, 12h, 7d, 2w), a date, or "all"`);
  }
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function ageLabel(olderThan: number | undefined): string {
  if (olderThan === undefined) return "";
  return ` older than ${new Date(olderThan).toISOString().slice(0, 16).replace("T", " ")}`;
}

function describePaths(paths: string[]): string {
  if (paths.length === 0) return "";
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

function confirmMessage(plan: PruneReport, olderThan: number | undefined): string {
  const lines = [`Prune ${plan.commitsBefore} recorded transactions?`];
  if (plan.missingPaths.length > 0) {
    lines.push(
      "",
      `• ${plan.missingPaths.length} file${plan.missingPaths.length === 1 ? "" : "s"} no longer exist: ${describePaths(plan.missingPaths)}`,
      `  their records are removed from ${plan.prunedEntries} entr${plan.prunedEntries === 1 ? "y" : "ies"}`,
    );
  }
  if (plan.droppedByAge > 0) lines.push(`• ${plan.droppedByAge} transaction${plan.droppedByAge === 1 ? "" : "s"}${ageLabel(olderThan)} are dropped`);
  if (plan.droppedEmpty > 0) {
    lines.push(`• ${plan.droppedEmpty} transaction${plan.droppedEmpty === 1 ? "" : "s"} would be left with no records and are dropped`);
  }
  lines.push(
    "",
    `${plan.commitsBefore} → ${plan.commitsAfter} transactions. Surviving transactions get new ids, so ids quoted in earlier transcripts stop resolving. This cannot be undone.`,
  );
  return lines.join("\n");
}

export function summarizePrune(report: PruneReport): string {
  const parts = [`${report.commitsBefore} → ${report.commitsAfter} transactions`];
  if (report.droppedByAge > 0) parts.push(`${report.droppedByAge} dropped by age`);
  if (report.droppedEmpty > 0) parts.push(`${report.droppedEmpty} emptied`);
  if (report.missingPaths.length > 0) parts.push(`${report.missingPaths.length} missing files scrubbed`);
  const tail = report.reclaimedBytes > 0 ? ` Reclaimed ${formatBytes(report.reclaimedBytes)}.` : "";
  const head =
    report.headAfter === null
      ? " History is now empty."
      : report.headBefore !== report.headAfter
        ? ` Head ${report.headBefore?.slice(0, 8) ?? "none"} → ${report.headAfter.slice(0, 8)}.`
        : "";
  return `Pruned: ${parts.join(", ")}.${head}${tail}`;
}

export function registerPruneRewindCommand(pi: ExtensionAPI): void {
  pi.registerCommand("prune-rewind", {
    description: "Scrub history for deleted files, optionally dropping transactions older than a time",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Pruning file history needs interactive mode.", "error");
        return;
      }

      try {
        const olderThan = parsePruneCutoff(args);
        const plan = await pruneHistory({ olderThan, dryRun: true });

        if (plan.commitsBefore === 0) {
          ctx.ui.notify("No file history to prune.", "info");
          return;
        }
        if (plan.droppedByAge === 0 && plan.droppedEmpty === 0 && plan.prunedEntries === 0) {
          ctx.ui.notify("Nothing to prune: every recorded file still exists.", "info");
          return;
        }

        const confirmed = await ctx.ui.confirm("Prune file history", confirmMessage(plan, olderThan));
        if (!confirmed) {
          ctx.ui.notify("Pruning cancelled.", "info");
          return;
        }

        const report = await pruneHistory({ olderThan });
        ctx.ui.notify(summarizePrune(report), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
