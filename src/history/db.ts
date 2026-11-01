import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryChange {
  path: string;
  absolutePath: string;
  before: Buffer;
  afterSha: string;
}

export interface HistoryTransaction {
  id: string;
  createdAt: number;
  cwd: string;
  kind: "edit" | "rollback";
  rollsBack: string | null;
  summary: string;
  changes: HistoryChange[];
}

interface TransactionRow {
  id: string;
  created_at: number;
  cwd: string;
  kind: string;
  rolls_back: string | null;
  summary: string;
}

interface ChangeRow {
  path: string;
  abs: string;
  before: Uint8Array;
  after_sha: string;
}

const MAX_TRANSACTIONS = 500;
const MAX_BYTES = 128 * 1024 * 1024;

type SqliteModule = typeof import("node:sqlite");

let connection: import("node:sqlite").DatabaseSync | undefined;

export function historyDbPath(): string {
  const home = process.env.PI_WAYFINDER_HOME ?? join(homedir(), ".cache", "pi-wayfinder");
  return join(home, "history.db");
}

/**
 * `node:sqlite` prints an ExperimentalWarning to stderr the first time it is imported. A stray
 * stderr write can corrupt pi's alternate screen, so exactly that warning is suppressed while the
 * module loads and every other warning passes through untouched.
 */
function loadSqlite(): SqliteModule {
  const original = process.emitWarning;
  process.emitWarning = function silenced(warning: string | Error, ...rest: unknown[]): void {
    const text = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (/SQLite is an experimental feature/i.test(text)) return;
    (original as unknown as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    // getBuiltinModule resolves the builtin at runtime, so bundlers and test runners never try to
    // resolve "node:sqlite" themselves.
    return process.getBuiltinModule("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

async function open(): Promise<import("node:sqlite").DatabaseSync> {
  if (connection) return connection;

  const { DatabaseSync } = loadSqlite();
  const dbPath = historyDbPath();
  await mkdir(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  // busy_timeout must be set before switching the journal mode, otherwise two processes opening
  // the database at the same time fail outright with SQLITE_BUSY instead of waiting.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS txn (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      cwd        TEXT NOT NULL,
      kind       TEXT NOT NULL,
      rolls_back TEXT,
      summary    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change (
      txn_id    TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
      path      TEXT NOT NULL,
      abs       TEXT NOT NULL,
      before    BLOB NOT NULL,
      after_sha TEXT NOT NULL,
      PRIMARY KEY (txn_id, path)
    );
  `);

  connection = db;
  return db;
}

export function resetHistoryConnection(): void {
  connection?.close();
  connection = undefined;
}

function newTransactionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Records a transaction before its files are touched, in one immediate transaction.
 * Returns null when the history database is unavailable; editing must still work then.
 */
export async function appendTransaction(input: {
  cwd: string;
  kind: "edit" | "rollback";
  rollsBack?: string;
  summary: string;
  changes: Array<{ path: string; absolutePath: string; before: Buffer; afterSha: string }>;
}): Promise<string | null> {
  try {
    const db = await open();
    const id = newTransactionId();

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO txn (id, created_at, cwd, kind, rolls_back, summary) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        Date.now(),
        input.cwd,
        input.kind,
        input.rollsBack ?? null,
        input.summary,
      );
      const insertChange = db.prepare("INSERT INTO change (txn_id, path, abs, before, after_sha) VALUES (?, ?, ?, ?, ?)");
      for (const change of input.changes) {
        insertChange.run(id, change.path, change.absolutePath, new Uint8Array(change.before), change.afterSha);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing usable to recover here; the caller treats the whole record as failed.
      }
      throw error;
    }

    await prune(db);
    return id;
  } catch {
    return null;
  }
}

export async function getTransaction(id: string, cwd: string): Promise<HistoryTransaction | null> {
  const db = await open();
  const row =
    id === "last"
      ? (db.prepare("SELECT * FROM txn WHERE cwd = ? ORDER BY rowid DESC LIMIT 1").get(cwd) as unknown as TransactionRow | undefined)
      : (db.prepare("SELECT * FROM txn WHERE id = ?").get(id) as unknown as TransactionRow | undefined);
  if (!row) return null;

  const changes = db.prepare("SELECT path, abs, before, after_sha FROM change WHERE txn_id = ?").all(row.id) as unknown as ChangeRow[];

  return {
    id: row.id,
    createdAt: row.created_at,
    cwd: row.cwd,
    kind: row.kind === "rollback" ? "rollback" : "edit",
    rollsBack: row.rolls_back,
    summary: row.summary,
    changes: changes.map((change) => ({
      path: change.path,
      absolutePath: change.abs,
      before: Buffer.from(change.before),
      afterSha: change.after_sha,
    })),
  };
}

export async function recentTransactionIds(cwd: string, limit = 5): Promise<string[]> {
  const db = await open();
  const rows = db
    .prepare("SELECT id FROM txn WHERE cwd = ? ORDER BY rowid DESC LIMIT ?")
    .all(cwd, limit) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function prune(db: import("node:sqlite").DatabaseSync): Promise<void> {
  try {
    const deleted = db
      .prepare("DELETE FROM txn WHERE rowid <= (SELECT rowid FROM txn ORDER BY rowid DESC LIMIT 1 OFFSET ?)")
      .run(MAX_TRANSACTIONS);
    if (Number(deleted.changes) === 0) return;

    const pageSize = (db.prepare("PRAGMA page_size").get() as unknown as { page_size: number }).page_size;
    const pageCount = (db.prepare("PRAGMA page_count").get() as unknown as { page_count: number }).page_count;
    if (pageSize * pageCount > MAX_BYTES) {
      db.prepare(
        "DELETE FROM txn WHERE rowid <= (SELECT rowid FROM txn ORDER BY rowid DESC LIMIT 1 OFFSET ?)",
      ).run(Math.floor(MAX_TRANSACTIONS / 2));
    }

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA incremental_vacuum");
  } catch {
    // Retention is best effort: a busy database must never fail an edit.
  }
}
