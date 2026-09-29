import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "@carl/protocol";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";

export class Permissions {
  private pending = new Map<
    string,
    { request: PermissionRequest; finish: (allow: boolean) => Error | undefined }
  >();
  constructor(
    private store: Store,
    private events: Events,
  ) {}
  list() {
    return [...this.pending.values()].map((item) => item.request);
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
          this.decide(request.id, false);
        } catch {
          // The waiter and UI receive the persistence error; never throw from an abort listener.
        }
      };
      const finish = (allow: boolean) => {
        signal?.removeEventListener("abort", abort);
        let failure: Error | undefined;
        try {
          this.store.put("permission", request.id, {
            ...request,
            decision: allow ? "allow" : "deny",
            resolvedAt: new Date().toISOString(),
          });
        } catch (cause) {
          failure = new Error(
            `Could not record permission decision: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        // An allowance is usable only after its decision is durable.
        if (failure) reject(failure);
        else if (allow) resolve();
        else reject(new Error("Permission was declined or the run was cancelled."));
        this.events.emit({
          type: "permission-resolved",
          id: request.id,
          ...(failure ? { error: failure.message } : {}),
        });
        return failure;
      };
      this.pending.set(request.id, { request, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.events.emit({ type: "permission", request });
    });
  }
  decide(id: string, allow: boolean) {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    const failure = item.finish(allow);
    if (failure) throw failure;
    return true;
  }
  cancelRun(runId: string) {
    const failures: unknown[] = [];
    for (const item of this.list()) {
      if (item.runId !== runId) continue;
      try {
        this.decide(item.id, false);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Could not record cancelled permission decisions.");
  }
}
