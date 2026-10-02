import type { Message } from "@earendil-works/pi-ai";
import type { ContextIssue, Execution, ExecutionContextCheck, Language } from "@biologue/protocol";
import type { CodeEffects } from "./code-effects.ts";
import type { Store } from "./store.ts";
import type { ExecutionRepository } from "./execution-repository.ts";
import { digest } from "./documents.ts";

export interface ObservationReceipt {
  executionId: string;
  names: string[];
  kind: "environment_preview" | "execution_result";
}
type Observation = { seq: number; epoch: string; execution_id: string; kind: string };
type Activity = { seq: number; execution_id: string; effects: string };
export type ContextAcknowledgment = NonNullable<ExecutionContextCheck["acknowledgment"]>;

/** Evidence index only. Pi owns the transcript; executions own code and outputs. */
export class StaleContext {
  constructor(
    private store: Store,
    private executions: ExecutionRepository,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_activity (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL UNIQUE,
        language TEXT NOT NULL, epoch TEXT NOT NULL, effects TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_activity_language ON runtime_activity(language, epoch, seq);
      CREATE TABLE IF NOT EXISTS runtime_effects (
        seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY(seq, name, kind)
      );
      CREATE INDEX IF NOT EXISTS runtime_effects_name ON runtime_effects(name, seq);
      CREATE TABLE IF NOT EXISTS runtime_aliases (
        language TEXT NOT NULL, epoch TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
        PRIMARY KEY(language, epoch, a, b)
      );
      CREATE TABLE IF NOT EXISTS runtime_observations (
        conversation_id TEXT NOT NULL, language TEXT NOT NULL, name TEXT NOT NULL,
        seq INTEGER NOT NULL, epoch TEXT NOT NULL, execution_id TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY(conversation_id, language, name)
      );
      CREATE TABLE IF NOT EXISTS runtime_anchors (
        conversation_id TEXT NOT NULL, language TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, language)
      );
      CREATE TABLE IF NOT EXISTS runtime_receipts (
        conversation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id, tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_reviewed_activity (
        conversation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id, execution_id)
      );
    `);
    // Older versions advanced anchors on any result, including empty previews.
    // Recover conservatively; per-object observations still cover known changes.
    if (!store.get("migration", "observation-coverage"))
      store.transaction(() => {
        store.db.exec("UPDATE runtime_anchors SET seq=0");
        // Reindex receipts when Pi next delivers them; this never replays tools.
        store.db.exec("DELETE FROM runtime_receipts");
        store.put("migration", "observation-coverage", true);
      });
  }
  private head(language: Language) {
    return Number(
      this.store.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM runtime_activity WHERE language=?")
        .get(language)!.seq,
    );
  }
  begin(conversationId: string) {
    for (const language of ["r", "python"] as const)
      this.store.db
        .prepare("INSERT OR IGNORE INTO runtime_anchors VALUES (?, ?, ?)")
        .run(conversationId, language, this.head(language));
  }
  /** Called synchronously immediately before sending the kernel request. */
  started(record: Execution, effects: CodeEffects, epoch: string): number {
    return this.store.transaction(() => {
      const { seq } = this.store.db
        .prepare(
          "INSERT INTO runtime_activity(execution_id, language, epoch, effects) VALUES (?, ?, ?, ?) RETURNING seq",
        )
        .get(record.id, record.language, epoch, JSON.stringify(effects))!;
      const put = this.store.db.prepare("INSERT OR IGNORE INTO runtime_effects VALUES (?, ?, ?)");
      for (const name of effects.writes) put.run(seq, name, "assignment");
      for (const name of effects.mutates) put.run(seq, name, "mutation");
      if (effects.opaque) put.run(seq, "*", "unknown");
      for (const [a, b] of effects.aliases)
        this.store.db
          .prepare("INSERT OR IGNORE INTO runtime_aliases VALUES (?, ?, ?, ?)")
          .run(record.language, epoch, a, b);
      return Number(seq);
    });
  }
  effects(executionId: string): CodeEffects | undefined {
    const row = this.store.db
      .prepare("SELECT effects FROM runtime_activity WHERE execution_id=?")
      .get(executionId);
    return row ? JSON.parse(row.effects as string) : undefined;
  }
  /** Only model-context tool results establish observations, not tool start or UI reads. */
  observeContext(conversationId: string, messages: readonly Message[]) {
    this.begin(conversationId);
    for (const message of messages) {
      if (message.role !== "toolResult" || message.isError) continue;
      const receipt = (message.details as { biologueObservation?: ObservationReceipt } | undefined)
        ?.biologueObservation;
      if (!receipt || !Array.isArray(receipt.names)) continue;
      if (
        this.store.db
          .prepare("SELECT 1 FROM runtime_receipts WHERE conversation_id=? AND tool_call_id=?")
          .get(conversationId, message.toolCallId)
      )
        continue;
      const activity = this.store.db
        .prepare("SELECT seq, epoch, language FROM runtime_activity WHERE execution_id=?")
        .get(receipt.executionId);
      if (!activity) continue; // Legacy artifacts carry no trustworthy activity checkpoint.
      this.store.transaction(() => {
        for (const name of receipt.names) {
          if (typeof name !== "string") continue;
          this.store.db
            .prepare(
              `INSERT INTO runtime_observations VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, language, name) DO UPDATE SET
            seq=excluded.seq, epoch=excluded.epoch, execution_id=excluded.execution_id, kind=excluded.kind
            WHERE excluded.seq >= runtime_observations.seq`,
            )
            .run(
              conversationId,
              activity.language,
              name,
              activity.seq,
              activity.epoch,
              receipt.executionId,
              receipt.kind,
            );
        }
        // Receiving our own execution result covers that operation, not intervening
        // work by the scientist or another conversation. Inspections cover names only.
        if (receipt.kind === "execution_result") {
          const record = this.executions.get(receipt.executionId);
          if (record?.actor === "agent" && record.conversationId === conversationId)
            this.store.db
              .prepare("INSERT OR IGNORE INTO runtime_reviewed_activity VALUES (?, ?)")
              .run(conversationId, receipt.executionId);
        }
        this.store.db
          .prepare("INSERT INTO runtime_receipts VALUES (?, ?)")
          .run(conversationId, message.toolCallId);
      });
    }
  }
  private aliases(language: Language, epoch: string, name: string): string[] {
    // Conservative possible aliases. Rebinding does not prove that all old references vanished.
    return this.store.db
      .prepare(
        `WITH RECURSIVE related(name) AS (
      VALUES (?) UNION SELECT CASE WHEN a.a=r.name THEN a.b ELSE a.a END
      FROM runtime_aliases a JOIN related r ON a.a=r.name OR a.b=r.name
      WHERE a.language=? AND a.epoch=? LIMIT 129
    ) SELECT name FROM related`,
      )
      .all(name, language, epoch)
      .map((row) => row.name as string);
  }
  check(
    record: Execution,
    effects: CodeEffects,
    epoch: string,
    acknowledgment?: ContextAcknowledgment,
  ): ExecutionContextCheck {
    const conversationId = record.conversationId!;
    this.begin(conversationId);
    const anchor = Number(
      this.store.db
        .prepare("SELECT seq FROM runtime_anchors WHERE conversation_id=? AND language=?")
        .get(conversationId, record.language)!.seq,
    );
    const through = this.head(record.language);
    const issues = new Map<string, ContextIssue>();
    const add = (issue: ContextIssue) => {
      const id = digest(issue.id);
      issues.set(id, {
        ...issue,
        id,
        object: issue.object?.slice(0, 200),
        message: issue.message.slice(0, 450),
        codePreview: issue.codePreview?.slice(0, 400),
      });
    };
    const evidence = (activity: Activity) => {
      return {
        executionId: activity.execution_id,
      };
    };
    const dependencies = [...new Set([...effects.reads, ...effects.writes, ...effects.mutates])];
    if (effects.unresolvedSyntax || dependencies.length > 128)
      add({
        id: `analysis:${record.codeHash}:${through}`,
        kind: "unknown",
        message: "Dependencies or side effects could not be fully analyzed.",
      });
    for (const name of dependencies.slice(0, 128)) {
      const observation = this.store.db
        .prepare(
          "SELECT seq, epoch, execution_id, kind FROM runtime_observations WHERE conversation_id=? AND language=? AND name=?",
        )
        .get(conversationId, record.language, name) as Observation | undefined;
      const baseline = observation ? Number(observation.seq) : anchor;
      if (observation && observation.epoch !== epoch) {
        add({
          id: `${name}:kernel:${epoch}`,
          object: name,
          kind: "kernel_changed",
          observedExecutionId: observation.execution_id,
          message: `${name} was observed in an earlier kernel generation. Inspect the current session before relying on that observation.`,
        });
      }
      const aliases = this.aliases(record.language, epoch, name);
      if (aliases.length > 128)
        add({
          id: `${name}:aliases:${through}`,
          object: name,
          kind: "unknown",
          message: "Alias analysis limit reached.",
        });
      const rows = this.store.db
        .prepare(
          `SELECT DISTINCT a.seq, a.execution_id, a.effects FROM runtime_activity a
        JOIN runtime_effects e ON e.seq=a.seq WHERE a.language=? AND a.epoch=? AND a.seq>?
        AND (e.name=? OR (e.name='*' AND ?) OR (e.kind='mutation' AND e.name IN (${aliases.map(() => "?").join(",")})))
        AND (e.kind!='unknown' OR NOT EXISTS(SELECT 1 FROM runtime_reviewed_activity r
          WHERE r.conversation_id=? AND r.execution_id=a.execution_id))
        ORDER BY a.seq DESC LIMIT 65`,
        )
        // Bare callables without a workspace observation may be built-ins. Explicit
        // rebinding still counts; opaque calls also have the dependency check below.
        .all(
          record.language,
          epoch,
          baseline,
          name,
          observation || !effects.calls.includes(name) ? 1 : 0,
          ...aliases,
          conversationId,
        ) as Activity[];
      if (!observation) {
        const existing = this.store.db
          .prepare(
            `SELECT a.seq, a.execution_id, a.effects FROM runtime_activity a
          JOIN runtime_effects e ON e.seq=a.seq WHERE a.language=? AND a.epoch=? AND a.seq<=? AND e.name=?
          ORDER BY a.seq DESC LIMIT 1`,
          )
          .get(record.language, epoch, baseline, name) as Activity | undefined;
        if (existing || (effects.reads.includes(name) && !effects.calls.includes(name)))
          add({
            id: `${name}:unobserved:${existing?.seq ?? 0}`,
            object: name,
            kind: "unobserved",
            ...(existing ? evidence(existing) : {}),
            message: `${name} has no runtime observation delivered to this conversation. Inspect it or explicitly accept the existing state before reading or overwriting it.`,
          });
      }
      for (const activity of rows.slice(0, 64)) {
        const changed: CodeEffects = JSON.parse(activity.effects);
        const direct = changed.writes.includes(name) || changed.mutates.includes(name);
        add({
          id: `${name}:activity:${activity.seq}`,
          object: name,
          kind: direct ? "possible_change" : "unknown",
          ...evidence(activity),
          observedExecutionId: observation?.execution_id,
          message: direct
            ? `Intervening code assigns, removes, or may mutate ${name}, which this request reads or overwrites. Failed or conditional code may have only partial effects.`
            : `Intervening code may affect ${name} through an alias or unverified side effect. This is an inference, not a confirmed value change.`,
        });
      }
      if (rows.length > 64)
        add({
          id: `${name}:history:${through}`,
          object: name,
          kind: "unknown",
          message: "Earlier activity omitted; inspect current state or read execution history.",
        });
    }
    // An opaque proposed call may read objects that never appear literally in its source.
    if (effects.opaque || dependencies.length > 128) {
      const activities = this.store.db
        .prepare(
          `SELECT a.seq, a.execution_id, a.effects FROM runtime_activity a
        WHERE a.language=? AND a.epoch=? AND a.seq>?
        AND NOT EXISTS(SELECT 1 FROM runtime_reviewed_activity r
          WHERE r.conversation_id=? AND r.execution_id=a.execution_id)
        AND EXISTS(SELECT 1 FROM runtime_effects e WHERE e.seq=a.seq
          AND (e.kind='unknown' OR NOT EXISTS(SELECT 1 FROM runtime_observations o
            WHERE o.conversation_id=? AND o.language=a.language AND o.epoch=a.epoch
            AND o.name=e.name AND o.seq>=a.seq)))
        ORDER BY a.seq DESC LIMIT 65`,
        )
        .all(record.language, epoch, anchor, conversationId, conversationId) as Activity[];
      for (const activity of activities.slice(0, 64))
        add({
          id: `dependencies:${activity.seq}`,
          kind: "unknown",
          ...evidence(activity),
          message: "The proposed code has unresolved dependencies and unreviewed runtime changes.",
        });
      if (activities.length > 64)
        add({
          id: `dependencies:history:${through}`,
          kind: "unknown",
          message: "Earlier activity omitted; inspect current state or read execution history.",
        });
    }
    let accepted = new Set<string>();
    if (acknowledgment) {
      const prior = this.executions.get(acknowledgment.warningExecutionId);
      if (
        prior?.status === "not_executed" &&
        prior.conversationId === conversationId &&
        prior.language === record.language &&
        prior.codeHash === record.codeHash &&
        prior.contextCheck?.epoch === epoch
      ) {
        accepted = new Set([
          ...(prior.contextCheck.acknowledgedIssueIds ?? []),
          ...prior.contextCheck.issues.map((issue) => issue.id),
        ]);
      } else
        add({
          id: `invalid-ack:${through}`,
          kind: "unknown",
          message:
            "Acknowledgment does not match this conversation, code, language, or kernel generation.",
        });
    }
    const all = [...issues.values()];
    const remaining = all.filter((issue) => !accepted.has(issue.id));
    // Keep warning payloads bounded. Acknowledgment only covers the evidence actually returned.
    // Load source only for evidence that will actually be returned. A large
    // history or many overlapping dependencies must not repeatedly load scripts.
    const bounded = (remaining.length ? remaining : all).slice(0, 16).map((issue) => {
      const execution = issue.executionId ? this.executions.get(issue.executionId) : undefined;
      return execution
        ? {
            ...issue,
            codePreview: execution.code.slice(0, 400),
            actor: execution.actor,
            status: execution.status,
          }
        : issue;
    });
    if (remaining.length > 16)
      bounded.push({
        id: `additional:${through}`,
        kind: "unknown",
        message:
          "More possible changes remain; inspect affected objects or acknowledge this page to review the next group.",
      });
    return {
      disposition: remaining.length ? "review" : all.length ? "acknowledged" : "clear",
      through,
      epoch,
      issues: bounded,
      acknowledgment,
      ...(accepted.size
        ? {
            acknowledgedIssueIds: all
              .filter((issue) => accepted.has(issue.id))
              .map((issue) => issue.id),
          }
        : {}),
      notes: [
        ...effects.notes,
        "Static evidence only: no warning is not proof of unchanged state. Background work, external files, custom dispatch, and activity outside this harness may be missed.",
      ],
    };
  }
}
