import { randomUUID, createHash } from "node:crypto";
import type { AgentQuestion, AgentRun } from "@biologue/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import { Conflict } from "./documents.ts";

/** Browser questions bound to native Durable tool call identities. */
export class ExtensionDialogs {
  private pending = new Map<
    string,
    { question: AgentQuestion; finish: (answer?: string) => void }
  >();
  constructor(
    private store: Store,
    private events: Events,
  ) {}
  list() {
    return [...this.pending.values()].map((item) => item.question);
  }
  answer(id: string, answer?: string) {
    const item = this.pending.get(id);
    if (!item) throw new Conflict("This question is no longer waiting.");
    if (answer !== undefined && item.question.options && !item.question.options.includes(answer))
      throw Object.assign(new Error("Choose an available answer."), { statusCode: 400 });
    this.store.put("question-answer", id, {
      ...item.question,
      answer,
      answeredAt: new Date().toISOString(),
    });
    item.finish(answer);
    return { ok: true };
  }
  cancelRun(runId: string) {
    for (const item of this.pending.values()) if (item.question.runId === runId) item.finish();
  }
  ask(
    run: AgentRun,
    callId: string,
    kind: AgentQuestion["kind"],
    title: string,
    options?: string[],
    placeholder?: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) {
    return new Promise<string | undefined>((resolve) => {
      if (opts?.signal?.aborted) return resolve(undefined);
      const hash =
        callId &&
        createHash("sha256")
          .update(JSON.stringify([run.id, callId, 1]))
          .digest("hex");
      const id = hash
        ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
        : randomUUID();
      const saved = this.store.get<AgentQuestion & { answer?: string }>("question-answer", id);
      if (saved) return resolve(saved.answer);
      const question = this.store.get<AgentQuestion>("question-pending", id) ?? {
        id,
        runId: run.id,
        conversationId: run.conversationId,
        kind,
        title,
        options,
        placeholder,
      };
      // Stable per-call IDs let a safely replayed ask_user consume an already
      // committed answer, or redisplay the same unanswered question after restart.
      this.store.put("question-pending", id, question);
      let timer: NodeJS.Timeout | undefined;
      const cancel = () => finish();
      const finish = (answer?: string) => {
        if (!this.pending.delete(question.id)) return;
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", cancel);
        this.events.emit({ type: "question-resolved", id: question.id });
        resolve(answer);
      };
      this.pending.set(question.id, { question, finish });
      opts?.signal?.addEventListener("abort", cancel, { once: true });
      if (opts?.timeout) timer = setTimeout(cancel, opts.timeout);
      this.events.emit({ type: "question", question });
    });
  }
  notify(run: AgentRun, text: string, level: "info" | "warning" | "error" = "info") {
    run.notices = [...(run.notices ?? []), { text, level }].slice(-20);
    try {
      this.store.put("run", run.id, run);
    } catch (error) {
      console.error("Run notice display failed", error);
    }
    this.events.emit({ type: "agent-run", run: { ...run } });
  }
}
