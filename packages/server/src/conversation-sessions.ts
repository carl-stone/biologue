import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Conversation, Message, Page } from "@carl/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";

/** Application metadata lives outside model-visible content, via Pi's message_end hook. */
export type CarlMessage = AgentMessage & {
  carl?: { inputId?: string; chatId?: string; runId?: string; contextVersion?: number };
};
type SessionReference = { file: string; sdkVersion: string; persisted: boolean };

export function messageText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

/** Pi owns transcripts. SQLite holds input receipts until they appear in that transcript. */
export class ConversationSessions {
  private managers = new Map<string, SessionManager>();
  private indexed = new Map<string, { sessionId: string; leafId: string | null }>();
  private directory: string;
  constructor(
    private project: string,
    stateDir: string,
    private store: Store,
    private events: Events,
  ) {
    this.directory = join(stateDir, "pi", "sessions");
    mkdirSync(this.directory, { recursive: true });
    // Rebuildable UI projection. Pi entries remain the canonical delivered history.
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL,
        generation TEXT NOT NULL DEFAULT '', UNIQUE (conversation_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_messages_page ON chat_messages(conversation_id, created_at, position);
      CREATE TABLE IF NOT EXISTS chat_delivered (
        conversation_id TEXT NOT NULL, input_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, input_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_receipts ON records(json_extract(value, '$.conversationId'))
        WHERE kind = 'input-receipt';
    `);
  }

  get(conversationId: string): SessionManager {
    if (!this.store.get<Conversation>("conversation", conversationId))
      throw new Error("Conversation does not exist.");
    const cached = this.managers.get(conversationId);
    if (cached) return cached;
    const reference = this.store.get<SessionReference>("pi-session", conversationId);
    if (reference?.persisted && !existsSync(reference.file))
      throw new Error(
        "The Pi session file is missing. Restore it before continuing this conversation.",
      );
    const restoring = reference && existsSync(reference.file);
    const manager = restoring
      ? SessionManager.open(reference.file, this.directory, this.project)
      : SessionManager.create(this.project, this.directory);
    if (!restoring) this.importLegacy(conversationId, manager);
    this.managers.set(conversationId, manager);
    this.checkpoint(conversationId);
    return manager;
  }

  checkpoint(conversationId: string) {
    const manager = this.managers.get(conversationId)!;
    const file = manager.getSessionFile()!;
    const previous = this.store.get<SessionReference>("pi-session", conversationId);
    this.store.put<SessionReference>("pi-session", conversationId, {
      file,
      sdkVersion: "0.87.1",
      persisted: !!previous?.persisted || existsSync(file),
    });
  }

  private importLegacy(conversationId: string, manager: SessionManager) {
    const oldMessages = this.store
      .list<Message>("message")
      .filter((item) => item.conversationId === conversationId);
    const remaining = [...oldMessages];
    const transcript = this.store.get<AgentMessage[]>("transcript", conversationId) ?? [];
    for (const message of transcript) {
      if (!["system", "user", "assistant", "toolResult"].includes(message.role)) continue;
      const text = messageText(message);
      const match = remaining.findIndex((item) => item.role === message.role && item.text === text);
      const display = match >= 0 ? remaining.splice(match, 1)[0] : undefined;
      const attributed: CarlMessage = {
        ...message,
        ...(display ? { carl: { chatId: display.id, runId: display.runId } } : {}),
      };
      manager.appendMessage(attributed as PiMessage);
    }
    // Preserve display-only messages too, including corrections lost by the old steering queue.
    for (const message of remaining) {
      manager.appendCustomMessageEntry(
        "carl.legacy-chat",
        `Recovered ${message.role} message:\n${message.text}`,
        false,
        { message },
      );
    }
    if (transcript.length || oldMessages.length)
      manager.appendCustomEntry("carl.legacy-import", { version: 1, conversationId });
  }

  accept(conversationId: string, text: string, runId: string): Message {
    this.synchronize(conversationId);
    const message: Message = {
      id: randomUUID(),
      conversationId,
      role: "user",
      text,
      runId,
      createdAt: new Date().toISOString(),
      delivery: "pending",
    };
    this.store.transaction(() => {
      this.store.put("input-receipt", message.id, message);
      this.put(message);
    });
    this.events.emit({ type: "message", message });
    return message;
  }

  private pendingInputs(conversationId: string): Message[] {
    return this.store.db
      .prepare(
        `SELECT value FROM records r
      WHERE kind = 'input-receipt' AND json_extract(value, '$.conversationId') = ?
      AND NOT EXISTS (SELECT 1 FROM chat_delivered d WHERE d.conversation_id = ? AND d.input_id = r.id)
      ORDER BY r.rowid`,
      )
      .all(conversationId, conversationId)
      .map((row) => JSON.parse(row.value as string) as Message);
  }

  pending(conversationId: string): Message[] {
    this.synchronize(conversationId);
    return this.pendingInputs(conversationId);
  }

  /** Restore earlier accepted inputs through Pi's canonical history before a new prompt. */
  restorePending(conversationId: string, exceptInputId: string) {
    const manager = this.get(conversationId);
    for (const input of this.pending(conversationId)) {
      if (input.id === exceptInputId) continue;
      const message: CarlMessage = {
        role: "user",
        content: input.text,
        timestamp: Date.parse(input.createdAt),
        carl: { inputId: input.id, runId: input.runId },
      };
      manager.appendMessage(message as PiMessage);
    }
  }

  /** Keep interrupted tool batches valid without replaying an operation of uncertain outcome. */
  reconcileInterruptedTools(conversationId: string) {
    const manager = this.get(conversationId);
    const projection = manager.buildSessionProjection();
    const answered = new Set(
      projection.messages.flatMap((message) =>
        message.role === "toolResult" ? [message.toolCallId] : [],
      ),
    );
    for (const entry of projection.entries) {
      const message = entry.messages.find((message) => message.role === "assistant");
      if (!message || message.role !== "assistant") continue;
      const missing = message.content.filter(
        (block) => block.type === "toolCall" && !answered.has(block.id),
      );
      if (!missing.length) continue;
      manager.appendContextEdit(entry.sourceEntry.id, {
        content: [
          ...message.content.filter((block) => block.type !== "toolCall" || answered.has(block.id)),
          {
            type: "text",
            text: "Tool calls were interrupted; their effects are unknown. Check recorded executions and current state before retrying.",
          },
        ],
      });
    }
  }

  private projectEntry(
    conversationId: string,
    manager: SessionManager,
    entry: SessionEntry,
  ): Message | undefined {
    if (entry.type === "custom_message" && entry.customType === "carl.legacy-chat") {
      const legacy = entry.details as { message: Message };
      return { ...legacy.message, delivery: "delivered" };
    }
    if (entry.type !== "message") return;
    const message = entry.message as CarlMessage;
    if (message.role !== "user" && message.role !== "assistant") return;
    const input = message.carl?.inputId
      ? this.store.get<Message>("input-receipt", message.carl.inputId)
      : undefined;
    const legacy = message.carl?.chatId
      ? this.store.get<Message>("message", message.carl.chatId)
      : undefined;
    const text = input?.text ?? messageText(message);
    if (!text) return;
    return {
      id: input?.id ?? message.carl?.chatId ?? `${manager.getSessionId()}:${entry.id}`,
      conversationId,
      role: message.role,
      text,
      runId: input?.runId ?? message.carl?.runId,
      createdAt: input?.createdAt ?? legacy?.createdAt ?? entry.timestamp,
      delivery: "delivered",
    };
  }

  private put(message: Message, generation?: string): Message | undefined {
    const value = JSON.stringify(message);
    const previous = this.store.db
      .prepare("SELECT position, value FROM chat_messages WHERE conversation_id = ? AND id = ?")
      .get(message.conversationId, message.id);
    const row = this.store.db
      .prepare(
        `INSERT INTO chat_messages (conversation_id, id, created_at, value, generation)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(conversation_id, id) DO UPDATE SET
      created_at = excluded.created_at, value = excluded.value,
      generation = CASE WHEN ? IS NULL THEN generation ELSE excluded.generation END RETURNING position`,
      )
      .get(
        message.conversationId,
        message.id,
        message.createdAt,
        value,
        generation ?? "",
        generation ?? null,
      )!;
    message.sequence = Number(row.position);
    return previous?.value !== value ? message : undefined;
  }

  private delivered(conversationId: string, entry: SessionEntry) {
    if (entry.type !== "message") return;
    const inputId = (entry.message as CarlMessage).carl?.inputId;
    if (inputId)
      this.store.db
        .prepare(`INSERT OR IGNORE INTO chat_delivered VALUES (?, ?)`)
        .run(conversationId, inputId);
  }

  /** Index only entries since the last observed Pi leaf. A branch change rebuilds the view. */
  private synchronize(conversationId: string) {
    const manager = this.get(conversationId);
    const previous = this.indexed.get(conversationId);
    const sessionId = manager.getSessionId(),
      leafId = manager.getLeafId();
    if (previous?.sessionId === sessionId && previous.leafId === leafId) return;
    const added: SessionEntry[] = [];
    let cursor = leafId;
    if (previous?.sessionId === sessionId) {
      while (cursor && cursor !== previous.leafId) {
        const entry = manager.getEntry(cursor);
        if (!entry) throw new Error("The Pi session contains a missing parent entry.");
        added.push(entry);
        cursor = entry.parentId;
      }
    }
    const rebuild = !previous || previous.sessionId !== sessionId || cursor !== previous.leafId;
    const changes: Message[] = [];
    const generation = rebuild ? randomUUID() : undefined;
    this.checkpoint(conversationId);
    this.store.transaction(() => {
      if (rebuild) {
        this.store.db
          .prepare("DELETE FROM chat_delivered WHERE conversation_id = ?")
          .run(conversationId);
        // Include receipts consumed on other branches so they never become pending again.
        for (const entry of manager.getEntries()) this.delivered(conversationId, entry);
      }
      for (const entry of rebuild ? manager.getBranch() : added.reverse()) {
        if (!rebuild) this.delivered(conversationId, entry);
        const message = this.projectEntry(conversationId, manager, entry);
        const changed = message && this.put(message, generation);
        if (changed) changes.push(changed);
      }
      if (rebuild) {
        for (const message of this.pendingInputs(conversationId)) this.put(message, generation);
        this.store.db
          .prepare("DELETE FROM chat_messages WHERE conversation_id = ? AND generation != ?")
          .run(conversationId, generation!);
      }
    });
    this.indexed.set(conversationId, { sessionId, leafId });
    if (rebuild) {
      if (previous) this.events.emit({ type: "messages-reset", conversationId });
    } else {
      for (const message of changes) this.events.emit({ type: "message", message });
    }
  }

  page(conversationId: string, limit = 50, before?: string): Page<Message> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid message page size.");
    let cursor: [string, string, number] | undefined;
    if (before) {
      try {
        const value: unknown = JSON.parse(Buffer.from(before, "base64url").toString());
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value[0] !== conversationId ||
          typeof value[1] !== "string" ||
          !Number.isSafeInteger(value[2])
        )
          throw new Error();
        cursor = value as [string, string, number];
      } catch {
        throw Object.assign(new Error("Invalid conversation cursor."), { statusCode: 400 });
      }
    }
    this.synchronize(conversationId);
    const rows = cursor
      ? this.store.db
          .prepare(
            `SELECT position, value FROM chat_messages WHERE conversation_id = ?
          AND (created_at, position) < (?, ?) ORDER BY created_at DESC, position DESC LIMIT ?`,
          )
          .all(conversationId, cursor[1], cursor[2], limit + 1)
      : this.store.db
          .prepare(
            `SELECT position, value FROM chat_messages WHERE conversation_id = ?
          ORDER BY created_at DESC, position DESC LIMIT ?`,
          )
          .all(conversationId, limit + 1);
    const messages = rows
      .slice(0, limit)
      .map(
        (row) =>
          ({ ...JSON.parse(row.value as string), sequence: Number(row.position) }) as Message,
      );
    const oldest = messages.at(-1);
    return {
      items: messages.reverse(),
      ...(rows.length > limit && oldest
        ? {
            next: Buffer.from(
              JSON.stringify([conversationId, oldest.createdAt, oldest.sequence]),
            ).toString("base64url"),
          }
        : {}),
    };
  }

  publishMessages(conversationId: string) {
    this.synchronize(conversationId);
  }
}
