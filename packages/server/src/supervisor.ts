import { randomUUID } from "node:crypto";
import {
  calculateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  watchEvents,
  section,
  defineExtension,
  UsageDoc,
  CompactionTask,
  GenerationTask,
  hook,
  LiveDoc,
  type TaskId,
  type CompactionResult,
  type Harness,
  type Registry,
  type Conversation as DurableConversation,
  type AgentEventStream,
  type AgentEvent,
  type EntryId,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, ImageContent, Message as PiMessage } from "@earendil-works/pi-ai";
import type { AgentRun, Conversation, Attachment } from "@biologue/protocol";
import { ExtensionDialogs } from "./extension-ui.ts";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import type { Documents } from "./documents.ts";
import { Conflict } from "./documents.ts";
import type { ContextService } from "./context.ts";
import type { ExecutionService } from "./execution.ts";
import type { Permissions } from "./permissions.ts";
import type { PiAdapter } from "./pi.ts";
import type { DurableTools } from "./durable-tools.ts";
import { ConversationSessions } from "./conversation-sessions.ts";
import { RunsDoc, type StoredRun } from "./durable-state.ts";
import { workspaceTools } from "./workspace-tools.ts";

function contextUsage(messages: readonly PiMessage[], contextWindow: number) {
  let index = messages.length - 1;
  for (; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && calculateContextTokens(message.usage) > 0) break;
  }
  const measured = messages[index];
  const tokens =
    (measured?.role === "assistant" ? calculateContextTokens(measured.usage) : 0) +
    messages.slice(index + 1).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return {
    tokens,
    contextWindow,
    percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
  };
}
type ActiveRun = {
  run: AgentRun;
  session?: DurableTools;
  conversation?: DurableConversation;
  integrationError?: Error;
  ready: Promise<void>;
  markReady: () => void;
  admitted: Promise<void>;
  markAdmitted: () => void;
  submissions: Promise<void>;
  completion: Promise<void>;
  streamedText?: number;
  controller: AbortController;
  stopping?: Promise<void>;
};

/** Workbench integration; Pi Durable owns scheduling, admission, compaction and recovery. */
export class Supervisor {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  private starting = new Map<string, Promise<void>>();
  private recoveryReady: Promise<void> = Promise.resolve();
  harness!: Harness;
  registry!: Registry;
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
  }
  async initialize(opened?: Awaited<ReturnType<PiAdapter["openHarness"]>>) {
    opened ??= await this.pi.openHarness();
    this.harness = opened.harness;
    this.registry = opened.registry;
    this.sessions.bind(this.harness);
    const recovering: StoredRun[] = [];
    this.store.db.prepare("DELETE FROM records WHERE kind='run'").run();
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    do {
      const page = await this.harness.commit((tx) => tx.scanConversations({}, 100, cursor), ctx);
      for (const conversation of page.items) {
        const state = await this.harness.snapshot(RunsDoc, conversation.id, ctx);
        for (const saved of state?.current ? [state.current] : []) {
          try {
            this.store.put("run", saved.run.id, saved.run);
          } catch (error) {
            console.error("Recovered run display failed", error);
          }
          if (!saved.run.finishedAt) {
            recovering.push(JSON.parse(JSON.stringify(saved)));
          }
        }
      }
      cursor = page.next;
    } while (cursor);
    for (const saved of recovering) {
      this.launch(saved.run, saved, true);
      if (saved.run.status !== "running") void this.stop(this.active.get(saved.run.id)!);
    }
    this.recoveryReady = Promise.all([...this.active.values()].map((a) => a.ready)).then(
      () => undefined,
    );
    await this.recoveryReady;
  }
  async start(
    conversationId: string,
    text: string,
    options?: {
      kind?: "compaction";
      prepared?: { text: string; images: ImageContent[] };
      attachments?: Attachment[];
    },
  ): Promise<AgentRun> {
    if (this.closing) throw new Conflict("The application is shutting down.");
    if (!this.context.hasConversation(conversationId))
      throw new Error("Conversation does not exist.");
    if (this.isActive(conversationId))
      throw new Conflict("A collaborator run is already active in this conversation.");
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
      throw new Error("Configure BIOLOGUE_PROVIDER and BIOLOGUE_MODEL to enable the collaborator.");
    const research = this.context.get();
    const run: AgentRun = {
      id: randomUUID(),
      conversationId,
      status: "running",
      startedAt: new Date().toISOString(),
      contextVersion: research.version,
      settings,
      kind: options?.kind ?? "response",
      phase: "working",
    };
    let admitted!: () => void;
    this.starting.set(
      conversationId,
      new Promise<void>((resolve) => {
        admitted = resolve;
      }),
    );
    try {
      const saved: StoredRun = { run };
      if (run.kind !== "compaction") {
        const accepted = await this.sessions.accept(conversationId, text, run.id, options, saved);
        saved.inputId = accepted.id;
        try {
          this.context.firstTitle(conversationId, text);
        } catch (error) {
          console.error("Initial conversation title failed", error);
        }
      } else {
        const conversation = await this.sessions.get(conversationId);
        await conversation.commit(async (tx) => {
          (await tx.doc(RunsDoc, conversation.id)).current = JSON.parse(JSON.stringify(saved));
        }, ctx);
      }
      this.launch(run, saved, false);
      this.publish(this.active.get(run.id)!);
      return run;
    } finally {
      this.starting.delete(conversationId);
      admitted();
    }
  }
  private launch(run: AgentRun, input: StoredRun, recovery: boolean) {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    const active: ActiveRun = {
      run,
      ready,
      markReady,
      admitted,
      markAdmitted,
      submissions: Promise.resolve(),
      completion: Promise.resolve(),
      controller: new AbortController(),
    };
    this.active.set(run.id, active);
    active.completion = Promise.resolve().then(() => this.perform(active, input, recovery));
  }
  private async perform(active: ActiveRun, input: StoredRun, recovery: boolean) {
    const { run } = active;
    const cancelled = () => run.status === "cancelled";
    let stream: AgentEventStream | undefined;
    let handled = false;
    try {
      const conversation = await this.sessions.get(run.conversationId);
      active.conversation = conversation;
      this.execution.context.begin(run.conversationId);
      run.piSessionId = String(conversation.id);
      const runtime = await this.pi.modelRuntime();
      const model = runtime.getModel(run.settings!.provider, run.settings!.model);
      if (!model)
        throw new Error(`Model ${run.settings!.provider}/${run.settings!.model} is not available.`);
      const tools = await this.pi.create({
        harness: this.harness,
        registry: this.registry,
        conversation,
        run,
        permissions: this.permissions,
        dialogs: this.dialogs,
        signal: active.controller.signal,
        tools: (skills) =>
          workspaceTools(
            run,
            this.documents,
            this.execution,
            this.permissions,
            skills,
            model.input.includes("image"),
          ),
      });
      active.session = tools;
      const agentName = `biologue-agent:${run.conversationId}`;
      this.registry.install(
        defineExtension({
          name: agentName,
          sections: [
            section("preamble", () => this.prompt, { tag: false }),
            section("project_notes", () => this.context.get().text || undefined),
            section("permission_mode", () =>
              run.settings?.mode === "plan"
                ? "Plan mode: read and inspect; do not edit files or execute code."
                : `Permission mode: ${run.settings?.mode ?? "ask"}. Use workspace tools for edits and execution.`,
            ),
          ],
          hooks: [
            hook(GenerationTask, {
              beforeRequest: ({ messages }) => {
                // A recovered generation has a pinned request. Apply the user's
                // current notes without modifying its recorded history.
                const notes = this.context.get().text;
                const shown = messages
                  .filter((m) => m.role === "system")
                  .map((m) => m.sections?.project_notes)
                  .filter((s) => s !== undefined)
                  .at(-1);
                const current = notes ? `<project_notes>\n${notes}\n</project_notes>` : undefined;
                const request =
                  shown === current
                    ? messages
                    : [
                        ...messages,
                        {
                          role: "system" as const,
                          content: "",
                          sections: { project_notes: current ?? "" },
                          timestamp: Date.now(),
                        },
                      ];
                this.execution.context.observeContext(run.conversationId, request);
                return { messages: request };
              },
            }),
          ],
        }),
      );
      await conversation.configure(
        {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: run.settings!.thinking as never,
          extensions: [{ name: agentName }, { name: tools.name }],
          cwd: this.documents.root,
        },
        ctx,
      );
      await tools.start();
      active.markReady();
      await this.recoveryReady;
      if (cancelled()) return;
      if (active.integrationError) throw active.integrationError;
      stream = await watchEvents(this.harness, conversation.id, ctx);
      this.consume(active, [stream.snapshot]);
      stream.start(async (events) => {
        try {
          this.consume(active, events);
          if (
            events.some((event) => event.type === "message_end" || event.type === "compaction_end")
          ) {
            await this.updateUsage(active);
            this.publish(active);
          }
        } catch (error) {
          this.failure(active, "Conversation update", error);
          void this.stop(active);
        }
      });
      if (run.kind === "compaction") {
        // Bind the app run and native task in the same durable transaction.
        const id = await conversation.commit(async (tx) => {
          const saved = (await tx.doc(RunsDoc, conversation.id)).current!;
          const existing = saved.compactionId;
          if (existing !== undefined) return existing as TaskId<CompactionResult>;
          const taskId = await tx.createTask(
            CompactionTask,
            { reason: "manual" },
            {
              ownership: { kind: "conversation" },
              conversationId: conversation.id,
              background: false,
            },
          );
          const live = await tx.doc(LiveDoc, conversation.id);
          (live.compactions ??= []).push({ taskId, reason: "manual", blocking: false, attempt: 1 });
          saved.compactionId = taskId;
          return taskId;
        }, ctx);
        active.markAdmitted();
        await this.submitQueued(active);
        const task = await this.harness.waitForTask(id, ctx);
        if (task.state.outcome.status !== "completed")
          throw new Error(`Compaction ${task.state.outcome.status}.`);
        if (task.state.outcome.result.submissionId) {
          const submission = await this.harness.submission(
            task.state.outcome.result.submissionId,
            ctx,
          );
          const settled = await submission!.wait(ctx);
          if (settled.status !== "done") throw new Error(`Compaction ${settled.reason}.`);
        }
        await conversation.waitForIdle(ctx);
      } else {
        const accepted = this.sessions.receipt(input.inputId!);
        if (!accepted) throw new Error("The saved agent input is missing.");
        if (this.sessions.content(accepted).images.length && !model.input.includes("image"))
          throw new Error(
            "This model does not accept images. Choose a vision model or remove the image.",
          );
        // Authenticate before durable admission. A stop here retains the unsent receipt.
        if (!recovery) {
          await runtime.checkAuth(model.provider, { signal: active.controller.signal });
          if (cancelled()) return;
        }
        handled = await tools.command(accepted.text);
        if (handled) {
          await this.sessions.discardPending(run.conversationId, [accepted.id]);
        } else {
          await this.sessions.publishMessages(run.conversationId);
          // Old receipts that were withdrawn on cancellation remain available as context.
          for (const pending of await this.sessions.pending(run.conversationId)) {
            if (pending.id === accepted.id || pending.runId === run.id) continue;
            const record = await this.harness.commit(
              (tx) => tx.submissionByRequest(conversation.id, pending.id),
              ctx,
            );
            if (record?.status === "queued" || record?.status === "placed") continue;
            if (this.sessions.content(pending).images.length && !model.input.includes("image"))
              throw new Error(
                "An unsent attachment requires a vision model. Choose a vision model before continuing this conversation.",
              );
            await this.sessions.restore(pending);
          }
          const existing = await this.harness.commit(
            (tx) => tx.submissionByRequest(conversation.id, accepted.id),
            ctx,
          );
          const submission = existing
            ? await this.harness.submission(existing.id, ctx)
            : await this.sessions.submit(accepted, (text) => tools.expand(text));
          active.markAdmitted();
          await this.submitQueued(active);
          const settled = await submission!.wait(ctx);
          await conversation.waitForIdle(ctx);
          const terminal = await conversation.entries({}, 1, undefined, ctx);
          const lastRaw = terminal.items[0]?.model?.find((m) => m.role === "assistant");
          if (
            settled.status === "done" &&
            lastRaw?.role === "assistant" &&
            lastRaw.stopReason === "length"
          ) {
            run.endReason = "truncated";
            throw new Error("The model response was truncated. Send a follow-up to continue.");
          }
          if (settled.status !== "done" && !cancelled()) {
            const last = (await this.sessions.history(run.conversationId))
              .flatMap((e) => e.model ?? [])
              .filter((m): m is AssistantMessage => m.role === "assistant")
              .at(-1);
            run.endReason =
              settled.reason.includes("length") || last?.stopReason === "length"
                ? "truncated"
                : last?.stopReason === "aborted"
                  ? "interrupted"
                  : "provider_error";
            throw new Error(
              typeof settled.detail === "string"
                ? settled.detail
                : `The agent input was unanswered (${settled.reason}).`,
            );
          }
        }
      }
      if (active.integrationError) throw active.integrationError;
      if (!cancelled()) {
        run.status = "completed";
        run.endReason = "response";
      }
    } catch (error) {
      if (!this.closing && !cancelled()) {
        run.status = "failed";
        run.endReason = active.integrationError
          ? "integration_error"
          : (run.endReason ?? "provider_error");
        run.error =
          active.integrationError?.message ??
          (error instanceof Error ? error.message : String(error));
        // A failed host setup must not leave old durable work waiting to resume
        // under the next run's model or permissions.
        if (active.conversation) {
          const name = `biologue-failed:${run.conversationId}`;
          this.registry.install(
            defineExtension({
              name,
              sections: [
                section("failed_setup", () => {
                  throw new Error(run.error);
                }),
              ],
            }),
          );
          try {
            await active.conversation.configure({ extensions: [{ name }] }, ctx);
          } catch (cleanupError) {
            this.failure(active, "Block failed conversation", cleanupError);
          }
        }
        void this.stop(active);
      }
    } finally {
      active.markReady();
      active.markAdmitted();
      if (active.stopping) await active.stopping;
      try {
        await stream?.stop();
      } catch (error) {
        if (!this.closing) this.failure(active, "Close conversation watch", error);
      }
      try {
        if (active.session) await this.pi.dispose(active.session);
      } catch (error) {
        this.failure(active, "Dispose Pi tools", error);
      }
      this.registry.uninstall(defineExtension({ name: `biologue-agent:${run.conversationId}` }));
      this.registry.uninstall(defineExtension({ name: `biologue-failed:${run.conversationId}` }));
      this.attempt(active, "Cancel questions", () => this.dialogs.cancelRun(run.id));
      this.attempt(active, "Cancel permissions", () => this.permissions.cancelRun(run.id));
      try {
        if (!this.closing) {
          await this.sessions.publishMessages(run.conversationId);
          await this.updateUsage(active);
        }
      } catch (error) {
        this.failure(active, "Conversation update", error);
      }
      if (!this.closing) {
        run.finishedAt = new Date().toISOString();
        this.publish(active, false);
        try {
          await this.record(active);
        } catch (error) {
          this.failure(active, "Record durable run", error);
          this.publish(active, false);
        }
        this.active.delete(run.id);
        this.events.emit({ type: "agent-run", run: { ...run } });
        if (run.status === "completed" && run.kind !== "compaction" && !handled)
          try {
            this.context.refreshTitle(
              run.conversationId,
              (await this.sessions.page(run.conversationId, 12)).items,
              (messages) => this.pi.conversationTitle(messages),
              await this.sessions.inputCount(run.conversationId),
            );
          } catch {
            /* Display titles do not affect execution. */
          }
      } else this.active.delete(run.id);
    }
  }
  private consume(active: ActiveRun, events: readonly AgentEvent[]) {
    const run = active.run;
    for (const event of events) {
      if (event.type === "message_start" && event.message.role === "assistant")
        active.streamedText = 0;
      if (event.type === "message_update")
        for (const change of event.changes)
          if (change.type === "text_delta") {
            active.streamedText = (active.streamedText ?? 0) + change.delta.length;
            this.events.emit({ type: "agent-delta", runId: run.id, delta: change.delta });
          }
      if (event.type === "message_end") {
        const m = event.entry.model?.find((m) => m.role === "assistant");
        if (m?.role === "assistant") {
          const text = m.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          const delta = text.slice(active.streamedText ?? 0);
          if (delta) this.events.emit({ type: "agent-delta", runId: run.id, delta });
          active.streamedText = 0;
        }
      }
      if (event.type === "snapshot") {
        const message = event.generation?.message;
        const text = message?.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          const offset = (active.streamedText ?? 0) <= text.length ? (active.streamedText ?? 0) : 0;
          const delta = text.slice(offset);
          if (delta) this.events.emit({ type: "agent-delta", runId: run.id, delta });
          active.streamedText = text.length;
        }
        run.activity = event.tools.map((tool) => ({
          id: tool.callId,
          tool: tool.name,
          label: tool.name.replace(/_/g, " "),
          status: "running",
        }));
      }
      if (event.type === "tool_execution_start")
        run.activity = [
          ...(run.activity ?? []),
          {
            id: event.toolCallId,
            tool: event.toolName,
            label: event.toolName.replace(/_/g, " "),
            status: "running",
          },
        ].slice(-40) as AgentRun["activity"];
      if (event.type === "tool_execution_end")
        run.activity = run.activity?.map((item) =>
          item.id === event.toolCallId
            ? {
                ...item,
                status: event.entry?.model?.some((m) => m.role === "toolResult" && m.isError)
                  ? "failed"
                  : "completed",
              }
            : item,
        );
      if (event.type === "compaction_start") run.phase = "compacting";
      if (event.type === "compaction_end" || event.type === "auto_retry_end") {
        run.phase = "working";
        delete run.phaseDetail;
      }
      if (event.type === "auto_retry_start") {
        run.phase = "retrying";
        run.phaseDetail = `Retry ${event.attempt} in ${Math.max(0, Math.ceil((event.at - Date.now()) / 1000))}s`;
      }
      if (event.type === "task_failed")
        this.failure(active, "Durable task", new Error(event.message));
    }
    this.publish(active);
  }
  private async updateUsage(active: ActiveRun) {
    if (!active.conversation) return;
    const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    const usage = await this.harness.snapshot(UsageDoc, active.conversation.id, ctx);
    if (usage)
      for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
        sums.input += bucket.input;
        sums.output += bucket.output;
        sums.cacheRead += bucket.cacheRead;
        sums.cacheWrite += bucket.cacheWrite;
        sums.total += bucket.totalTokens;
        cost += bucket.cost.total;
      }
    const runtime = await this.pi.modelRuntime();
    const settings = active.run.settings!;
    const model = runtime.getModel(settings.provider, settings.model);
    const view = await active.conversation.context(ctx);
    active.run.usage = {
      tokens: sums,
      cost,
      subscription: runtime.isUsingSubscription(settings.provider),
      ...(model ? { context: contextUsage(view.messages, model.contextWindow) } : {}),
    };
  }
  isActive(conversationId?: string) {
    return (
      (conversationId ? this.starting.has(conversationId) : this.starting.size > 0) ||
      [...this.active.values()].some(
        (item) => !conversationId || item.run.conversationId === conversationId,
      )
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
  private async record(active: ActiveRun) {
    const conversation =
      active.conversation ?? (await this.sessions.get(active.run.conversationId));
    await conversation.commit(async (tx) => {
      const saved = (await tx.doc(RunsDoc, conversation.id)).current;
      if (saved?.run.id === active.run.id) saved.run = JSON.parse(JSON.stringify(active.run));
    }, ctx);
  }
  private publish(active: ActiveRun, emit = true) {
    try {
      this.store.put("run", active.run.id, active.run);
    } catch (error) {
      console.error("Agent run display failed", error);
      try {
        this.store.put("run", active.run.id, active.run);
      } catch {
        console.error(`Agent run ${active.run.id}: ${active.run.error}`);
      }
    }
    if (emit) this.events.emit({ type: "agent-run", run: { ...active.run } });
  }
  private stop(active: ActiveRun) {
    return (active.stopping ??= (async () => {
      // Settle permission writes explicitly before abort listeners remove their
      // waiters, so persistence failures remain visible in the run's outcome.
      this.attempt(active, "Cancel permissions", () => this.permissions.cancelRun(active.run.id));
      this.attempt(active, "Cancel questions", () => this.dialogs.cancelRun(active.run.id));
      active.controller.abort();
      await active.ready;
      await this.recoveryReady;
      const results = await Promise.allSettled([
        active.conversation?.abort(ctx, { background: true }),
        this.execution.cancelRun(active.run.id),
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
    await this.record(active);
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
    if (extra?.prepared?.images.length) {
      const runtime = await this.pi.modelRuntime();
      const settings = active.run.settings!;
      if (!runtime.getModel(settings.provider, settings.model)?.input.includes("image"))
        throw new Conflict(
          "This model does not accept images. Choose a vision model or remove the image.",
        );
    }
    const accepted = active.submissions.then(() =>
      this.sessions.accept(active.run.conversationId, text, id, {
        ...extra,
        queue: mode,
      }),
    );
    active.submissions = accepted.then(
      () => {},
      () => {},
    );
    await accepted;
    await active.admitted;
    if (active.run.status === "running" && !this.closing) await this.submitQueued(active);
  }
  private submitQueued(active: ActiveRun) {
    const submit = active.submissions.then(async () => {
      for (const input of await this.sessions.pending(active.run.conversationId)) {
        if (active.run.status !== "running" || this.closing) return;
        if (input.runId !== active.run.id || !input.queue) continue;
        const existing = await this.harness.commit(
          (tx) => tx.submissionByRequest(active.conversation!.id, input.id),
          ctx,
        );
        if (existing) continue;
        await this.sessions.submit(input, (text) => active.session!.expand(text));
      }
    });
    active.submissions = submit.catch(() => {});
    return submit;
  }
  async clearQueue(id: string) {
    const active = this.active.get(id);
    if (!active) throw new Conflict("This response has already ended.");
    await active.ready;
    await this.recoveryReady;
    const clear = active.submissions.then(async () => {
      const pending = (await this.sessions.pending(active.run.conversationId)).filter(
        (m) => m.queue,
      );
      await this.sessions.discardPending(
        active.run.conversationId,
        pending.map((m) => m.id),
      );
      return pending;
    });
    active.submissions = clear.then(
      () => {},
      () => {},
    );
    return clear;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    // HTTP acceptance is now a native commit; let in-flight commits settle before closing storage.
    await Promise.all(this.starting.values());
    for (const active of this.active.values()) active.controller.abort();
    // Close suspends durable work. Explicit Stop aborts it. Kernel requests must drain independently.
    const results = await Promise.allSettled([
      this.harness.close(ctx),
      ...[...this.active.values()].map((a) => this.execution.cancelRun(a.run.id)),
    ]);
    await Promise.allSettled([...this.active.values()].map((a) => a.completion));
    this.sessions.unbind();
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Could not close the durable harness.",
      );
    this.pi.releaseHarness();
  }
}
