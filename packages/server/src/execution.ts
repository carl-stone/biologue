import { randomUUID } from "node:crypto";
import type { Actor, Execution, Language } from "@carl/protocol";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";
import { digest } from "./documents.ts";
import { ExecutionRepository, summarize, displaySummary } from "./execution-repository.ts";
import type { OutputService, KernelOutput } from "./outputs.ts";
import { analyzeCode, emptyEffects, type CodeEffects } from "./code-effects.ts";
import { StaleContext, type ContextAcknowledgment } from "./stale-context.ts";
export type { KernelOutput } from "./outputs.ts";

export interface KernelBackend {
  execute(
    language: Language,
    code: string,
    output: (value: KernelOutput) => void,
    /** Must run synchronously before dispatch; throwing prevents code from being sent. */
    started: (identity: { sessionId: string; kernelId: string; kernelGeneration?: string }) => void,
    signal: AbortSignal,
  ): Promise<void>;
  interrupt(language: Language): Promise<void>;
}
type Submission = {
  language: Language;
  actor: Actor;
  code: string;
  purpose?: Execution["purpose"];
  inspection?: Execution["inspection"];
  document?: Execution["document"];
  runId?: string;
  toolCallId?: string;
  conversationId?: string;
  acknowledgment?: ContextAcknowledgment;
  beforeDispatch?: () => void;
};
type Job = {
  record: Execution;
  abort: AbortController;
  settled: boolean;
  promise: Promise<Execution>;
  resolve: (record: Execution) => void;
  reject: (error: Error) => void;
  effects: Promise<CodeEffects>;
  acknowledgment?: ContextAcknowledgment;
  beforeDispatch?: () => void;
};
class ContextReviewRequired extends Error {}

/** Sole owner of kernel submissions and their lifetime, for every actor. */
export class ExecutionService {
  readonly repository: ExecutionRepository;
  readonly context: StaleContext;
  private queues: Record<Language, Job[]> = { python: [], r: [] };
  private active = new Map<Language, Job>();
  private jobs = new Map<string, Job>();
  private failures = new Map<string, Error>();
  private closing = false;
  private closed?: Promise<void>;
  constructor(
    store: Store,
    private events: Events,
    private kernel: KernelBackend,
    readonly outputs: OutputService,
  ) {
    this.repository = new ExecutionRepository(store);
    this.context = new StaleContext(store, this.repository);
    this.repository.migrate((record) => {
      for (const output of record.outputs) outputs.append(record, output, output);
      outputs.complete(record);
      outputs.removeLegacyCopies(record.outputs);
      const decoded = outputs.result(record.id);
      if (decoded && !record.inspection)
        this.repository.update({ ...summarize(record), inspection: decoded.kind });
    });
    for (const record of this.repository.unfinished())
      this.repository.update({
        ...record,
        status: "abandoned",
        finishedAt: new Date().toISOString(),
        error:
          "The application stopped before completion was recorded. Kernel state may have changed; this code was not replayed.",
      });
  }
  submit(input: Submission): Execution {
    if (this.closing) throw new Error("Execution service is shutting down.");
    const { acknowledgment, beforeDispatch, ...submission } = input;
    const record: Execution = {
      ...submission,
      id: randomUUID(),
      purpose: input.purpose ?? "analysis",
      codePreview: "",
      codeHash: digest(input.code),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    record.codePreview = summarize(record).codePreview;
    this.repository.create(record); // Nothing is queued unless its exact source is durable.
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<Execution>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A caller may attach wait() after a synchronous failure; keep that rejection handled.
    void promise.catch(() => {});
    const job: Job = {
      record,
      abort: new AbortController(),
      promise,
      resolve,
      reject,
      settled: false,
      acknowledgment,
      beforeDispatch,
      effects:
        input.purpose === "inspection" && input.inspection
          ? Promise.resolve(emptyEffects())
          : analyzeCode(input.language, input.code),
    };
    this.jobs.set(record.id, job);
    this.events.emit({ type: "execution", execution: displaySummary(summarize(record)) });
    this.queues[record.language].push(job);
    void this.drain(record.language);
    return structuredClone(record);
  }
  get(id: string) {
    return this.repository.get(id);
  }
  async wait(id: string): Promise<Execution> {
    const job = this.jobs.get(id);
    if (job) return job.promise;
    if (this.failures.has(id)) throw this.failures.get(id);
    const record = this.get(id);
    if (!record) throw new Error("Execution does not exist.");
    return record;
  }
  private publish(record: Execution) {
    this.repository.update(summarize(record));
    this.events.emit({ type: "execution", execution: displaySummary(summarize(record)) });
  }
  private finish(job: Job) {
    if (job.settled) return;
    job.settled = true;
    job.record.finishedAt = new Date().toISOString();
    try {
      this.outputs.complete(job.record);
      this.publish(job.record);
      job.resolve(structuredClone(job.record));
    } catch (cause) {
      const error = new Error(
        `Could not record execution ${job.record.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      job.record.status = "failed";
      job.record.error = error.message;
      // Best effort final record, without misreporting a persistence failure as success.
      try {
        this.publish(job.record);
      } catch {
        /* Startup marks any durable unfinished record abandoned. */
      }
      this.failures.set(job.record.id, error);
      job.reject(error);
    } finally {
      this.jobs.delete(job.record.id);
    }
  }
  private async drain(language: Language) {
    if (this.closing || this.active.has(language)) return;
    const job = this.queues[language].shift();
    if (!job) return;
    const { record, abort } = job;
    this.active.set(language, job);
    let captureError: unknown;
    try {
      const effects = await job.effects;
      abort.signal.throwIfAborted();
      if (job.settled) return;
      record.status = "running";
      record.startedAt = new Date().toISOString();
      this.publish(record);
      await this.kernel.execute(
        language,
        record.code,
        (value) => {
          if (job.settled || captureError) return;
          try {
            this.outputs.append(record, value);
          } catch (error) {
            captureError = error;
            // Jupyter callbacks are not guaranteed to propagate failures to future.done.
            void this.kernel.interrupt(language).catch(() => {});
          }
        },
        (identity) => {
          if (!job.settled) {
            abort.signal.throwIfAborted();
            Object.assign(record, identity);
            job.beforeDispatch?.();
            const epoch = identity.kernelGeneration ?? `${identity.sessionId}:${identity.kernelId}`;
            if (
              record.actor === "agent" &&
              record.purpose === "analysis" &&
              record.conversationId
            ) {
              record.contextCheck = this.context.check(record, effects, epoch, job.acknowledgment);
              if (record.contextCheck.disposition === "review")
                throw new ContextReviewRequired(
                  "Not executed: review the relevant runtime changes, inspect affected objects, or acknowledge this warning before retrying.",
                );
            }
            record.activitySequence = this.context.started(record, effects, epoch);
            this.publish(record);
          } else throw new Error("Execution was cancelled before kernel dispatch.");
        },
        abort.signal,
      );
      if (captureError) throw captureError;
      if (!job.settled) record.status = abort.signal.aborted ? "interrupted" : "succeeded";
    } catch (error) {
      if (!job.settled) {
        record.status =
          error instanceof ContextReviewRequired
            ? "not_executed"
            : abort.signal.aborted
              ? "interrupted"
              : "failed";
        if (record.status === "not_executed") delete record.startedAt;
        record.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try {
        this.finish(job);
      } finally {
        this.active.delete(language);
        void this.drain(language);
      }
    }
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      if (!this.get(id)) throw new Error("Execution does not exist.");
      return;
    }
    if (this.active.get(job.record.language) === job) {
      job.abort.abort();
      await Promise.race([
        this.kernel.interrupt(job.record.language),
        job.promise.then(
          () => {},
          () => {},
        ),
      ]);
    } else {
      this.queues[job.record.language] = this.queues[job.record.language].filter(
        (item) => item !== job,
      );
      job.record.status = "cancelled";
      this.finish(job);
    }
  }
  async cancelRun(runId: string) {
    const jobs = [...this.jobs.values()].filter((job) => job.record.runId === runId);
    for (const job of jobs.sort(
      (a, b) =>
        Number(this.active.get(a.record.language) === a) -
        Number(this.active.get(b.record.language) === b),
    ))
      await this.cancel(job.record.id);
  }
  close(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = this.shutdown(timeoutMs);
    return this.closed;
  }
  private async shutdown(timeoutMs: number) {
    const jobs = [...this.jobs.values()];
    // Remove all queued work before interrupting either language.
    for (const language of ["python", "r"] as const) {
      for (const job of this.queues[language].splice(0)) {
        job.record.status = "cancelled";
        this.finish(job);
      }
    }
    const interrupts = [...this.active.values()].map(async (job) => {
      job.abort.abort();
      await this.kernel.interrupt(job.record.language);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...interrupts, ...jobs.map((job) => job.promise)]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      for (const job of jobs)
        if (!job.settled) {
          job.record.status = "abandoned";
          job.record.error =
            "Shutdown could not confirm kernel completion. Kernel state may have changed; this code will not be replayed.";
          this.finish(job);
        }
      this.active.clear();
    }
  }
}
