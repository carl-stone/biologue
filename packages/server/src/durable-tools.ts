import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { stripFrontmatter, type PromptTemplate } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type { Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  section,
  AgentDoc,
  type Registry,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Conversation,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type {
  DefaultResourceLoader,
  ToolDefinition,
  ExtensionToolContext,
  ExtensionContext,
  LoadExtensionsResult,
  ModelRuntime,
  ExtensionUIContext,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "@biologue/protocol";
import type { Permissions } from "./permissions.ts";
import type { ConversationSessions } from "./conversation-sessions.ts";

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// The pinned Pi release does not re-export its pure template utility. Resolve it
// relative to Pi's entry point so quoted, positional and default arguments retain
// their native behavior without constructing an AgentSession.
const { expandPromptTemplate } = (await import(
  new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };
type Invocation = { writes: { kind: string; data: JsonValue }[] };

/** Adapts Pi's tool-only extensions to durable tasks. No Agent or AgentSession is constructed. */
export class DurableTools {
  readonly name: string;
  private active = new Set<string>();
  private runtime: LoadExtensionsResult;
  private workspace: ToolDefinition[];
  private invocation = new AsyncLocalStorage<Invocation>();
  private controller = new AbortController();
  private cancel = () => this.controller.abort();
  private sections: Record<string, string> = {};
  private dirty = true;
  private stopped = false;
  constructor(
    private input: {
      project: string;
      loader: DefaultResourceLoader;
      tools: ToolDefinition[];
      run: AgentRun;
      models: ModelRuntime;
      registry: Registry;
      harness: Harness;
      conversation: Conversation;
      sessions: ConversationSessions;
      permissions: Permissions;
      ui: ExtensionUIContext;
      uiForCall: (callId: string) => ExtensionUIContext;
      signal: AbortSignal;
      onError: (error: Error) => void;
    },
  ) {
    input.signal.addEventListener("abort", this.cancel, { once: true });
    if (input.signal.aborted) this.cancel();
    this.name = `biologue-tools:${input.run.conversationId}`;
    this.workspace = input.tools;
    this.runtime = input.loader.getExtensions();
    if (this.runtime.errors.length)
      throw new Error(
        `Pi tools failed to load: ${this.runtime.errors.map((e) => e.error).join("; ")}`,
      );
    this.active = new Set([
      ...input.tools.map((t) => t.name),
      "ask_user",
      "codemode",
      "tool_search",
    ]);
    // These are tool discovery and bookkeeping callbacks, not agent-loop actions.
    Object.assign(this.runtime.runtime, {
      getAllTools: () =>
        this.definitions().map((t) => ({ ...t, exposure: t.exposure ?? "direct" })),
      getActiveTools: () => [...this.active],
      setActiveTools: (names: string[]) => {
        this.active = new Set(names);
        this.dirty = true;
      },
      refreshTools: () => {
        this.dirty = true;
      },
      getSettings: () => ({ codemode: { mode: "on" } }),
      appendEntry: (kind: string, data: JsonValue) => {
        const invocation = this.invocation.getStore();
        if (!invocation) throw new Error("Tool bookkeeping requires an active durable invocation.");
        invocation.writes.push({ kind, data: json(data) });
      },
    });
    this.publish();
  }
  private definitions() {
    return [
      ...this.workspace,
      ...this.runtime.extensions.flatMap((e) => [...e.tools.values()].map((t) => t.definition)),
    ];
  }
  private definition(name: string) {
    return this.definitions()
      .slice()
      .reverse()
      .find((t) => t.name === name);
  }
  private declared(definitions: ToolDefinition[]) {
    return definitions.filter(
      (t) =>
        t.exposure !== "hidden" &&
        (this.active.has(t.name) ||
          t.exposure === "direct" ||
          (!t.exposure && t.defaultActive !== false)),
    );
  }
  private baseContext(
    signal: AbortSignal,
    branch: unknown[] = [],
    ui = this.input.ui,
  ): ExtensionContext {
    return {
      cwd: this.input.project,
      hasUI: true,
      mode: "rpc",
      ui,
      signal,
      model: this.input.models.getModel(
        this.input.run.settings!.provider,
        this.input.run.settings!.model,
      ),
      modelRegistry: this.input.models,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => branch },
      isIdle: () => false,
      abort: () => this.controller.abort(),
    } as unknown as ExtensionContext;
  }
  async emit(name: string, event: unknown, signal = this.controller.signal) {
    const ctx = this.baseContext(signal);
    for (const extension of this.runtime.extensions)
      for (const handler of extension.handlers.get(name) ?? []) await handler(event as never, ctx);
  }
  async start() {
    const saved = await this.input.harness.snapshot(
      AgentDoc,
      this.input.conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (Array.isArray(saved?.tools))
      this.active = new Set([...saved.tools, ...this.workspace.map((t) => t.name)]);
    await this.emit("session_start", { type: "session_start" });
    await this.prepare();
  }
  async prepare() {
    const event = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
    await this.emit("before_agent_start", event);
    this.sections = event.systemPromptOptions.sections;
    this.publish();
    await this.flush();
  }
  private publish() {
    const definitions = this.definitions();
    const loadout = {
      declared: this.declared(definitions),
      callable: definitions.filter(
        (t) => t.name !== "codemode" && !["hidden", "model-only"].includes(t.exposure ?? "direct"),
      ),
      registered: definitions,
      getExposure: (name: string) => this.definition(name)?.exposure ?? "direct",
      getNamespace: (name: string) => this.definition(name)?.namespace,
    } as unknown as ToolLoadout;
    const descriptions: Record<string, string> = {};
    for (const definition of definitions)
      Object.assign(descriptions, definition.prepareLoadout?.(loadout)?.descriptions);
    const tools = definitions
      .filter((t) => t.exposure !== "hidden")
      .map((definition) =>
        defineTool({
          ...definition,
          description: descriptions[definition.name] ?? definition.description,
          replay: definition.name === "ask_user" ? ("safe" as const) : ("unsafe" as const),
          executionMode: "sequential" as const,
          execute: (args, api, context) =>
            this.invoke(definition.name, args as JsonObject, api, context),
        }),
      );
    const skills = this.input.loader.getSkills().skills;
    const instructions = this.input.loader.getAgentsFiles().agentsFiles;
    this.input.registry.install(
      defineExtension({
        name: this.name,
        tools,
        sections: [
          section(
            "project_instructions",
            () => instructions.map((f) => `${f.path}\n${f.content}`).join("\n\n") || undefined,
          ),
          section(
            "skills",
            () =>
              skills.map((s) => `${s.name}: ${s.description}\nPath: ${s.filePath}`).join("\n") ||
              undefined,
          ),
          ...Object.keys(this.sections).map((key) => section(key, () => this.sections[key])),
        ],
      }),
    );
    this.dirty = true;
  }
  async flush() {
    if (this.stopped || !this.dirty) return;
    this.dirty = false;
    const definitions = this.definitions();
    await this.input.conversation.configure(
      {
        tools: this.declared(definitions).map((t) => ({ name: t.name }) as never),
      },
      BACKGROUND_CONTEXT,
    );
  }
  expand(text: string) {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return text;
    const expanded = expandPromptTemplate(text, this.input.loader.getPrompts().prompts);
    if (expanded !== text) return expanded;
    const skill = this.input.loader.getSkills().skills.find((s) => `skill:${s.name}` === match[1]);
    if (!skill) return text;
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>\n\n${match[2] ?? ""}`;
  }
  async command(text: string) {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return false;
    const command = this.runtime.extensions
      .flatMap((e) => [...e.commands.values()])
      .find((c) => c.name === match[1]);
    if (!command) return false;
    await command.handler(match[2] ?? "", this.baseContext(this.controller.signal) as never);
    return true;
  }
  private async invoke(
    name: string,
    args: JsonObject,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> {
    const signal = AbortSignal.any([
      context.abortSignal ?? this.controller.signal,
      this.controller.signal,
    ]);
    if (this.stopped || this.controller.signal.aborted || this.input.run.status !== "running")
      throw new Error("Agent run cancelled.");
    const definition = this.definition(name);
    if (!definition || definition.exposure === "hidden")
      throw new Error(`Tool ${name} is unavailable.`);
    let params: unknown;
    try {
      params = args; // Native ToolTask already validated the top-level call.
      await this.emit(
        "tool_call",
        { type: "tool_call", toolName: name, toolCallId: api.callId, input: params },
        signal,
      );
      // Connections can register tools while the native tool_call hooks wait.
      this.publish();
      await this.flush();
      if (
        name.startsWith("mcp__") ||
        ["read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"].includes(name)
      )
        if (!definition.annotations?.readOnlyHint)
          await this.input.permissions.request(
            {
              runId: this.input.run.id,
              conversationId: this.input.run.conversationId,
              tool: name,
              toolCallId: api.callId,
              description: `Call ${name}`,
              code: JSON.stringify(params, null, 2),
            },
            signal,
          );
      signal.throwIfAborted();
      const branch =
        name === "codemode"
          ? (await this.input.sessions.history(this.input.run.conversationId))
              .filter((e) => e.kind.startsWith("biologue.custom."))
              .map((e) => ({
                type: "custom",
                customType: e.kind.slice("biologue.custom.".length),
                data: e.data,
              }))
          : [];
      let nestedNumber = 0;
      const nestedTools = this.definitions().filter(
        (t) =>
          t.name !== "codemode" &&
          t.exposure !== "hidden" &&
          t.exposure !== "model-only" &&
          (this.active.has(t.name) ||
            ["direct", "codemode", "deferred"].includes(t.exposure ?? "direct")),
      );
      const toolContext = {
        ...this.baseContext(signal, branch, this.input.uiForCall(api.callId)),
        tools: nestedTools,
        executeTool: async (toolName: string, raw: unknown, opts?: { signal?: AbortSignal }) => {
          const callId = `${api.callId}/${++nestedNumber}`;
          const definition = this.definition(toolName);
          if (!definition || !nestedTools.some((t) => t.name === toolName))
            throw new Error(`Tool ${toolName} is unavailable.`);
          const call: ToolCall = {
            type: "toolCall",
            id: callId,
            name: toolName,
            arguments: json(raw) as JsonObject,
          };
          // Pi's unsafe code-mode ToolTask owns the whole plan. It will never
          // replay this JavaScript or any of its nested scientific effects.
          const args = validateToolArguments(definition, call);
          const result = await this.invoke(
            toolName,
            args as JsonObject,
            { ...api, callId },
            withAbortSignal(
              opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal,
              context,
            ),
          );
          return { toolCall: call, result, isError: result.isError ?? false };
        },
      } as unknown as ExtensionToolContext;
      const invocation: Invocation = { writes: [] };
      const result = await this.invocation.run(invocation, () =>
        definition.execute(
          api.callId,
          params as never,
          signal,
          (update) => {
            if (update.details !== undefined)
              void api.details(json(update.details) as JsonValue, context).catch(() => {});
          },
          toolContext,
        ),
      );
      if (invocation.writes.length)
        await api.commit(async (tx) => {
          for (const write of invocation.writes)
            await tx.appendEntry(api.conversationId, {
              kind: `biologue.custom.${write.kind}`,
              data: write.data,
            });
        }, context);
      // tool_search activation becomes durable before its result is committed.
      await this.flush();
      return json(result) as ToolExecutionResult;
    } catch (cause) {
      if (signal.aborted) throw cause;
      return {
        isError: true,
        content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
      };
    }
  }
  async stop() {
    this.input.signal.removeEventListener("abort", this.cancel);
    this.controller.abort();
    this.stopped = true;
    await this.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
}
