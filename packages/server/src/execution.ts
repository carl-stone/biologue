import { randomUUID } from "node:crypto";
import type { Actor, Execution, ExecutionSummary, Language } from "@biologue/protocol";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";
import { digest } from "./documents.ts";
import { ExecutionRepository, summarize } from "./execution-repository.ts";
import type { OutputService, KernelOutput } from "./outputs.ts";
export type { KernelOutput } from "./outputs.ts";

export interface KernelBackend {
  /** Session configuration is queued and recorded by ExecutionService, never run here. */
  setupCode?(language: Language): string | undefined;
  execute(
    language: Language,
    code: string,
    output: (value: KernelOutput) => void,
    /** Must run synchronously before dispatch; throwing prevents code from being sent. */
    started: (identity: { sessionId: string; kernelId: string; kernelGeneration?: string }) => void,
    signal: AbortSignal,
  ): Promise<void>;
  interrupt(language: Language): Promise<void>;
  /** Confirm an idle live kernel without executing scientific code. */
  reconcile?(language: Language, signal: AbortSignal): Promise<boolean>;
  /** Release local request listeners; this does not stop the kernel process. */
  abandon?(language: Language): void;
}
type Submission = {
  language: Language;
  actor: Actor;
  code: string;
  purpose?: Execution["purpose"];
  inspection?: Execution["inspection"];
  inspectionOptions?: Execution["inspectionOptions"];
  document?: Execution["document"];
  runId?: string;
  toolCallId?: string;
  conversationId?: string;
  beforeDispatch?: () => void;
};
type Job = {
  record: Execution;
  abort: AbortController;
  settled: boolean;
  dispatched: boolean;
  promise: Promise<Execution>;
  resolve: (record: Execution) => void;
  reject: (error: Error) => void;
  stopping?: Promise<void>;
  beforeDispatch?: () => void;
};

/** Sole owner of kernel submissions and their lifetime, for every actor. */
export class ExecutionService {
  readonly repository: ExecutionRepository;
  private queues: Record<Language, Job[]> = { python: [], r: [] };
  private active = new Map<Language, Job>();
  private jobs = new Map<string, Job>();
  private failures = new Map<string, Error>();
  private uncertain = new Map<Language, ExecutionSummary>();
  private closing = false;
  private closed?: Promise<void>;
  constructor(
    store: Store,
    private events: Events,
    private kernel: KernelBackend,
    readonly outputs: OutputService,
    private cancellationTimeoutMs = 2000,
  ) {
    this.repository = new ExecutionRepository(store);
    for (const record of this.repository.unfinished())
      this.repository.update({
        ...record,
        status: "abandoned",
        kernelUncertain: record.status === "running" || record.kernelUncertain,
        finishedAt: new Date().toISOString(),
        error:
          "The application stopped before completion was recorded. Kernel state may have changed; this code was not replayed.",
      });
    for (const record of this.repository.uncertain()) this.uncertain.set(record.language, record);
  }
  submit(input: Submission): Execution {
    if (this.closing) throw new Error("Execution service is shutting down.");
    const { beforeDispatch, ...submission } = input;
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
    const setupCode =
      input.purpose === "setup" ? undefined : this.kernel.setupCode?.(input.language);
    const setup = setupCode
      ? this.submit({
          language: input.language,
          actor: "system",
          purpose: "setup",
          code: setupCode,
          runId: input.runId,
        })
      : undefined;
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
      dispatched: false,
      beforeDispatch: setup
        ? () => {
            const configured = this.get(setup.id);
            if (configured?.status !== "succeeded")
              throw new Error(
                `Session setup did not complete; code was not run. ${configured?.error ?? configured?.status ?? "Setup missing."}`,
              );
            if (configured.kernelGeneration !== record.kernelGeneration)
              throw new Error("Kernel restarted after session setup. Code was not run; retry it.");
            beforeDispatch?.();
          }
        : beforeDispatch,
    };
    this.jobs.set(record.id, job);
    this.events.emit({ type: "execution", execution: summarize(record) });
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
    this.events.emit({ type: "execution", execution: summarize(record) });
  }
  private async reconcile(language: Language) {
    const record = this.uncertain.get(language);
    if (!record) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        Promise.resolve().then(() => this.kernel.reconcile?.(language, abort.signal) ?? false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.cancellationTimeoutMs);
        }),
      ]);
      if (!ready || this.closing || this.uncertain.get(language) !== record)
        throw new Error(
          `${language} session completion is unknown. Wait for the kernel to finish or reconnect, then retry.`,
        );
      // Persist recovery before allowing another dispatch; the original outcome stays unknown.
      this.repository.update({ ...record, kernelUncertain: false });
      this.uncertain.delete(language);
    } finally {
      abort.abort();
      if (timer) clearTimeout(timer);
    }
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
      abort.signal.throwIfAborted();
      if (job.settled) return;
      await this.reconcile(language);
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
            job.dispatched = true;
            this.publish(record);
          } else throw new Error("Execution was cancelled before kernel dispatch.");
        },
        abort.signal,
      );
      if (captureError) throw captureError;
      if (!job.settled) {
        record.status = "succeeded";
        if (abort.signal.aborted)
          record.error =
            "Cancellation was requested, but the code reported normal completion. Later statements may have run; review the results and live objects.";
      }
    } catch (error) {
      if (!job.settled) {
        record.status = abort.signal.aborted
          ? job.dispatched
            ? "interrupted"
            : "cancelled"
          : "failed";
        record.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try {
        this.finish(job);
      } finally {
        if (this.active.get(language) === job) this.active.delete(language);
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
      await (job.stopping ??= this.stop(job));
    } else {
      this.queues[job.record.language] = this.queues[job.record.language].filter(
        (item) => item !== job,
      );
      job.record.status = "cancelled";
      this.finish(job);
    }
  }
  private async stop(job: Job) {
    job.abort.abort();
    // Interrupt acknowledgement is not confirmation that execution ended.
    void Promise.resolve()
      .then(() => this.kernel.interrupt(job.record.language))
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.promise.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.cancellationTimeoutMs);
        }),
      ]);
      if (job.settled) return;
      const { record } = job;
      record.status = !job.dispatched ? "cancelled" : "completion_unknown";
      if (record.status === "completion_unknown") {
        record.kernelUncertain = true;
        record.error =
          "Interrupt did not confirm completion. Code may still be running; this session requires a readiness check before further execution.";
        this.uncertain.set(record.language, record);
      }
      this.finish(job);
      try {
        this.kernel.abandon?.(record.language);
      } catch {
        /* Quarantine still prevents dispatch. */
      }
      if (this.active.get(record.language) === job) this.active.delete(record.language);
      void this.drain(record.language);
    } finally {
      if (timer) clearTimeout(timer);
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
          job.record.kernelUncertain = job.dispatched;
          job.record.error =
            "Shutdown could not confirm kernel completion. Kernel state may have changed; this code will not be replayed.";
          this.finish(job);
        }
      this.active.clear();
    }
  }
}
