import { randomUUID } from "node:crypto";
import type {
  PermissionRequest,
  PermissionDecision,
  PermissionDecisionSummary,
} from "@carl/protocol";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";

export class Permissions {
  private pending = new Map<
    string,
    {
      request: PermissionRequest;
      finish: (decision: PermissionDecision["decision"], feedback?: string) => Error | undefined;
    }
  >();
  constructor(
    private store: Store,
    private events: Events,
  ) {}
  list() {
    return [...this.pending.values()].map((item) => item.request);
  }
  get(id: string) {
    return this.pending.get(id)?.request ?? this.store.get<PermissionDecision>("permission", id);
  }
  history(): PermissionDecisionSummary[] {
    return this.store.db
      .prepare(
        `
      SELECT json_remove(value, '$.code', '$.before') AS value FROM
      (SELECT rowid, value FROM records WHERE kind = 'permission' ORDER BY rowid DESC LIMIT 100)
      ORDER BY rowid
    `,
      )
      .all()
      .map((row) => JSON.parse(row.value as string));
  }
  request(input: Omit<PermissionRequest, "id" | "createdAt">, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Agent run cancelled."));
    const request: PermissionRequest = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      const abort = () => {
        try {
          this.resolve(request.id, "cancelled");
        } catch {
          // The waiter and UI receive the persistence error; never throw from an abort listener.
        }
      };
      const finish = (decision: PermissionDecision["decision"], feedback?: string) => {
        signal?.removeEventListener("abort", abort);
        let failure: Error | undefined;
        const record: PermissionDecision = {
          ...request,
          decision,
          resolvedAt: new Date().toISOString(),
          ...(feedback ? { feedback } : {}),
        };
        try {
          this.store.put("permission", request.id, record);
        } catch (cause) {
          failure = new Error(
            `Could not record permission decision: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        // An allowance is usable only after its decision is durable.
        if (failure) reject(failure);
        else if (decision === "allow") resolve();
        else
          reject(
            new Error(
              feedback
                ? `Permission declined. Scientist requested changes: ${feedback}`
                : decision === "cancelled"
                  ? "Agent run cancelled."
                  : "Permission was declined.",
            ),
          );
        const { code: _code, before: _before, ...resolution } = record;
        this.events.emit({
          type: "permission-resolved",
          id: request.id,
          ...(failure ? { error: failure.message } : { resolution }),
        });
        return failure;
      };
      this.pending.set(request.id, { request, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.events.emit({ type: "permission", request });
    });
  }
  decide(id: string, allow: boolean, feedback?: string) {
    return this.resolve(id, allow ? "allow" : "deny", allow ? undefined : feedback);
  }
  private resolve(id: string, decision: PermissionDecision["decision"], feedback?: string) {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    const failure = item.finish(decision, feedback);
    if (failure) throw failure;
    return true;
  }
  cancelRun(runId: string) {
    const failures: unknown[] = [];
    for (const item of this.list()) {
      if (item.runId !== runId) continue;
      try {
        this.resolve(item.id, "cancelled");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Could not record cancelled permission decisions.");
  }
}
