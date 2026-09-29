import type { Execution, ExecutionSummary, Page } from "@carl/protocol";
import type { Store } from "./store.ts";

export function summarize({ code, ...record }: Execution): ExecutionSummary {
  return {
    ...record,
    codePreview:
      code
        .split("\n")
        .find((line) => line.trim() && !line.startsWith("#"))
        ?.slice(0, 110) || "Execution code",
  };
}

/** Detailed warnings are fetched with the execution, not repeated in SSE/history snapshots. */
export function displaySummary({
  contextCheck: _check,
  ...record
}: ExecutionSummary): ExecutionSummary {
  return record;
}

/** Source is immutable; status updates never rewrite code or output payloads. */
export class ExecutionRepository {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_records (
        id TEXT PRIMARY KEY, language TEXT NOT NULL, status TEXT NOT NULL,
        run_id TEXT, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_status ON execution_records(status);
      CREATE INDEX IF NOT EXISTS executions_run ON execution_records(run_id, status);
      CREATE TABLE IF NOT EXISTS execution_sources (id TEXT PRIMARY KEY, code TEXT NOT NULL);
    `);
  }
  create(record: Execution) {
    this.store.transaction(() => {
      this.store.db
        .prepare("INSERT INTO execution_sources VALUES (?, ?)")
        .run(record.id, record.code);
      this.update(record);
    });
  }
  update(record: ExecutionSummary) {
    const {
      code: _code,
      outputs: _outputs,
      ...metadata
    } = record as Execution & { outputs?: unknown };
    this.store.db
      .prepare(
        `INSERT INTO execution_records (id, language, status, run_id, value)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, value=excluded.value`,
      )
      .run(
        record.id,
        record.language,
        record.status,
        record.runId ?? null,
        JSON.stringify(metadata),
      );
  }
  get(id: string): Execution | undefined {
    const row = this.store.db
      .prepare(
        `SELECT r.value, s.code FROM execution_records r
      JOIN execution_sources s ON s.id=r.id WHERE r.id=?`,
      )
      .get(id);
    return row ? { ...JSON.parse(row.value as string), code: row.code as string } : undefined;
  }
  list(limit = 100, before?: string): Page<ExecutionSummary> {
    const rows = this.store.db
      .prepare(
        `SELECT id, value FROM execution_records
      WHERE rowid < COALESCE((SELECT rowid FROM execution_records WHERE id=?), 9223372036854775807)
      ORDER BY rowid DESC LIMIT ?`,
      )
      .all(before ?? null, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => displaySummary(JSON.parse(row.value as string))).reverse(),
      next: rows.length > limit ? (page.at(-1)!.id as string) : undefined,
    };
  }
  unfinished(runId?: string): ExecutionSummary[] {
    return this.store.db
      .prepare(
        `SELECT value FROM execution_records WHERE status IN ('queued','running')
      ${runId === undefined ? "" : "AND run_id=?"}`,
      )
      .all(...(runId === undefined ? [] : [runId]))
      .map((row) => JSON.parse(row.value as string));
  }
  /** One legacy execution at a time; migrate payloads before removing the old record. */
  migrate(
    migrateOutputs: (record: Execution & { outputs: import("@carl/protocol").Output[] }) => void,
  ) {
    while (true) {
      const row = this.store.db
        .prepare("SELECT id, value FROM records WHERE kind='execution' ORDER BY rowid LIMIT 1")
        .get();
      if (!row) break;
      const old = JSON.parse(row.value as string);
      const { outputs, ...source } = old;
      const record = { ...source, ...summarize(source) };
      // Re-entry after a crash is safe: source and raw output IDs are immutable.
      if (!this.get(record.id)) this.create(record);
      migrateOutputs(old);
      this.store.delete("execution", record.id);
    }
  }
}
