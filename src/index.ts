import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPruneRewindCommand } from "./commands/prune-rewind.js";
import { registerRewindCommand } from "./commands/rewind.js";
import { registerEditTool } from "./edit/tool.js";
import { getWayfinderPromptGuidance } from "./prompt.js";
import { SymbolCache } from "./symbols/symbol-cache.js";
import { SymbolScanner } from "./symbols/symbol-scanner.js";
import { registerFindSymbolReferencesTool } from "./tools/find-symbol-references.js";
import { registerGetFileSkeletonTool } from "./tools/get-file-skeleton.js";
import { registerGetFunctionTool } from "./tools/get-function.js";
import { registerInsertSymbolTool } from "./tools/insert-symbol.js";
import { registerRenameSymbolTool } from "./tools/rename-symbol.js";
import { registerReplaceSymbolTool } from "./tools/replace-symbol.js";
import { registerRewindTool } from "./tools/rewind.js";

export default function wayfinderExtension(pi: ExtensionAPI): void {
	const symbolCache = new SymbolCache();
	const symbolScanner = new SymbolScanner(symbolCache);

	registerEditTool(pi);
	registerRewindTool(pi);
	registerRewindCommand(pi);
	registerPruneRewindCommand(pi);
	registerGetFileSkeletonTool(pi);
	registerGetFunctionTool(pi);
	registerReplaceSymbolTool(pi, symbolScanner);
	registerInsertSymbolTool(pi);
	registerFindSymbolReferencesTool(pi, symbolScanner);
	registerRenameSymbolTool(pi, symbolScanner);

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${getWayfinderPromptGuidance()}`,
		};
	});

	pi.on("session_start", async () => {
		symbolCache.clear();
	});
}
