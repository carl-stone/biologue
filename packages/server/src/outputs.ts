import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DisplayOutput,
  Execution,
  InspectionResult,
  Language,
  Output,
  OutputReference,
  Page,
} from "@biologue/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import { decodeInspection, decodeTable } from "./adapters.ts";

export type KernelOutput = Omit<Output, "id" | "executionId" | "sequence">;

/** Payloads are immutable and content addressed. SQLite contains references only. */
export class ArtifactStore {
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  put(value: unknown): string {
    const text = JSON.stringify(value);
    const hash = createHash("sha256").update(text).digest("hex");
    const path = join(this.directory, hash + ".json");
    if (!existsSync(path)) {
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, text, { flag: "wx" });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    return hash;
  }
  get<T>(hash: string): T {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact reference.");
    const text = readFileSync(join(this.directory, hash + ".json"), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== hash)
      throw new Error("Artifact integrity check failed.");
    return JSON.parse(text) as T;
  }
}

/** Raw events, mutable display slots, and decoded inspection results have separate identities. */
export class OutputService {
  readonly artifacts: ArtifactStore;
  constructor(
    private store: Store,
    private events: Events,
    private directory: string,
  ) {
    this.artifacts = new ArtifactStore(join(directory, "blobs"));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS outputs (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        payload TEXT NOT NULL, descriptor TEXT NOT NULL, reference TEXT NOT NULL,
        UNIQUE(execution_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS output_state (
        execution_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 0,
        clear_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS output_views (
        slot_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, language TEXT NOT NULL,
        scope TEXT NOT NULL, display_id TEXT, artifact_id TEXT NOT NULL,
        image INTEGER NOT NULL, table_result INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS views_execution ON output_views(execution_id);
      CREATE INDEX IF NOT EXISTS views_display ON output_views(scope, display_id);
      CREATE INDEX IF NOT EXISTS views_gallery ON output_views(language, image, table_result);
      CREATE TABLE IF NOT EXISTS inspection_results (execution_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
  }
  append(
    execution: Pick<Execution, "id" | "language" | "kernelId" | "kernelGeneration">,
    value: KernelOutput,
    legacy?: Output,
  ): OutputReference {
    if (legacy) {
      const existing = this.reference(legacy.id);
      if (existing) return existing;
    }
    const state = this.store.db
      .prepare("SELECT next_sequence, clear_pending FROM output_state WHERE execution_id=?")
      .get(execution.id);
    const output: Output = {
      ...value,
      id: legacy?.id ?? randomUUID(),
      executionId: execution.id,
      sequence: legacy?.sequence ?? Number(state?.next_sequence ?? 0),
    };
    const { text, data, metadata, ...descriptor } = output;
    const payload = this.artifacts.put({ text, data, metadata });
    const preview = text ?? (typeof data?.["text/plain"] === "string" ? data["text/plain"] : "");
    const reference: OutputReference = {
      id: output.id,
      executionId: output.executionId,
      sequence: output.sequence,
      kind: output.kind,
      mimeTypes: Object.keys(data ?? {}),
      preview: preview.slice(0, 2000),
      truncated: preview.length > 2000,
      table: !!decodeTable(data?.["application/json"]),
    };
    const image = typeof data?.["image/png"] === "string" ? 1 : 0;
    // Without a process identity, legacy output can only update its own execution.
    const scope = execution.kernelGeneration
      ? JSON.stringify([execution.language, execution.kernelId, execution.kernelGeneration])
      : `execution:${execution.id}`;
    const affected = new Set([execution.id]);
    this.store.transaction(() => {
      this.store.db
        .prepare("INSERT INTO outputs VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          output.id,
          execution.id,
          output.sequence,
          payload,
          JSON.stringify(descriptor),
          JSON.stringify(reference),
        );
      let clearPending = Number(state?.clear_pending ?? 0);
      if (output.kind === "clear") {
        clearPending = output.wait ? 1 : 0;
        if (!output.wait)
          this.store.db.prepare("DELETE FROM output_views WHERE execution_id=?").run(execution.id);
      } else {
        if (clearPending)
          this.store.db.prepare("DELETE FROM output_views WHERE execution_id=?").run(execution.id);
        clearPending = 0;
        if (output.kind === "update") {
          if (output.displayId) {
            for (const row of this.store.db
              .prepare(
                "SELECT DISTINCT execution_id FROM output_views WHERE scope=? AND display_id=?",
              )
              .all(scope, output.displayId))
              affected.add(row.execution_id as string);
            this.store.db
              .prepare(
                "UPDATE output_views SET artifact_id=?, image=?, table_result=? WHERE scope=? AND display_id=?",
              )
              .run(output.id, image, Number(reference.table), scope, output.displayId);
          }
        } else
          this.store.db
            .prepare("INSERT INTO output_views VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(
              output.id,
              execution.id,
              execution.language,
              scope,
              output.displayId ?? null,
              output.id,
              image,
              Number(reference.table),
            );
      }
      this.store.db
        .prepare(
          `INSERT INTO output_state VALUES (?, ?, ?) ON CONFLICT(execution_id)
        DO UPDATE SET next_sequence=excluded.next_sequence, clear_pending=excluded.clear_pending`,
        )
        .run(execution.id, output.sequence + 1, clearPending);
    });
    for (const executionId of affected)
      this.events.emit({ type: "outputs", executionId, language: execution.language });
    return reference;
  }
  removeLegacyCopies(outputs: Output[]) {
    for (const output of outputs) {
      if (!/^[a-f0-9-]{36}$/.test(output.id)) continue;
      const path = join(this.directory, output.id + ".json");
      if (
        existsSync(path) &&
        isDeepStrictEqual(this.get(output.id), output) &&
        isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), output)
      )
        unlinkSync(path);
    }
  }
  reference(id: string): OutputReference | undefined {
    const row = this.store.db.prepare("SELECT reference FROM outputs WHERE id=?").get(id);
    return row ? JSON.parse(row.reference as string) : undefined;
  }
  get(id: string): Output | undefined {
    const row = this.store.db.prepare("SELECT descriptor, payload FROM outputs WHERE id=?").get(id);
    return row
      ? {
          ...JSON.parse(row.descriptor as string),
          ...this.artifacts.get<object>(row.payload as string),
        }
      : undefined;
  }
  count(executionId: string): number {
    return Number(
      this.store.db
        .prepare("SELECT COUNT(*) AS count FROM outputs WHERE execution_id=?")
        .get(executionId)!.count,
    );
  }
  references(executionId: string, offset = 0, limit = 100): OutputReference[] {
    return this.store.db
      .prepare(
        "SELECT reference FROM outputs WHERE execution_id=? ORDER BY sequence LIMIT ? OFFSET ?",
      )
      .all(executionId, limit, offset)
      .map((row) => JSON.parse(row.reference as string));
  }
  /** Explicit payload loading for inspection decoding and integrations, never snapshots or status updates. */
  raw(executionId: string): Output[] {
    return this.store.db
      .prepare("SELECT descriptor, payload FROM outputs WHERE execution_id=? ORDER BY sequence")
      .all(executionId)
      .map((row) => ({
        ...JSON.parse(row.descriptor as string),
        ...this.artifacts.get<object>(row.payload as string),
      }));
  }
  visible(
    options: {
      executionId?: string;
      language?: Language;
      kind?: "plots" | "tables";
      before?: string;
      limit?: number;
    } = {},
  ): Page<DisplayOutput> {
    const limit = options.limit ?? 100;
    const where: string[] = [],
      parameters: (string | number)[] = [];
    if (options.executionId) {
      where.push("v.execution_id=?");
      parameters.push(options.executionId);
    }
    if (options.language) {
      where.push("v.language=?");
      parameters.push(options.language);
    }
    if (options.kind) where.push(options.kind === "plots" ? "v.image=1" : "v.table_result=1");
    if (options.before) {
      where.push("v.rowid < (SELECT rowid FROM output_views WHERE slot_id=?)");
      parameters.push(options.before);
    }
    const rows = this.store.db
      .prepare(
        `SELECT v.slot_id, v.execution_id, o.reference FROM output_views v
      JOIN outputs o ON o.id=v.artifact_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY v.rowid DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page
        .map((row) => ({
          ...JSON.parse(row.reference as string),
          slotId: row.slot_id as string,
          ownerExecutionId: row.execution_id as string,
        }))
        .reverse(),
      next: rows.length > limit ? (page.at(-1)!.slot_id as string) : undefined,
    };
  }
  complete(execution: Execution) {
    if (execution.status !== "succeeded" || execution.purpose !== "inspection") return;
    const result = decodeInspection(execution.inspection, this.raw(execution.id));
    if (result) {
      this.store.db
        .prepare("INSERT OR REPLACE INTO inspection_results VALUES (?, ?)")
        .run(execution.id, this.artifacts.put(result));
      this.events.emit({
        type: "outputs",
        executionId: execution.id,
        language: execution.language,
      });
    }
  }
  result(executionId: string): InspectionResult | undefined {
    const row = this.store.db
      .prepare("SELECT payload FROM inspection_results WHERE execution_id=?")
      .get(executionId);
    return row ? this.artifacts.get<InspectionResult>(row.payload as string) : undefined;
  }
  table(id: string) {
    return decodeTable(this.get(id)?.data?.["application/json"]);
  }
}
