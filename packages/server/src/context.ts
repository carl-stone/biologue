import { randomUUID } from "node:crypto";
import type { Conversation, ResearchContext, Message } from "@carl/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import { Conflict } from "./documents.ts";

export class ContextService {
  private titleJobs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private store: Store,
    private events: Events,
  ) {
    if (!store.get("context", "project"))
      store.put<ResearchContext>("context", "project", {
        text: "",
        version: 0,
        updatedAt: new Date().toISOString(),
      });
    if (!store.list("conversation").length) this.createConversation();
  }
  createConversation(title?: string) {
    const id = randomUUID();
    const conversation = this.store.put<Conversation>("conversation", id, {
      id,
      title: title || "New conversation",
      titleMode: title ? "manual" : "automatic",
      createdAt: new Date().toISOString(),
    });
    this.events.emit({ type: "conversation", conversation });
    return conversation;
  }
  renameConversation(id: string, title: string) {
    const previous = this.store.get<Conversation>("conversation", id);
    if (!previous) throw new Error("Conversation does not exist.");
    return this.publishTitle({ ...previous, title, titleMode: "manual" });
  }
  updateConversation(
    id: string,
    changes: Partial<Pick<Conversation, "archived" | "pinned" | "settings" | "parentId">>,
  ) {
    const previous = this.store.get<Conversation>("conversation", id);
    if (!previous) throw new Error("Conversation does not exist.");
    return this.publishTitle({ ...previous, ...changes });
  }
  private publishTitle(conversation: Conversation) {
    this.store.put("conversation", conversation.id, conversation);
    this.events.emit({ type: "conversation", conversation });
    return conversation;
  }
  firstTitle(id: string, text: string) {
    const previous = this.store.get<Conversation>("conversation", id)!;
    if (previous.titleMode === "automatic" && previous.title === "New conversation")
      this.publishTitle({ ...previous, title: text.replace(/\s+/g, " ").slice(0, 70).trim() });
  }
  refreshTitle(
    id: string,
    messages: Message[],
    generate: (messages: Message[]) => Promise<string>,
  ) {
    if (this.closed || this.titleJobs.has(id)) return;
    const previous = this.store.get<Conversation>("conversation", id)!;
    if (previous.titleMode !== "automatic") return;
    const count = Number(
      this.store.db
        .prepare(
          "SELECT count(*) AS count FROM records WHERE kind = 'input-receipt' AND json_extract(value, '$.conversationId') = ?",
        )
        .get(id)!.count,
    );
    if (previous.titledThrough && count < previous.titledThrough + 4) return;
    const job = (async () => {
      try {
        const title = (await generate(messages))
          .replace(/\s+/g, " ")
          .replace(/^["“]|["”]$/g, "")
          .trim()
          .slice(0, 120);
        if (this.closed || !title) return;
        const current = this.store.get<Conversation>("conversation", id)!;
        // A manual rename always wins over an in-flight suggestion.
        if (current.titleMode === "automatic")
          this.publishTitle({ ...current, title, titledThrough: count });
      } catch {
        /* Naming must never fail the conversation. Keep the useful initial title. */
      }
    })().finally(() => this.titleJobs.delete(id));
    this.titleJobs.set(id, job);
  }
  close() {
    this.closed = true;
  }
  hasConversation(id: string) {
    return this.store.list<Conversation>("conversation").some((item) => item.id === id);
  }
  get() {
    return this.store.get<ResearchContext>("context", "project")!;
  }
  update(text: string, expectedVersion: number) {
    const previous = this.get();
    if (previous.version !== expectedVersion)
      throw new Conflict("Research context changed. Review the latest version before updating.");
    const context = { text, version: previous.version + 1, updatedAt: new Date().toISOString() };
    this.store.transaction(() => {
      this.store.put("context-revision", String(context.version), context);
      this.store.put("context", "project", context);
    });
    this.events.emit({ type: "context", context });
    return context;
  }
}
