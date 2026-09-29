import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRun, Message, ResearchContext } from "@carl/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import type { Documents } from "./documents.ts";
import { Conflict } from "./documents.ts";
import type { ContextService } from "./context.ts";
import type { ExecutionService } from "./execution.ts";
import type { Permissions } from "./permissions.ts";
import type { PiAdapter } from "./pi.ts";
import { ConversationSessions, type CarlMessage } from "./conversation-sessions.ts";
import { workspaceTools } from "./workspace-tools.ts";

type ActiveRun = {
  run: AgentRun;
  incoming: Message[];
  session?: AgentSession;
  lastAssistant?: AssistantMessage;
  integrationError?: Error;
  ready: Promise<void>;
  markReady: () => void;
  completion: Promise<void>;
  stopping?: Promise<void>;
};

export class Supervisor {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  constructor(
    private store: Store,
    private events: Events,
    private context: ContextService,
    private documents: Documents,
    private execution: ExecutionService,
    private permissions: Permissions,
    private pi: PiAdapter,
    private prompt: string,
    readonly sessions: ConversationSessions,
  ) {
    for (const run of store.list<AgentRun>("run"))
      if (run.status === "running")
        store.put("run", run.id, {
          ...run,
          status: "abandoned",
          endReason: "interrupted",
          finishedAt: new Date().toISOString(),
          error: "Application stopped during this run. It was not resumed automatically.",
        });
  }

  start(conversationId: string, text: string): AgentRun {
    if (this.closing) throw new Conflict("The application is shutting down.");
    if (!this.context.hasConversation(conversationId))
      throw new Error("Conversation does not exist.");
    if (!this.pi.status().enabled)
      throw new Error("Configure CARL_PROVIDER and CARL_MODEL to enable the collaborator.");
    if ([...this.active.values()].some((item) => item.run.conversationId === conversationId))
      throw new Conflict("A collaborator run is already active in this conversation.");
    this.execution.context.begin(conversationId);
    const manager = this.sessions.get(conversationId);
    this.sessions.reconcileInterruptedTools(conversationId);
    // Old accepted inputs precede this prompt. Never execute unfinished historical tool calls.
    this.sessions.restorePending(conversationId, "");
    const research = this.context.get();
    const run: AgentRun = {
      id: randomUUID(),
      conversationId,
      status: "running",
      startedAt: new Date().toISOString(),
      contextVersion: research.version,
      piSessionId: manager.getSessionId(),
    };
    const input = this.sessions.accept(conversationId, text, run.id);
    this.context.firstTitle(conversationId, text);
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const active: ActiveRun = {
      run,
      incoming: [input],
      ready,
      markReady,
      completion: Promise.resolve(),
    };
    this.store.transaction(() => {
      this.store.put("run-input", run.id, {
        schemaVersion: 1,
        piSdkVersion: "0.87.1",
        piSessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
        fromEntryId: manager.getLeafId(),
        inputId: input.id,
        prompt: this.prompt,
        researchContext: research,
        model: this.pi.status(),
      });
      this.store.put("run", run.id, run);
    });
    // No active slot exists until startup metadata is durable. The accepted input remains
    // recoverable if this transaction fails before a model session is started.
    this.active.set(run.id, active);
    active.completion = Promise.resolve().then(() => this.perform(active, input, research));
    this.events.emit({ type: "agent-run", run: { ...run } });
    return run;
  }

  private async perform(active: ActiveRun, input: Message, research: ResearchContext) {
    const { run } = active;
    const cancelled = () => run.status === "cancelled";
    let unsubscribe: (() => void) | undefined;
    try {
      const manager = this.sessions.get(run.conversationId);
      const session = await this.pi.create({
        manager,
        prompt: this.prompt,
        research,
        tools: (skills) =>
          workspaceTools(run, this.documents, this.execution, this.permissions, skills),
        attributeMessage: (message) => {
          const accepted = message.role === "user" ? active.incoming.shift() : undefined;
          return {
            ...message,
            carl: {
              ...(message as CarlMessage).carl,
              ...(accepted ? { inputId: accepted.id } : {}),
              runId: run.id,
              contextVersion: research.version,
            },
          } as CarlMessage;
        },
        onContext: (messages) => {
          this.execution.context.observeContext(run.conversationId, messages);
          const id = randomUUID();
          this.store.put("run-request", id, {
            id,
            runId: run.id,
            piSessionId: manager.getSessionId(),
            leafEntryId: manager.getLeafId(),
            contextVersion: research.version,
            createdAt: new Date().toISOString(),
            model: active.session?.model
              ? { provider: active.session.model.provider, id: active.session.model.id }
              : this.pi.status(),
            tools: active.session
              ?.getAllTools()
              .map((tool) => ({ name: tool.name, parameters: tool.parameters })),
            inputIds: messages.flatMap((message) => {
              const inputId = (message as CarlMessage).carl?.inputId;
              return inputId ? [inputId] : [];
            }),
          });
        },
        onError: (error) => {
          this.failure(active, "Pi integration", error);
          void this.stop(active);
        },
      });
      active.session = session;
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
          this.events.emit({
            type: "agent-delta",
            runId: run.id,
            delta: event.assistantMessageEvent.delta,
          });
        if (event.type === "message_end") {
          if (event.message.role === "assistant") active.lastAssistant = event.message;
          // Session listeners run before Pi appends the finalized message. Publish its projection afterward.
          queueMicrotask(() => {
            if (!this.active.has(run.id)) return;
            try {
              this.sessions.publishMessages(run.conversationId);
            } catch (error) {
              this.failure(active, "Conversation update", error);
              void this.stop(active);
            }
          });
        }
      });
      active.markReady();
      if (cancelled()) return;
      if (active.integrationError) throw active.integrationError;
      await session.prompt(input.text, {
        expandPromptTemplates: false,
        // Pi's preflight can await auth or compaction before its abortable loop starts.
        // Use the SDK's RPC preflight hook to honor a stop during that interval too.
        preflightResult: (accepted) => {
          if (!accepted) return;
          if (active.integrationError) throw active.integrationError;
          if (cancelled()) throw new Error("Run cancelled before the model turn started.");
        },
      });
      await session.waitForIdle();
      if (active.integrationError) throw active.integrationError;
      if (!cancelled()) {
        const last = active.lastAssistant;
        if (last?.stopReason === "stop") {
          run.status = "completed";
          run.endReason = "response";
        } else {
          run.status = "failed";
          run.endReason =
            last?.stopReason === "length"
              ? "truncated"
              : last?.stopReason === "error"
                ? "provider_error"
                : "interrupted";
          run.error =
            last?.errorMessage ||
            (last?.stopReason === "length"
              ? "The model response was truncated after Pi's recovery attempts. Send a follow-up to continue."
              : "The agent stopped without completing a response.");
        }
      }
    } catch (error) {
      if (run.status !== "cancelled") {
        run.status = "failed";
        run.endReason = active.integrationError ? "integration_error" : "provider_error";
        run.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      active.markReady();
      // Each step is independent: a failed disposal or write must not strand the run.
      if (active.stopping) await active.stopping;
      this.attempt(active, "Unsubscribe", () => unsubscribe?.());
      this.attempt(active, "Clear queued messages", () => active.session?.clearQueue());
      this.attempt(active, "Dispose Pi session", () => active.session?.dispose());
      this.attempt(active, "Cancel permissions", () => this.permissions.cancelRun(run.id));
      this.attempt(active, "Conversation update", () =>
        this.sessions.publishMessages(run.conversationId),
      );
      run.finishedAt = new Date().toISOString();
      this.active.delete(run.id);
      this.publish(active);
      if (run.status === "completed") {
        try {
          this.context.refreshTitle(
            run.conversationId,
            this.sessions.page(run.conversationId, 12).items,
            (messages) => this.pi.conversationTitle(messages),
          );
        } catch {
          /* A display title must never change the outcome of a response. */
        }
      }
    }
  }

  private failure(active: ActiveRun, operation: string, cause: unknown) {
    const message = `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`;
    active.integrationError ??= new Error(message);
    active.run.error = active.run.error ? `${active.run.error}\n${message}` : message;
    if (active.run.status !== "cancelled") {
      active.run.status = "failed";
      active.run.endReason = "integration_error";
    }
  }

  private attempt(active: ActiveRun, operation: string, action: () => unknown) {
    try {
      action();
    } catch (error) {
      this.failure(active, operation, error);
    }
  }

  private publish(active: ActiveRun) {
    try {
      this.store.put("run", active.run.id, active.run);
    } catch (error) {
      this.failure(active, "Record agent run", error);
      // A transient failure may allow a durable failure record. Either way, report it live.
      try {
        this.store.put("run", active.run.id, active.run);
      } catch {
        console.error(`Agent run ${active.run.id}: ${active.run.error}`);
      }
    }
    this.events.emit({ type: "agent-run", run: { ...active.run } });
  }

  private stop(active: ActiveRun): Promise<void> {
    return (active.stopping ??= (async () => {
      this.attempt(active, "Cancel permissions", () => this.permissions.cancelRun(active.run.id));
      await active.ready;
      // abort waits for tools, so request both stops before waiting for either.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => active.session?.abort()),
        Promise.resolve().then(() => this.execution.cancelRun(active.run.id)),
      ]);
      for (const result of results)
        if (result.status === "rejected") this.failure(active, "Stop agent work", result.reason);
    })());
  }

  async cancel(id: string) {
    const active = this.active.get(id);
    if (!active) return;
    active.run.status = "cancelled";
    active.run.endReason = "cancelled";
    const stopped = this.stop(active);
    this.publish(active);
    await stopped;
    await active.completion;
  }

  async steer(id: string, text: string) {
    const active = this.active.get(id);
    if (!active || active.run.status !== "running")
      throw new Conflict("This run is no longer active.");
    const input = this.sessions.accept(active.run.conversationId, text, id);
    active.incoming.push(input);
    await active.ready;
    if (active.run.status === "running") await active.session?.steer(text);
    // A cancellation during startup leaves a durable pending receipt for the next run.
  }

  async close() {
    this.closing = true;
    const results = await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Could not close all agent runs.");
  }
}
