import { defineDoc } from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentRun, Message } from "@biologue/protocol";
import type { JsonRepresentation } from "@earendil-works/chord";

export type InputReceipt = {
  message: Message;
  content: { text: string; images: ImageContent[] };
  conversation: number;
  restoredEntry?: number;
  discarded?: boolean;
};

/** App metadata lives with native history; submission records own delivery state. */
export const InputsDoc = defineDoc({
  kind: "biologue.inputs",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ receipts: [] as JsonRepresentation<InputReceipt>[] }),
});

export type StoredRun = { run: AgentRun; prompt: string; inputId?: string; compactionId?: number };
/** UI identity and scientific policy, not a scheduler or another task journal. */
export const RunsDoc = defineDoc({
  kind: "biologue.runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runs: [] as JsonRepresentation<StoredRun>[] }),
});
