import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppEvent } from "@biologue/protocol";
import type { AgentEvent, Harness, TaskGraph, TaskGraphWatch } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticScope = {
  runId?: string;
  conversationId?: string;
  nativeConversationId?: string;
  taskId?: string;
  toolCallId?: string;
  executionId?: string;
  requestId?: string;
};
export type DiagnosticInput = DiagnosticScope & {
  event: string;
  component: string;
  level?: DiagnosticLevel;
  /** An issue candidate, not a verdict that the application is defective. */
  actionable?: boolean;
  error?: unknown;
  data?: Record<string, unknown>;
};
export type DiagnosticEvent = Omit<DiagnosticInput, "error" | "data" | "level"> & {
  id: number;
  schemaVersion: 1;
  timestamp: string;
  sessionId: string;
  level: DiagnosticLevel;
  fingerprint?: string;
  error?: { name: string; message: string; stack?: string; code?: string; cause?: unknown };
  data?: Record<string, unknown>;
};
export type DiagnosticQuery = DiagnosticScope & {
  after?: number;
  limit?: number;
  level?: DiagnosticLevel;
  component?: string;
  event?: string;
  fingerprint?: string;
  since?: string;
  sessionId?: string;
};

const secretKey = /authorization|cookie|password|secret|token|api.?key|credential/i;
export function redactText(text: string) {
  return text
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9_./+=:-]+/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
    .replace(
      /([?&](?:[^=&\s]*(?:token|key|secret|password|code|state)[^=&\s]*)=)[^&\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:authorization|password|client_secret|access_token|refresh_token|api[_-]?key)["']?\s*[=:]\s*)["']?[^\s,"';}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

export function expectedDiagnosticError(error: unknown, signal?: AbortSignal) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    !!signal?.aborted ||
    /(?:^|\n|:\s|\[error\]\s)(?:Permission was declined|Permission declined\.|Plan mode permits|Agent run cancelled|User cancelled|Tool call interrupted|Interrupted tool)/i.test(
      message,
    )
  );
}

/** Bounded metadata only. Request bodies, prompts, code and result payloads are never passed here. */
export function diagnosticValue(value: unknown): unknown {
  let remaining = 600;
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 6) return "[TRUNCATED]";
    if (typeof item === "string") return redactText(item).slice(0, 8000);
    if (item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (item === undefined) return undefined;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    if (item instanceof Error) {
      const error = item as Error & { code?: string };
      return visit(
        {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
          cause: error.cause,
        },
        depth + 1,
      );
    }
    if (Array.isArray(item)) return item.slice(0, 100).map((entry) => visit(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          secretKey.test(key) &&
          !/^(?:tokens|tokenCount)$/i.test(key) &&
          !(typeof entry === "number" && /Tokens$/i.test(key))
            ? "[REDACTED]"
            : visit(entry, depth + 1),
        ]),
    );
  }
  return visit(value, 0);
}

function fingerprint(input: DiagnosticInput, error?: DiagnosticEvent["error"]) {
  const message = (error?.message ?? String(input.data?.status ?? input.event))
    .split("\n")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(?:\/[\w.@-]+){2,}(?::\d+(?::\d+)?)?/g, "<path>")
    .replace(/\b\d+\b/g, "<n>");
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.component,
        error ? undefined : input.event,
        input.data?.tool,
        error?.name,
        message,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/** One independent diagnostic store. Logging cannot decide or break application work. */
export class Diagnostics {
  readonly sessionId = randomUUID();
  private db?: DatabaseSync;
  private taskWatch?: TaskGraphWatch;
  private tasks = new Map<string, string>();
  private transitions = new Map<string, string>();
  private writes = 0;
  private dropped = 0;
  private lastError?: string;
  private closed = false;
  constructor(
    readonly path: string,
    private options: { maxEvents?: number; retentionDays?: number } = {},
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS diagnostic_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
          session_id TEXT NOT NULL, level TEXT NOT NULL, component TEXT NOT NULL,
          event TEXT NOT NULL, actionable INTEGER NOT NULL, fingerprint TEXT,
          run_id TEXT, conversation_id TEXT, native_conversation_id TEXT,
          task_id TEXT, tool_call_id TEXT, execution_id TEXT, request_id TEXT, value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS diagnostic_run ON diagnostic_events(run_id, id);
        CREATE INDEX IF NOT EXISTS diagnostic_conversation ON diagnostic_events(conversation_id, id);
        CREATE INDEX IF NOT EXISTS diagnostic_native_conversation ON diagnostic_events(native_conversation_id, id);
        CREATE INDEX IF NOT EXISTS diagnostic_issue ON diagnostic_events(actionable, fingerprint, id);
        CREATE INDEX IF NOT EXISTS diagnostic_time ON diagnostic_events(timestamp);
      `);
      this.prune();
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        /* Report the original open failure. */
      }
      this.db = undefined;
      this.failed(error);
    }
  }
  private failed(error: unknown) {
    this.dropped++;
    this.lastError = redactText(error instanceof Error ? error.message : String(error));
    if (this.dropped === 1) console.error("Biologue diagnostics unavailable:", this.lastError);
  }
  record(input: DiagnosticInput): number | undefined {
    if (this.closed) return;
    try {
      if (!this.db) throw new Error("Diagnostic store could not be opened.");
      const error =
        input.error === undefined
          ? undefined
          : (diagnosticValue(
              input.error instanceof Error ? input.error : new Error(String(input.error)),
            ) as DiagnosticEvent["error"]);
      const value = diagnosticValue({
        ...input,
        error,
        schemaVersion: 1,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        level: input.level ?? "info",
        actionable: input.actionable ?? false,
        fingerprint: input.actionable ? fingerprint(input, error) : undefined,
      }) as Omit<DiagnosticEvent, "id">;
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > 48_000) value.data = { truncated: true };
      if (Buffer.byteLength(JSON.stringify(value)) > 48_000 && value.error)
        value.error = {
          name: value.error.name,
          message: value.error.message.slice(0, 4000),
          stack: value.error.stack?.slice(0, 8000),
          cause: "[TRUNCATED]",
        };
      const result = this.db
        .prepare(
          `INSERT INTO diagnostic_events
        (timestamp,session_id,level,component,event,actionable,fingerprint,run_id,conversation_id,
          native_conversation_id,task_id,tool_call_id,execution_id,request_id,value)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          value.timestamp,
          value.sessionId,
          value.level,
          value.component,
          value.event,
          Number(value.actionable),
          value.fingerprint ?? null,
          value.runId ?? null,
          value.conversationId ?? null,
          value.nativeConversationId ?? null,
          value.taskId ?? null,
          value.toolCallId ?? null,
          value.executionId ?? null,
          value.requestId ?? null,
          JSON.stringify(value),
        );
      if (++this.writes % 500 === 0) this.prune();
      this.lastError = undefined;
      return Number(result.lastInsertRowid);
    } catch (error) {
      this.failed(error);
    }
  }
  status() {
    return {
      path: this.path,
      sessionId: this.sessionId,
      available: !!this.db && !this.closed && !this.lastError,
      dropped: this.dropped,
      lastError: this.lastError,
      retentionDays: this.options.retentionDays ?? 90,
      maxEvents: this.options.maxEvents ?? 250_000,
    };
  }
  private prune() {
    const oldest = new Date(
      Date.now() - (this.options.retentionDays ?? 90) * 86_400_000,
    ).toISOString();
    this.db!.prepare("DELETE FROM diagnostic_events WHERE timestamp < ?").run(oldest);
    this.db!.prepare(
      `DELETE FROM diagnostic_events WHERE id <= COALESCE(
      (SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
    ).run(this.options.maxEvents ?? 250_000);
  }
  events(query: DiagnosticQuery = {}) {
    return diagnosticEvents(this.db!, query);
  }
  get(id: number): DiagnosticEvent | undefined {
    const row = this.db!.prepare("SELECT value FROM diagnostic_events WHERE id=?").get(id);
    return row ? { ...JSON.parse(row.value as string), id } : undefined;
  }
  issues(query: { after?: number; limit?: number; since?: string } = {}) {
    return diagnosticIssues(this.db!, query);
  }
  observe(event: AppEvent) {
    if (event.type === "execution") {
      const e = event.execution;
      const key = `execution:${e.id}`;
      const state = JSON.stringify([e.status, e.kernelGeneration, e.kernelUncertain]);
      if (this.transitions.get(key) === state) return;
      this.transitions.set(key, state);
      const failed = ["failed", "completion_unknown", "abandoned"].includes(e.status);
      this.record({
        component: "kernel",
        event: `execution.${e.status}`,
        level: failed ? "error" : "info",
        actionable: failed && (e.actor !== "human" || e.status !== "failed"),
        error: e.error,
        executionId: e.id,
        runId: e.runId,
        toolCallId: e.toolCallId,
        conversationId: e.conversationId,
        data: {
          language: e.language,
          actor: e.actor,
          purpose: e.purpose,
          codeHash: e.codeHash,
          document: e.document,
          sessionId: e.sessionId,
          kernelId: e.kernelId,
          kernelGeneration: e.kernelGeneration,
          kernelUncertain: e.kernelUncertain,
          createdAt: e.createdAt,
          startedAt: e.startedAt,
          finishedAt: e.finishedAt,
          durationMs:
            e.finishedAt && e.startedAt
              ? Date.parse(e.finishedAt) - Date.parse(e.startedAt)
              : undefined,
        },
      });
      if (e.finishedAt) this.transitions.delete(key);
    } else if (event.type === "agent-run") {
      const r = event.run;
      const key = `run:${r.id}`;
      const state = JSON.stringify([r.status, r.phase, !!r.finishedAt]);
      if (this.transitions.get(key) === state) return;
      this.transitions.set(key, state);
      this.record({
        component: "agent",
        event: r.finishedAt ? "run.finished" : "run.state",
        level: r.status === "failed" ? "error" : "info",
        actionable: r.status === "failed",
        error: r.error,
        runId: r.id,
        conversationId: r.conversationId,
        nativeConversationId: r.piSessionId,
        data: {
          status: r.status,
          phase: r.phase,
          endReason: r.endReason,
          settings: r.settings,
          contextVersion: r.contextVersion,
          kind: r.kind,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs: r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : undefined,
          usage: r.finishedAt ? r.usage : undefined,
        },
      });
      if (r.finishedAt) this.transitions.delete(key);
    } else if (event.type === "permission") {
      const r = event.request;
      this.record({
        component: "permission",
        event: "permission.requested",
        runId: r.runId,
        conversationId: r.conversationId,
        toolCallId: r.toolCallId,
        data: { id: r.id, tool: r.tool, language: r.language, document: r.document },
      });
    } else if (event.type === "permission-resolved") {
      const r = event.resolution;
      this.record({
        component: "permission",
        event: "permission.resolved",
        runId: r?.runId,
        conversationId: r?.conversationId,
        toolCallId: r?.toolCallId,
        error: event.error,
        level: event.error ? "error" : "info",
        actionable: !!event.error,
        data: {
          id: event.id,
          decision: r?.decision,
          tool: r?.tool,
          durationMs: r ? Date.parse(r.resolvedAt) - Date.parse(r.createdAt) : undefined,
        },
      });
    } else if (event.type === "question" || event.type === "question-resolved") {
      this.record({
        component: "agent",
        event: event.type,
        ...(event.type === "question"
          ? { runId: event.question.runId, conversationId: event.question.conversationId }
          : {}),
        data: { id: event.type === "question" ? event.question.id : event.id },
      });
    } else if (event.type === "document") {
      const d = event.document;
      this.record({
        component: "document",
        event: "document.state",
        level: d.diskConflict ? "warning" : "info",
        data: {
          path: d.path,
          version: d.version,
          savedVersion: d.savedVersion,
          diskHash: d.diskHash,
          diskConflict: d.diskConflict?.hash,
          untitled: d.untitled,
          savedAs: d.savedAs,
          editId: d.editId,
        },
      });
    } else if (event.type === "context") {
      this.record({
        component: "agent",
        event: "context.changed",
        data: { version: event.context.version },
      });
    } else if (event.type === "conversation") {
      const c = event.conversation;
      this.record({
        component: "agent",
        event: "conversation.state",
        conversationId: c.id,
        data: {
          archived: c.archived,
          pinned: c.pinned,
          parentId: c.parentId,
          settings: c.settings,
        },
      });
    } else if (event.type === "message" && event.message.role === "user") {
      const m = event.message;
      this.record({
        component: "agent",
        event: "input.state",
        runId: m.runId,
        conversationId: m.conversationId,
        data: {
          id: m.id,
          entryId: m.entryId,
          delivery: m.delivery,
          queue: m.queue,
          attachments: m.attachments?.length ?? 0,
        },
      });
    }
  }
  agentEvent(event: AgentEvent, scope: DiagnosticScope) {
    if (
      [
        "message_update",
        "tool_execution_update",
        "entry_appended",
        "agent_changed",
        "usage_changed",
      ].includes(event.type)
    )
      return;
    let data: Record<string, unknown> = { type: event.type };
    let error: unknown;
    let actionable = false;
    if (event.type === "snapshot")
      data = {
        entries: event.entries.length,
        inbox: event.inbox.map((s) => ({ id: s.id, mode: s.mode })),
        tools: event.tools.map((t) => ({
          taskId: t.taskId,
          callId: t.callId,
          name: t.name,
          status: t.status,
        })),
        generation: event.generation && {
          attempt: event.generation.attempt,
          retry: event.generation.retry,
          deferred: event.generation.deferred,
        },
        compactions: event.compactions,
      };
    else if (event.type === "message_start") data = { role: event.message.role };
    else if (event.type === "message_end") {
      const m = event.entry.model?.find((m) => m.role === "assistant");
      data = {
        entryId: event.entry.id,
        kind: event.entry.kind,
        ...(m?.role === "assistant"
          ? { stopReason: m.stopReason, model: m.model, provider: m.provider, usage: m.usage }
          : {}),
      };
      if (m?.role === "assistant" && m.stopReason === "error") {
        error = m.errorMessage;
        actionable = true;
      }
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      scope = { ...scope, toolCallId: event.toolCallId };
      data = {
        tool: event.toolName,
        ...(event.type === "tool_execution_end" ? { entryId: event.entry?.id } : {}),
      };
      if (event.type === "tool_execution_end") {
        const metadata = event.entry?.data;
        data.diagnostics =
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? metadata.diagnostics
            : undefined;
        const result = event.entry?.model?.find((m) => m.role === "toolResult");
        if (result?.role === "toolResult" && result.isError) {
          error = result.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const codes = data.diagnostics;
          actionable =
            !expectedDiagnosticError(error) &&
            !(
              Array.isArray(codes) &&
              codes.some(
                (d) => d && typeof d === "object" && !Array.isArray(d) && d.code === "interrupted",
              )
            );
        }
      }
    } else if (event.type === "auto_retry_start") {
      data = { attempt: event.attempt, retryAt: event.at };
      error = event.errorMessage;
    } else if (event.type === "task_failed") {
      scope = { ...scope, taskId: String(event.taskId) };
      data = { kind: event.kind };
      error = event.message;
      actionable = true;
    } else if (event.type === "compaction_start" || event.type === "compaction_end") {
      scope = { ...scope, taskId: String(event.taskId) };
      data = { reason: event.reason };
    } else if (event.type === "submission")
      data = {
        id: event.record.id,
        requestId: event.record.requestId,
        status: event.record.status,
        type: event.record.type,
        entry: event.record.entry,
      };
    else if (event.type === "inbox_update") data = { items: event.items };
    this.record({
      ...scope,
      component: "durable",
      event: `durable.${event.type}`,
      level: actionable ? "error" : error ? "warning" : "info",
      actionable,
      error,
      data,
    });
  }
  async watchHarness(harness: Harness) {
    try {
      this.taskWatch = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
      const observe = (graph: TaskGraph) => {
        const current = new Map<string, string>();
        for (const node of Object.values(graph.tasks)) {
          const key = String(node.id),
            value = JSON.stringify(node);
          current.set(key, value);
          if (this.tasks.get(key) !== value)
            this.record({
              component: "durable",
              event: "task.state",
              taskId: key,
              nativeConversationId: String(node.conversationId),
              data: { ...node },
            });
        }
        for (const [key, value] of this.tasks)
          if (!current.has(key)) {
            const node = JSON.parse(value);
            this.record({
              component: "durable",
              event: "task.left_graph",
              taskId: key,
              nativeConversationId: String(node.conversationId),
              data: { kind: node.kind },
            });
          }
        this.tasks = current;
      };
      observe(this.taskWatch.value);
      this.taskWatch.start(async (value) => observe(value));
      void this.taskWatch.closed.then((end) => {
        if (end.reason === "listener_error")
          this.record({
            component: "diagnostics",
            event: "task_watch.failed",
            level: "error",
            actionable: true,
            error: end.error,
          });
      });
    } catch (error) {
      this.record({
        component: "diagnostics",
        event: "task_watch.failed",
        level: "error",
        actionable: true,
        error,
      });
    }
  }
  async close() {
    if (this.closed) return;
    try {
      await this.taskWatch?.stop();
      this.prune();
    } catch (error) {
      this.record({ component: "diagnostics", event: "close.failed", level: "error", error });
    }
    this.closed = true;
    try {
      this.db?.close();
    } catch (error) {
      this.failed(error);
    }
    this.transitions.clear();
    this.tasks.clear();
  }
}

export function diagnosticEvents(db: DatabaseSync, query: DiagnosticQuery = {}) {
  const bounds = diagnosticBounds(db, query.after);
  const conditions = ["id > ?", "id <= ?"];
  const values: (string | number)[] = [query.after ?? 0, bounds.watermark];
  const fields = {
    runId: "run_id",
    conversationId: "conversation_id",
    nativeConversationId: "native_conversation_id",
    taskId: "task_id",
    toolCallId: "tool_call_id",
    executionId: "execution_id",
    requestId: "request_id",
    level: "level",
    component: "component",
    event: "event",
    fingerprint: "fingerprint",
    sessionId: "session_id",
  };
  for (const [key, column] of Object.entries(fields)) {
    const value = query[key as keyof typeof fields];
    if (value !== undefined) {
      conditions.push(`${column}=?`);
      values.push(value);
    }
  }
  if (query.since) {
    conditions.push("timestamp>=?");
    values.push(new Date(query.since).toISOString());
  }
  const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT id,value FROM diagnostic_events WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT ?`,
    )
    .all(...values, limit + 1);
  const items = rows
    .slice(0, limit)
    .map((row) => ({ ...JSON.parse(row.value as string), id: Number(row.id) }) as DiagnosticEvent);
  return { items, next: rows.length > limit ? items.at(-1)!.id : undefined, ...bounds };
}

function diagnosticBounds(db: DatabaseSync, after?: number) {
  const oldestAvailableId = Number(
    db.prepare("SELECT id FROM diagnostic_events ORDER BY id LIMIT 1").get()?.id ?? 0,
  );
  const watermark = Number(
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name='diagnostic_events'").get()?.seq ?? 0,
  );
  return {
    oldestAvailableId,
    watermark,
    cursorGap:
      after !== undefined &&
      (oldestAvailableId ? oldestAvailableId > after + 1 : watermark > after),
  };
}

export function diagnosticIssues(
  db: DatabaseSync,
  query: { after?: number; limit?: number; since?: string } = {},
) {
  // No issue database or auto-fix verdict: groups are a projection of retained error evidence.
  const bounds = diagnosticBounds(db, query.after);
  const rows = db
    .prepare(
      `SELECT grouped.*, sample.value AS sample FROM (SELECT fingerprint,
      COUNT(DISTINCT CASE
        WHEN execution_id IS NOT NULL THEN 'execution:' || execution_id
        WHEN tool_call_id IS NOT NULL THEN 'tool:' || COALESCE(run_id, session_id) || ':' || tool_call_id
        WHEN task_id IS NOT NULL THEN 'task:' || task_id
        WHEN request_id IS NOT NULL THEN 'request:' || session_id || ':' || request_id
        WHEN run_id IS NOT NULL THEN 'run:' || run_id
        ELSE 'event:' || id END) AS occurrences,
      COUNT(*) AS signals,MIN(timestamp) AS firstSeen,
      MAX(timestamp) AS lastSeen,MAX(id) AS latestEventId,COUNT(DISTINCT run_id) AS runs
    FROM diagnostic_events WHERE actionable=1 AND timestamp>=? AND id<=?
    GROUP BY fingerprint HAVING MAX(id)>?) grouped
    JOIN diagnostic_events sample ON sample.id=grouped.latestEventId
    ORDER BY grouped.latestEventId ASC LIMIT ?`,
    )
    .all(
      query.since ? new Date(query.since).toISOString() : "",
      bounds.watermark,
      query.after ?? 0,
      Math.max(1, Math.min(1000, query.limit ?? 100)) + 1,
    );
  const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
  const items = rows.slice(0, limit).map((row) => {
    return {
      fingerprint: String(row.fingerprint),
      occurrences: Number(row.occurrences),
      signals: Number(row.signals),
      firstSeen: String(row.firstSeen),
      lastSeen: String(row.lastSeen),
      latestEventId: Number(row.latestEventId),
      runs: Number(row.runs),
      sample: {
        ...JSON.parse(row.sample as string),
        id: Number(row.latestEventId),
      } as DiagnosticEvent,
    };
  });
  return {
    items,
    next: rows.length > limit ? Number(items.at(-1)!.latestEventId) : undefined,
    ...bounds,
  };
}

/** Inspect native scheduling without exporting prompts, checkpoint payloads, or submission content. */
export async function inspectDurable(harness: Harness) {
  const view = await harness.inspect(
    withAbortSignal(AbortSignal.timeout(5000), BACKGROUND_CONTEXT),
  );
  return diagnosticValue({
    scheduling: view.scheduling,
    taskCount: view.tasks.length,
    submissionCount: view.submissions.length,
    tasks: view.tasks.map((t) => ({
      id: t.record.id,
      kind: t.record.kind,
      conversationId: t.record.conversationId,
      owner: t.record.owner,
      state: t.state,
      status: t.record.state.status,
    })),
    submissions: view.submissions.map((s) => ({
      id: s.id,
      conversationId: s.conversationId,
      requestId: s.requestId,
      type: s.type,
      status: s.status,
      entry: s.entry,
    })),
  });
}

export function observeProcessFailures(diagnostics: Diagnostics) {
  const listener = (error: Error, origin: string) => {
    diagnostics.record({
      component: "process",
      event: "process.fatal",
      level: "error",
      actionable: true,
      error,
      data: { origin },
    });
  };
  process.on("uncaughtExceptionMonitor", listener);
  return () => process.off("uncaughtExceptionMonitor", listener);
}
