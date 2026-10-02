import type { Language, Execution } from "@biologue/protocol";
import type { Events } from "./events.ts";
import type { ExecutionService } from "./execution.ts";
import { adapters } from "./adapters.ts";

/** Coalesced UI refreshes, recorded in the same queue as every other kernel action. */
export class EnvironmentService {
  private watched = new Set<Language>();
  private dirty = new Set<Language>();
  private current = new Map<Language, Execution>();
  private pending = new Set<Language>();
  private timers = new Map<Language, ReturnType<typeof setTimeout>>();
  private unsubscribe: () => void;
  private closed = false;
  constructor(
    private execution: ExecutionService,
    events: Events,
  ) {
    this.unsubscribe = events.subscribe((event) => {
      if (event.type !== "execution" || event.execution.purpose !== "analysis") return;
      const record = event.execution;
      if (["running", "queued", "cancelled"].includes(record.status)) return;
      this.dirty.add(record.language);
      if (this.watched.has(record.language)) this.schedule(record.language);
    });
  }
  refresh(language: Language) {
    this.watched.add(language);
    if (!this.current.has(language)) this.dirty.add(language);
    if (this.dirty.has(language) && !this.pending.has(language)) this.start(language);
    return this.current.get(language) ?? null;
  }
  private schedule(language: Language) {
    clearTimeout(this.timers.get(language));
    this.timers.set(
      language,
      setTimeout(() => {
        this.timers.delete(language);
        if (!this.closed && !this.pending.has(language) && this.dirty.has(language))
          this.start(language);
      }, 150),
    );
  }
  private start(language: Language) {
    this.dirty.delete(language);
    this.pending.add(language);
    const record = this.execution.submit({
      language,
      actor: "system",
      purpose: "inspection",
      inspection: "environment",
      inspectionOptions: { offset: 0 },
      code: adapters[language].inspectionCode({ offset: 0 }),
    });
    this.current.set(language, record);
    void this.execution
      .wait(record.id)
      .then((result) => this.current.set(language, result))
      .catch(() => {})
      .finally(() => {
        this.pending.delete(language);
        if (!this.closed && this.dirty.has(language)) this.schedule(language);
      });
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }
}
