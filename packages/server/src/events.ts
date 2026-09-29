import type { AppEvent } from "@carl/protocol";

/** Notifications must never control execution or persistence lifetimes. */
export class Events {
  private listeners = new Set<(event: AppEvent) => void>();
  constructor(
    private onError: (error: unknown) => void = (error) =>
      console.error("Event subscriber failed", error),
  ) {}
  emit(event: AppEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          /* Error reporting is also isolated. */
        }
      }
    }
  }
  subscribe(listener: (event: AppEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
