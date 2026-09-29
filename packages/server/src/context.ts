import { randomUUID } from "node:crypto";
import type { Conversation, ResearchContext } from "@carl/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import { Conflict } from "./documents.ts";

export class ContextService {
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
    if (!store.list("conversation").length) this.createConversation("First investigation");
  }
  createConversation(title: string) {
    const id = randomUUID();
    const conversation = this.store.put<Conversation>("conversation", id, {
      id,
      title,
      createdAt: new Date().toISOString(),
    });
    this.events.emit({ type: "conversation", conversation });
    return conversation;
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
