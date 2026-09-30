import type { Message, Page } from "@biologue/protocol";

export interface ConversationHistoryState {
  conversationId: string;
  items: Message[];
  next?: string;
  loading: boolean;
  loaded: boolean;
  error: string;
}
const initial = (): ConversationHistoryState => ({
  conversationId: "",
  items: [],
  loading: false,
  loaded: false,
  error: "",
});
function merge(older: Message[], newer: Message[]): Message[] {
  const messages = new Map(older.map((message) => [message.id, message]));
  for (const message of newer) {
    const previous = messages.get(message.id);
    if (previous?.delivery === "delivered" && message.delivery === "pending") continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      (a.sequence ?? 0) - (b.sequence ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** Only the selected conversation is retained. Late pages cannot overwrite live deliveries. */
export class ConversationHistory {
  state = initial();
  private generation = 0;
  constructor(
    private fetchPage: (id: string, before?: string) => Promise<Page<Message>>,
    private changed: (state: ConversationHistoryState) => void,
  ) {}
  private update(change: Partial<ConversationHistoryState>) {
    this.state = { ...this.state, ...change };
    this.changed(this.state);
  }
  async select(conversationId: string, refresh = false) {
    if (!refresh && this.state.conversationId === conversationId) return;
    this.generation++;
    this.state = { ...initial(), conversationId };
    this.changed(this.state);
    if (conversationId) await this.load();
  }
  async load() {
    if (this.state.loading || !this.state.conversationId || (this.state.loaded && !this.state.next))
      return;
    const generation = this.generation;
    const { conversationId, next } = this.state;
    this.update({ loading: true, error: "" });
    try {
      const page = await this.fetchPage(conversationId, next);
      if (generation !== this.generation) return;
      this.update({ items: merge(page.items, this.state.items), next: page.next, loaded: true });
    } catch (error) {
      if (generation === this.generation)
        this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (generation === this.generation) this.update({ loading: false });
    }
  }
  receive(message: Message) {
    if (message.conversationId !== this.state.conversationId) return;
    this.update({ items: merge(this.state.items, [message]) });
  }
}
