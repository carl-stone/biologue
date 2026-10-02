import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Message as PiMessage, ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Harness,
  type Conversation as DurableConversation,
  type ConversationId,
  type EntryRecord,
  type EntryId,
  type Cursor,
  type Submission,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Conversation, Message, Page, Attachment } from "@biologue/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";

/** Persisted alongside the transcript so creation can be reconciled after a crash. */
export const IdentityDoc = defineDoc({
  kind: "biologue.identity",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "" }),
});
export type BiologueMessage = PiMessage & {
  biologue?: { inputId?: string; chatId?: string; runId?: string; contextVersion?: number };
};
export function messageText(message: PiMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
}

/** Pi Durable owns history and admission. The application database is a rebuildable display index. */
export class ConversationSessions {
  harness!: Harness;
  private ids = new Map<number, string>();
  private opening = new Map<string, Promise<DurableConversation>>();
  private detach?: () => void;
  constructor(
    private project: string,
    private stateDir: string,
    private store: Store,
    private events: Events,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      position INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      created_at TEXT NOT NULL, value TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '', UNIQUE(conversation_id,id));
      CREATE INDEX IF NOT EXISTS chat_messages_page ON chat_messages(conversation_id,created_at,position);
      CREATE INDEX IF NOT EXISTS input_receipt_conversation ON records(kind,json_extract(value,'$.conversationId')) WHERE kind='input-receipt';
      CREATE TABLE IF NOT EXISTS chat_delivered(conversation_id TEXT NOT NULL,input_id TEXT NOT NULL,PRIMARY KEY(conversation_id,input_id));`);
  }
  bind(harness: Harness) {
    this.harness = harness;
    for (const conversation of this.store.list<Conversation>("conversation")) {
      const ref = this.store.get<{ id: number }>("durable-conversation", conversation.id);
      if (ref) this.ids.set(ref.id, conversation.id);
    }
    // Publication is after durable commit. Never call harness APIs from this listener.
    this.detach = harness.subscribeCommits((publication) => {
      try {
        const submissions = publication.changes
          .filter((c) => c.type === "submission")
          .map((c) => c.value);
        for (const record of submissions) this.indexSubmission(record);
        for (const change of publication.changes) {
          if (change.type !== "entry") continue;
          const id = this.ids.get(change.value.conversationId);
          if (id) this.indexEntry(id, change.value);
        }
      } catch (error) {
        // The transcript is already safe; rebuild the projection on its next read.
        for (const id of this.ids.values()) this.store.delete("durable-index", id);
        console.error("Durable conversation projection failed", error);
      }
    });
  }
  unbind() {
    this.detach?.();
  }
  async get(id: string): Promise<DurableConversation> {
    if (!this.store.get("conversation", id)) throw new Error("Conversation does not exist.");
    const cached = this.opening.get(id);
    if (cached) return cached;
    const opening = this.open(id);
    this.opening.set(id, opening);
    try {
      return await opening;
    } catch (error) {
      this.opening.delete(id);
      throw error;
    }
  }
  private async open(id: string) {
    const ref = this.store.get<{ id: number }>("durable-conversation", id);
    if (ref) {
      const conversation = await this.harness.conversation(ref.id as ConversationId, context);
      if (!conversation)
        throw new Error(
          "The durable conversation is missing. Restore the project's state before continuing.",
        );
      this.ids.set(conversation.id, id);
      return conversation;
    }
    // Recover an atomic creation whose application-side reference was not yet written.
    let cursor: Cursor | undefined;
    do {
      const page = await this.harness.commit(
        (tx) => tx.scanConversations({}, 100, cursor),
        context,
      );
      for (const candidate of page.items) {
        const identity = await this.harness.snapshot(IdentityDoc, candidate.id, context);
        if (identity?.id === id)
          return this.remember(id, (await this.harness.conversation(candidate.id, context))!);
      }
      cursor = page.next;
    } while (cursor);
    const legacy = this.legacy(id); // Validate legacy files before creating anything.
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          (await tx.doc(IdentityDoc, conversationId)).id = id;
          for (const entry of legacy) await tx.appendEntry(conversationId, entry);
        },
      },
      context,
    );
    return this.remember(id, conversation);
  }
  private remember(id: string, conversation: DurableConversation) {
    this.ids.set(conversation.id, id);
    this.store.put("durable-conversation", id, { id: conversation.id, version: "1.0.0" });
    return conversation;
  }
  private legacy(id: string) {
    const ref = this.store.get<{ file: string; persisted: boolean }>("pi-session", id);
    if (ref?.persisted && !existsSync(ref.file))
      throw new Error(
        "The Pi session file is missing. Restore it before continuing this conversation.",
      );
    const manager =
      ref && existsSync(ref.file)
        ? SessionManager.open(ref.file, undefined, this.project)
        : undefined;
    const entries: Omit<EntryRecord, "id" | "conversationId">[] = [];
    const delivered = new Set<string>();
    const old = this.store.list<Message>("message").filter((m) => m.conversationId === id);
    const messages =
      manager?.buildSessionProjection().messages ??
      this.store.get<BiologueMessage[]>("transcript", id) ??
      [];
    for (const message of messages) {
      if (!["user", "assistant", "system", "toolResult"].includes(message.role)) continue;
      const metadata = (message as BiologueMessage).biologue;
      const receipt =
        metadata?.inputId && this.store.get<Message>("input-receipt", metadata.inputId);
      const display =
        receipt ||
        old.find(
          (m) => !delivered.has(m.id) && m.role === message.role && m.text === messageText(message),
        );
      if (display) delivered.add(display.id);
      entries.push({
        kind: `biologue.import.${message.role}`,
        model: [message as PiMessage],
        data: JSON.parse(JSON.stringify({ display: display || undefined, legacy: true })),
      });
    }
    // Supply error results for unfinished historical calls, never schedule them.
    const answered = new Set(
      messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
    );
    for (const m of messages)
      if (m.role === "assistant")
        for (const b of m.content)
          if (b.type === "toolCall" && !answered.has(b.id))
            entries.push({
              kind: "biologue.import.toolResult",
              model: [
                {
                  role: "toolResult",
                  toolCallId: b.id,
                  toolName: b.name,
                  content: [
                    {
                      type: "text",
                      text: "Interrupted legacy tool call: effects are unknown. Review recorded executions and current state before retrying.",
                    },
                  ],
                  isError: true,
                  timestamp: Date.now(),
                },
              ],
            });
    for (const display of old.filter((m) => !delivered.has(m.id)))
      entries.push({
        kind: "biologue.import.display",
        data: JSON.parse(JSON.stringify({ display })),
        model:
          display.role === "user"
            ? [{ role: "user", content: display.text, timestamp: Date.parse(display.createdAt) }]
            : undefined,
      });
    return entries;
  }
  accept(
    id: string,
    text: string,
    runId: string,
    extra?: {
      queue?: Message["queue"];
      attachments?: Attachment[];
      prepared?: { text: string; images: ImageContent[] };
    },
  ): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId: id,
      role: "user",
      text,
      runId,
      createdAt: new Date().toISOString(),
      delivery: "pending",
      ...(extra?.queue ? { queue: extra.queue } : {}),
      ...(extra?.attachments?.length ? { attachments: extra.attachments } : {}),
    };
    this.store.transaction(() => {
      this.store.put("input-receipt", message.id, message);
      if (extra?.prepared) this.store.put("input-content", message.id, extra.prepared);
      this.put(message);
    });
    this.events.emit({ type: "message", message });
    return message;
  }
  content(input: Message): { text: string; images: ImageContent[] } {
    return this.store.get("input-content", input.id) ?? { text: input.text, images: [] };
  }
  async submit(
    input: Message,
    expand: (text: string) => string = (text) => text,
  ): Promise<Submission> {
    const conversation = await this.get(input.conversationId);
    const content = this.content(input);
    const submission = await conversation.submit(
      {
        type: "input",
        requestId: input.id,
        content: [{ type: "text", text: expand(content.text) }, ...content.images],
        whenBusy: input.queue ?? "followUp",
      },
      context,
    );
    this.store.put("durable-input", input.id, { id: submission.id });
    await this.synchronize(input.conversationId);
    return submission;
  }
  private indexSubmission(record: SubmissionRecord) {
    if (record.type !== "input" || !record.requestId || !record.entry) return;
    const input = this.store.get<Message>("input-receipt", record.requestId);
    if (!input) return;
    this.store.transaction(() => {
      this.store.put("durable-entry-input", String(record.entry), input.id);
      this.store.db
        .prepare("INSERT OR IGNORE INTO chat_delivered VALUES (?,?)")
        .run(input.conversationId, input.id);
      this.put({ ...input, delivery: "delivered", entryId: String(record.entry) });
    });
    this.events.emit({
      type: "message",
      message: { ...input, delivery: "delivered", entryId: String(record.entry) },
    });
  }
  private indexEntry(id: string, entry: EntryRecord) {
    const data = entry.data as { display?: Message } | undefined;
    const inputId = this.store.get<string>("durable-entry-input", String(entry.id));
    const input = inputId ? this.store.get<Message>("input-receipt", inputId) : undefined;
    const messages = entry.model ?? [];
    const m = messages.find((m) => m.role === "user" || m.role === "assistant");
    const metadata = (m as BiologueMessage | undefined)?.biologue;
    const imported = metadata?.inputId
      ? this.store.get<Message>("input-receipt", metadata.inputId)
      : undefined;
    const display = input ?? imported ?? data?.display;
    // Compaction and reset messages are model context, not scientist input.
    if (
      !display &&
      (!m ||
        !["pi.user", "pi.assistant", "biologue.import.user", "biologue.import.assistant"].includes(
          entry.kind,
        ))
    )
      return;
    if (m?.role === "assistant" && (m.stopReason === "aborted" || m.stopReason === "error")) return;
    const text = display?.text ?? (m ? messageText(m) : "");
    if (!text) return;
    const timestamp = m?.timestamp ?? Date.now();
    const run = this.store
      .list<import("@biologue/protocol").AgentRun>("run")
      .filter((r) => r.conversationId === id && r.status === "running")
      .at(-1);
    const saved = this.store.get<{ createdAt: string; runId?: string }>(
      "durable-display",
      String(entry.id),
    );
    const previous = this.store.db
      .prepare("SELECT MAX(created_at) AS time FROM chat_messages WHERE conversation_id=?")
      .get(id)?.time;
    const createdAt =
      display?.createdAt ??
      saved?.createdAt ??
      new Date(
        Math.max(timestamp, typeof previous === "string" ? Date.parse(previous) : 0),
      ).toISOString();
    const attributedRun = display?.runId ?? metadata?.runId ?? saved?.runId ?? run?.id;
    if (!saved)
      this.store.put("durable-display", String(entry.id), { createdAt, runId: attributedRun });
    const message: Message = {
      ...display,
      id: display?.id ?? `${id}:${entry.id}`,
      conversationId: id,
      role: display?.role ?? (m!.role as Message["role"]),
      text,
      createdAt,
      delivery: "delivered",
      entryId: String(entry.id),
      runId: attributedRun,
    };
    if (display)
      this.store.db
        .prepare("INSERT OR IGNORE INTO chat_delivered VALUES (?,?)")
        .run(id, display.id);
    const changed = this.put(message);
    if (changed) this.events.emit({ type: "message", message: changed });
  }
  private put(message: Message): Message | undefined {
    const value = JSON.stringify(message);
    const previous = this.store.db
      .prepare("SELECT value FROM chat_messages WHERE conversation_id=? AND id=?")
      .get(message.conversationId, message.id);
    const row = this.store.db
      .prepare(
        `INSERT INTO chat_messages(conversation_id,id,created_at,value) VALUES(?,?,?,?) ON CONFLICT(conversation_id,id) DO UPDATE SET value=excluded.value RETURNING position`,
      )
      .get(message.conversationId, message.id, message.createdAt, value)!;
    return previous?.value === value ? undefined : { ...message, sequence: Number(row.position) };
  }
  pending(id: string): Message[] {
    return this.store.db
      .prepare(
        `SELECT value FROM records r WHERE kind='input-receipt' AND json_extract(value,'$.conversationId')=? AND NOT EXISTS(SELECT 1 FROM chat_delivered d WHERE d.conversation_id=? AND d.input_id=r.id) ORDER BY r.rowid`,
      )
      .all(id, id)
      .map((r) => JSON.parse(r.value as string));
  }
  async discardPending(id: string, ids: string[]) {
    const conversation = await this.get(id);
    for (const inputId of ids) {
      const record = await this.harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, inputId),
        context,
      );
      if (record) {
        const result = await this.harness.abortSubmission(record.id, context, conversation.id);
        if (result === "already_placed") throw new Error("This message was already delivered.");
      } else if (!this.pending(id).some((m) => m.id === inputId))
        throw new Error("This message was already delivered.");
      this.store.transaction(() => {
        this.store.delete("input-receipt", inputId);
        this.store.delete("input-content", inputId);
        this.store.db
          .prepare("DELETE FROM chat_messages WHERE conversation_id=? AND id=?")
          .run(id, inputId);
      });
    }
    this.events.emit({ type: "messages-reset", conversationId: id });
  }
  async history(id: string): Promise<EntryRecord[]> {
    const conversation = await this.get(id);
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 200, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return entries.reverse();
  }
  async leaf(id: string) {
    return (await (await this.get(id)).entries({}, 1, undefined, context)).items[0]?.id;
  }
  async fork(sourceId: string, targetId: string, entryId?: string) {
    const source = await this.get(sourceId);
    const leaf = entryId ? (Number(entryId) as EntryId) : await this.leaf(sourceId);
    if (!leaf || !(await this.history(sourceId)).some((e) => e.id === leaf))
      throw Object.assign(new Error("Choose a delivered message to branch from."), {
        statusCode: 400,
      });
    const child = await source.fork(
      leaf,
      {
        ownership: { kind: "ownerless" },
        init: async (tx, id) => {
          (await tx.doc(IdentityDoc, id)).id = targetId;
        },
      },
      context,
    );
    this.remember(targetId, child);
    this.opening.set(targetId, Promise.resolve(child));
    await this.synchronize(targetId);
  }
  private async synchronize(id: string) {
    const conversation = await this.get(id);
    const hasRows = this.store.db
      .prepare("SELECT 1 FROM chat_messages WHERE conversation_id=? LIMIT 1")
      .get(id);
    const previous = hasRows ? this.store.get<number>("durable-index", id) : undefined;
    // Receipts recover the admission/reference crash window using request IDs.
    const receipts: Message[] = previous
      ? this.pending(id)
      : this.store.db
          .prepare(
            "SELECT value FROM records WHERE kind='input-receipt' AND json_extract(value,'$.conversationId')=?",
          )
          .all(id)
          .map((r) => JSON.parse(r.value as string));
    for (const input of receipts) {
      const record = await this.harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, input.id),
        context,
      );
      if (record) this.indexSubmission(record);
    }
    let cursor: Cursor | undefined;
    const entries: EntryRecord[] = [];
    do {
      const page = await conversation.entries(
        previous ? { minEntryId: (previous + 1) as EntryId } : {},
        200,
        cursor,
        context,
      );
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    for (const entry of entries.reverse()) this.indexEntry(id, entry);
    for (const pending of this.pending(id)) this.put(pending);
    const newest = entries.at(-1)?.id ?? previous;
    if (newest) this.store.put("durable-index", id, newest);
  }
  async export(id: string) {
    await this.synchronize(id);
    return this.store.db
      .prepare(
        "SELECT position,value FROM chat_messages WHERE conversation_id=? ORDER BY created_at,position",
      )
      .all(id)
      .map((r) => ({ ...JSON.parse(r.value as string), sequence: Number(r.position) }) as Message);
  }
  async search(query: string) {
    for (const c of this.store.list<Conversation>("conversation")) await this.synchronize(c.id);
    return this.store.db
      .prepare(
        "SELECT DISTINCT conversation_id FROM chat_messages WHERE instr(lower(json_extract(value,'$.text')),lower(?))>0 LIMIT 100",
      )
      .all(query)
      .map((r) => r.conversation_id as string);
  }
  async page(id: string, limit = 50, before?: string): Promise<Page<Message>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid message page size.");
    let cursor: [string, string, number] | undefined;
    if (before)
      try {
        const v = JSON.parse(Buffer.from(before, "base64url").toString());
        if (
          !Array.isArray(v) ||
          v.length !== 3 ||
          v[0] !== id ||
          typeof v[1] !== "string" ||
          !Number.isSafeInteger(v[2])
        )
          throw new Error();
        cursor = v as [string, string, number];
      } catch {
        throw Object.assign(new Error("Invalid conversation cursor."), { statusCode: 400 });
      }
    await this.synchronize(id);
    const rows = cursor
      ? this.store.db
          .prepare(
            "SELECT position,value FROM chat_messages WHERE conversation_id=? AND (created_at,position)<(?,?) ORDER BY created_at DESC,position DESC LIMIT ?",
          )
          .all(id, cursor[1], cursor[2], limit + 1)
      : this.store.db
          .prepare(
            "SELECT position,value FROM chat_messages WHERE conversation_id=? ORDER BY created_at DESC,position DESC LIMIT ?",
          )
          .all(id, limit + 1);
    const items = rows
      .slice(0, limit)
      .map((r) => ({ ...JSON.parse(r.value as string), sequence: Number(r.position) }) as Message);
    const oldest = items.at(-1);
    return {
      items: items.reverse(),
      ...(rows.length > limit && oldest
        ? {
            next: Buffer.from(JSON.stringify([id, oldest.createdAt, oldest.sequence])).toString(
              "base64url",
            ),
          }
        : {}),
    };
  }
  async publishMessages(id: string) {
    await this.synchronize(id);
  }
}
