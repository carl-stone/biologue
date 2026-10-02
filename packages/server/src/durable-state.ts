import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentRun, Message } from "@biologue/protocol";
import type { JsonRepresentation } from "@earendil-works/chord";

export type InputReceipt = {
  message: Message;
  content?: { text: string; images: ImageContent[] };
};

/** Only unsent/queued inputs live here; native submissions own delivery state. */
export const InputsDoc = defineDoc({
  kind: "biologue.pending-inputs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ receipts: [] as JsonRepresentation<InputReceipt>[], count: 0 }),
});

/** Original text and attachments, keyed by native entry; no parallel delivery archive. */
export const MessageDisplay = defineDocFamily({
  kind: "biologue.message-display",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ display: null as JsonRepresentation<Message> | null }),
});

export type StoredRun = { run: AgentRun; inputId?: string; compactionId?: number };
/** Latest UI run identity, not a scheduler or another task journal. */
export const RunsDoc = defineDoc({
  kind: "biologue.runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ current: null as JsonRepresentation<StoredRun> | null }),
});
