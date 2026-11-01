import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file gets its own transaction log; tests must never write to the real cache.
process.env.PI_WAYFINDER_HOME = mkdtempSync(join(tmpdir(), "pi-wayfinder-history-"));
