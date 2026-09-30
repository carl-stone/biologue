import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRun, Message, ResearchContext, Conversation, Attachment } from "@carl/protocol";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ExtensionDialogs } from "./extension-ui.ts";
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
  readonly dialogs: ExtensionDialogs;
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
    this.dialogs = new ExtensionDialogs(store, events);
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

  start(
    conversationId: string,
    text: string,
    options?: {
      kind?: "compaction";
      prepared?: { text: string; images: ImageContent[] };
      attachments?: Attachment[];
    },
  ): AgentRun {
    if (this.closing) throw new Conflict("The application is shutting down.");
    if (!this.context.hasConversation(conversationId))
      throw new Error("Conversation does not exist.");
    const conversation = this.store.get<Conversation>("conversation", conversationId)!;
    const defaults = this.pi.status();
    const settings =
      conversation.settings ??
      (defaults.provider && defaults.model
        ? {
            provider: defaults.provider,
            model: defaults.model,
            thinking: defaults.thinking,
            mode: "ask" as const,
          }
        : undefined);
    if (!settings)
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
      settings,
      kind: options?.kind ?? "response",
    };
    const input =
      options?.kind === "compaction"
        ? undefined
        : this.sessions.accept(conversationId, text, run.id, options);
    if (input) this.context.firstTitle(conversationId, text);
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const active: ActiveRun = {
      run,
      incoming: input ? [input] : [],
      ready,
      markReady,
      completion: Promise.resolve(),
    };
    this.store.transaction(() => {
      this.store.put("run-input", run.id, {
        schemaVersion: 1,
        piSdkVersion: "0.99.1",
        piSessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
        fromEntryId: manager.getLeafId(),
        inputId: input?.id,
        prompt: this.prompt,
        researchContext: research,
        model: settings,
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

  private async perform(active: ActiveRun, input: Message | undefined, research: ResearchContext) {
    const { run } = active;
    const cancelled = () => run.status === "cancelled";
    let unsubscribe: (() => void) | undefined;
    let handled = false;
    try {
      const manager = this.sessions.get(run.conversationId);
      const session = await this.pi.create({
        manager,
        prompt: this.prompt,
        research,
        settings: run.settings,
        ui: this.dialogs.context(run),
        extensions: [
          (pi) => {
            // Native MCP and nested codemode calls pass through the same permission pipeline.
            pi.on("tool_call", async (event, ctx) => {
              if (
                !event.toolName.startsWith("mcp__") &&
                ![
                  "read_mcp_resource",
                  "list_mcp_resources",
                  "list_mcp_resource_templates",
                ].includes(event.toolName)
              )
                return;
              const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
              if (definition?.annotations?.readOnlyHint) return;
              try {
                await this.permissions.request(
                  {
                    runId: run.id,
                    conversationId: run.conversationId,
                    tool: event.toolName,
                    toolCallId: event.toolCallId,
                    description: `Call ${event.toolName}`,
                    code: JSON.stringify(event.input, null, 2),
                  },
                  ctx.signal,
                );
              } catch (error) {
                return {
                  block: true,
                  reason: error instanceof Error ? error.message : String(error),
                };
              }
            });
          },
        ],
        tools: (skills) =>
          workspaceTools(run, this.documents, this.execution, this.permissions, skills),
        attributeMessage: (message) => {
          const index = active.incoming.findIndex((item) => !item.queue || item.queue === "steer");
          const accepted =
            message.role === "user"
              ? active.incoming.splice(index < 0 ? 0 : index, 1)[0]
              : undefined;
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
        if (event.type === "tool_execution_start") {
          run.activity = [
            ...(run.activity ?? []),
            {
              id: event.toolCallId,
              tool: event.toolName,
              label: event.toolName.replace(/_/g, " "),
              status: "running",
            },
          ].slice(-40) as AgentRun["activity"];
          this.publish(active);
        }
        if (event.type === "tool_execution_end") {
          run.activity = run.activity?.map((item) =>
            item.id === event.toolCallId
              ? { ...item, status: event.isError ? "failed" : "completed" }
              : item,
          );
          this.publish(active);
        }
        if (event.type === "compaction_start") {
          run.phase = "compacting";
          this.publish(active);
        }
        if (event.type === "compaction_end") {
          run.phase = "working";
          this.publish(active);
        }
        if (event.type === "auto_retry_start") {
          run.phase = "retrying";
          run.phaseDetail = `Retry ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1000)}s`;
          this.publish(active);
        }
        if (event.type === "auto_retry_end") {
          run.phase = "working";
          delete run.phaseDetail;
          this.publish(active);
        }
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
              this.updateUsage(active);
              this.publish(active);
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
      const content = input && this.sessions.content(input);
      if (content?.images.length && !session.model?.input.includes("image"))
        throw new Error(
          "This model does not accept images. Choose a vision model or remove the image.",
        );
      if (run.kind === "compaction") await session.compact();
      else
        await session.prompt(content!.text, {
          images: content!.images,
          expandPromptTemplates: true,
          // Pi's preflight can await auth or compaction before its abortable loop starts.
          // Use the SDK's RPC preflight hook to honor a stop during that interval too.
          preflightResult: (accepted) => {
            if (accepted === "handled") {
              handled = true;
              if (input) this.sessions.discardPending(run.conversationId, [input.id]);
            }
            if (!accepted) return;
            if (active.integrationError) throw active.integrationError;
            if (cancelled()) throw new Error("Run cancelled before the model turn started.");
          },
        });
      await session.waitForIdle();
      if (active.integrationError) throw active.integrationError;
      if (!cancelled()) {
        const last = active.lastAssistant;
        if (handled || run.kind === "compaction" || last?.stopReason === "stop") {
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
      this.attempt(active, "Update usage", () => this.updateUsage(active));
      this.dialogs.cancelRun(run.id);
      this.attempt(active, "Clear queued messages", () => active.session?.clearQueue());
      try {
        if (active.session) await this.pi.dispose(active.session);
      } catch (error) {
        this.failure(active, "Dispose Pi session", error);
      }
      this.attempt(active, "Cancel permissions", () => this.permissions.cancelRun(run.id));
      this.attempt(active, "Conversation update", () =>
        this.sessions.publishMessages(run.conversationId),
      );
      run.finishedAt = new Date().toISOString();
      this.active.delete(run.id);
      this.publish(active);
      if (run.status === "completed" && run.kind !== "compaction" && !handled) {
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
  private updateUsage(active: ActiveRun) {
    if (!active.session) return;
    const stats = active.session.getSessionStats();
    active.run.usage = {
      tokens: stats.tokens,
      cost: stats.cost,
      context: active.session.getContextUsage(),
    };
  }
  isActive(conversationId?: string) {
    return [...this.active.values()].some(
      (item) => !conversationId || item.run.conversationId === conversationId,
    );
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
      this.dialogs.cancelRun(active.run.id);
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

  async steer(
    id: string,
    text: string,
    mode: "steer" | "followUp" = "steer",
    extra?: { attachments?: Attachment[]; prepared?: { text: string; images: ImageContent[] } },
  ) {
    const active = this.active.get(id);
    if (!active || active.run.status !== "running")
      throw new Conflict("This run is no longer active.");
    if (/^\/mcp(?:\s|$)/.test(text.trim()))
      throw new Conflict("Stop the response before running an MCP command.");
    if (
      extra?.prepared?.images.length &&
      active.session &&
      !active.session.model?.input.includes("image")
    )
      throw new Conflict(
        "This model does not accept images. Choose a vision model or remove the image.",
      );
    const input = this.sessions.accept(active.run.conversationId, text, id, {
      ...extra,
      queue: mode,
    });
    active.incoming.push(input);
    await active.ready;
    if (active.run.status === "running") {
      const content = this.sessions.content(input);
      await active.session?.[mode](content.text, content.images);
    }
    // A cancellation during startup leaves a durable pending receipt for the next run.
  }
  async clearQueue(id: string) {
    const active = this.active.get(id);
    if (!active) throw new Conflict("This response has already ended.");
    await active.ready;
    const queue = active.session?.clearQueue();
    if (!queue) return [];
    const pending = active.incoming.filter((item) => item.queue);
    // Pi stores expanded prompt/skill text in its queues. Queue lengths identify
    // the undelivered suffix without comparing that expansion to display text.
    const suffix = (mode: Message["queue"], count: number) =>
      count ? pending.filter((item) => item.queue === mode).slice(-count) : [];
    const removed = [
      ...suffix("steer", queue.steering.length),
      ...suffix("followUp", queue.followUp.length),
    ];
    const ids = new Set(removed.map((item) => item.id));
    active.incoming = active.incoming.filter((item) => !ids.has(item.id));
    this.sessions.discardPending(active.run.conversationId, [...ids]);
    return removed;
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
