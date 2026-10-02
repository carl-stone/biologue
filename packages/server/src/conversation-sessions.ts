import { randomUUID } from "node:crypto";
import type { Message as PiMessage, ImageContent } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  InboxDoc,
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
import { InputsDoc, RunsDoc, type InputReceipt, type StoredRun } from "./durable-state.ts";

/** Persisted alongside the transcript so creation can be reconciled after a crash. */
export const IdentityDoc = defineDoc({
  kind: "biologue.identity",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "" }),
});
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
  private inputs = new Map<string, InputReceipt>();
  private entryInputs = new Map<number, Message>();
  private lastRun = new Map<string, string>();
  constructor(
    private store: Store,
    private events: Events,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      position INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      created_at TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(conversation_id,id));
      CREATE INDEX IF NOT EXISTS chat_messages_page ON chat_messages(conversation_id,created_at,position);`);
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
        const entries = publication.changes
          .flatMap((change) => (change.type === "entry" ? [change.value] : []))
          .sort((a, b) => a.id - b.id);
        for (const entry of entries) {
          const id = this.ids.get(entry.conversationId);
          if (id) this.indexEntry(id, entry);
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
      await this.loadInputs(conversation);
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
        if (identity?.id === id) {
          const conversation = (await this.harness.conversation(candidate.id, context))!;
          await this.loadInputs(conversation);
          return this.remember(id, conversation);
        }
      }
      cursor = page.next;
    } while (cursor);
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          (await tx.doc(IdentityDoc, conversationId)).id = id;
        },
      },
      context,
    );
    return this.remember(id, conversation);
  }
  private remember(id: string, conversation: DurableConversation) {
    this.ids.set(conversation.id, id);
    this.store.put("durable-conversation", id, { id: conversation.id });
    return conversation;
  }
  async accept(
    id: string,
    text: string,
    runId: string,
    extra?: {
      queue?: Message["queue"];
      attachments?: Attachment[];
      prepared?: { text: string; images: ImageContent[] };
    },
    run?: StoredRun,
  ): Promise<Message> {
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
    const conversation = await this.get(id);
    const receipt: InputReceipt = {
      message,
      content: { text: extra?.prepared?.text ?? text, images: extra?.prepared?.images ?? [] },
      conversation: conversation.id,
    };
    await conversation.commit(async (tx) => {
      (await tx.doc(InputsDoc, conversation.id)).receipts.push(JSON.parse(JSON.stringify(receipt)));
      if (run)
        (await tx.doc(RunsDoc, conversation.id)).current = JSON.parse(
          JSON.stringify({ ...run, inputId: message.id }),
        );
    }, context);
    this.inputs.set(message.id, receipt);
    try {
      this.put(message);
    } catch (error) {
      // Native acceptance has committed. A display cache cannot revoke it.
      console.error("Accepted input display failed", error);
    }
    this.events.emit({ type: "message", message });
    return message;
  }
  content(input: Message): { text: string; images: ImageContent[] } {
    return this.inputs.get(input.id)?.content ?? { text: input.text, images: [] };
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
    await this.publishMessages(input.conversationId);
    return submission;
  }
  private indexSubmission(record: SubmissionRecord) {
    if (record.type !== "input" || !record.requestId || !record.entry) return;
    const input = this.inputs.get(record.requestId)?.message;
    if (!input) return;
    this.entryInputs.set(record.entry, input);
    this.put({ ...input, delivery: "delivered", entryId: String(record.entry) });
    this.events.emit({
      type: "message",
      message: { ...input, delivery: "delivered", entryId: String(record.entry) },
    });
  }
  private indexEntry(id: string, entry: EntryRecord) {
    const data = entry.data as { display?: Message } | undefined;
    const input = this.entryInputs.get(entry.id);
    const messages = entry.model ?? [];
    const m = messages.find((m) => m.role === "user" || m.role === "assistant");
    const display = input ?? data?.display;
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
    const attributedRun =
      display?.runId ??
      saved?.runId ??
      (m?.role === "assistant" ? this.lastRun.get(id) : undefined);
    if (m?.role === "user") {
      if (display?.runId) this.lastRun.set(id, display.runId);
      else this.lastRun.delete(id);
    }
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
  async inputCount(id: string) {
    const state = await this.harness.snapshot(InputsDoc, (await this.get(id)).id, context);
    return (
      state?.receipts.filter((r) => !r.discarded && r.message.conversationId === id).length ?? 0
    );
  }
  receipt(id: string) {
    return this.inputs.get(id)?.message;
  }
  private async loadInputs(conversation: DurableConversation) {
    const state = await this.harness.snapshot(InputsDoc, conversation.id, context);
    const receipts: InputReceipt[] = JSON.parse(JSON.stringify(state?.receipts ?? []));
    if (!receipts.length) return { receipts, pending: [] as Message[] };
    const pending = await this.harness.commit(async (tx) => {
      const pending: Message[] = [];
      const delivered: string[] = [];
      for (const receipt of receipts) {
        this.inputs.set(receipt.message.id, receipt);
        if (receipt.restoredEntry) {
          this.entryInputs.set(receipt.restoredEntry, receipt.message);
          if (receipt.content) delivered.push(receipt.message.id);
        }
        const record = await tx.submissionByRequest(
          receipt.conversation as ConversationId,
          receipt.message.id,
        );
        if (record?.entry) {
          this.entryInputs.set(record.entry, receipt.message);
          if (receipt.content) delivered.push(receipt.message.id);
        }
        if (
          receipt.conversation === conversation.id &&
          !receipt.discarded &&
          !receipt.restoredEntry &&
          !record?.entry
        )
          pending.push(receipt.message);
      }
      // Once placed, the native transcript owns expanded text and image bytes.
      // Keep only the original display identity in the application receipt.
      if (delivered.length) {
        const state = await tx.doc(InputsDoc, conversation.id);
        for (const receipt of state.receipts)
          if (delivered.includes(receipt.message.id)) {
            delete receipt.content;
            this.inputs.set(receipt.message.id, JSON.parse(JSON.stringify(receipt)));
          }
      }
      return pending;
    }, context);
    return { receipts, pending };
  }
  async pending(id: string): Promise<Message[]> {
    return (await this.loadInputs(await this.get(id))).pending;
  }
  async restore(input: Message) {
    const conversation = await this.get(input.conversationId);
    await conversation.commit(async (tx) => {
      const receipt = (await tx.doc(InputsDoc, conversation.id)).receipts.find(
        (r) => r.message.id === input.id,
      );
      if (!receipt || receipt.discarded) throw new Error("The accepted input is missing.");
      if (receipt.restoredEntry) return;
      const content = this.content(input);
      const entry = await tx.appendEntry(conversation.id, {
        kind: "biologue.import.user",
        model: [
          {
            role: "user",
            content: [{ type: "text", text: content.text }, ...content.images],
            timestamp: Date.parse(input.createdAt),
          },
        ],
        data: JSON.parse(JSON.stringify({ display: input })),
      });
      receipt.restoredEntry = entry.id;
    }, context);
    await this.publishMessages(input.conversationId);
  }
  async discardPending(id: string, ids: string[]) {
    const conversation = await this.get(id);
    await conversation.commit(async (tx) => {
      // Read all records before the first table write. Native inbox withdrawal
      // and app metadata share one transaction, including a multi-message clear.
      const records = await Promise.all(
        ids.map((inputId) => tx.submissionByRequest(conversation.id, inputId)),
      );
      const inputs = await tx.doc(InputsDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const selected = ids.map((inputId, index) => {
        const receipt = inputs.receipts.find(
          (r) => r.message.id === inputId && r.conversation === conversation.id,
        );
        const record = records[index];
        if (!receipt || receipt.restoredEntry || record?.entry)
          throw new Error("This message was already delivered.");
        return { receipt, record };
      });
      for (const { receipt, record } of selected) {
        if (record?.status === "queued") {
          tx.settleSubmission(record.id, { status: "unanswered", reason: "aborted" });
          inbox.items = inbox.items.filter((item) => item.id !== record.id);
        }
        receipt.discarded = true;
        delete receipt.content;
      }
    }, context);
    await this.publishMessages(id);
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
    const { receipts, pending } = await this.loadInputs(conversation);
    // Seed an incremental rebuild from the last displayed native input. Its
    // identity resolves to native receipt metadata, including inherited inputs.
    this.lastRun.delete(id);
    if (previous) {
      const last = this.store.db
        .prepare(
          "SELECT id FROM chat_messages WHERE conversation_id=? AND json_extract(value,'$.role')='user' AND json_extract(value,'$.delivery')='delivered' ORDER BY CAST(json_extract(value,'$.entryId') AS INTEGER) DESC LIMIT 1",
        )
        .get(id);
      const runId = last && this.inputs.get(String(last.id))?.message.runId;
      if (runId) this.lastRun.set(id, runId);
    }
    for (const receipt of receipts)
      if (receipt.discarded)
        this.store.db
          .prepare("DELETE FROM chat_messages WHERE conversation_id=? AND id=?")
          .run(id, receipt.message.id);
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
    for (const input of pending) this.put(input);
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
    try {
      await this.synchronize(id);
    } catch (error) {
      console.error("Durable conversation display failed", error);
    }
  }
}
