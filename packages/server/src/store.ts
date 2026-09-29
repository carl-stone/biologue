import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Local state is durable before its corresponding event is published. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
`);
  }
  put<T>(kind: string, id: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO records (kind, id, value) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }
  list<T>(kind: string, limit?: number): T[] {
    if (limit !== undefined)
      return this.db
        .prepare(
          "SELECT value FROM (SELECT rowid, value FROM records WHERE kind = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid",
        )
        .all(kind, limit)
        .map((row) => JSON.parse(row.value as string) as T);
    return this.db
      .prepare("SELECT value FROM records WHERE kind = ? ORDER BY rowid")
      .all(kind)
      .map((row) => JSON.parse(row.value as string) as T);
  }
  delete(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
