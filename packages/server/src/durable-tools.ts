import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { stripFrontmatter, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
  type CodemodeTool,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  awaitWithContext,
} from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type Registry,
  type Harness,
  type Conversation,
  type ToolRegistration,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { AgentRun } from "@biologue/protocol";
import type { Permissions } from "./permissions.ts";
import type { ExtensionDialogs } from "./extension-ui.ts";
import { NativeMcp, type NativeTool } from "./native-mcp.ts";
import { expandPrompt } from "./prompt-expansion.ts";

const CodeStore = defineDoc({
  kind: "biologue.codemode-store",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ values: {} as Record<string, JsonValue> }),
});

/** Native tool registrations; standalone Pi clients provide protocol and sandbox services. */
export class DurableTools {
  readonly name: string;
  private active = new Set<string>();
  private mcp: NativeMcp;
  private detach: () => void;
  private approve: (
    name: string,
    args: unknown,
    callId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  private stopped = false;
  constructor(
    private input: {
      loader: DefaultResourceLoader;
      tools: ToolRegistration[];
      run: AgentRun;
      registry: Registry;
      harness: Harness;
      conversation: Conversation;
      permissions: Permissions;
      dialogs: ExtensionDialogs;
      signal: AbortSignal;
      mcp: NativeMcp;
    },
  ) {
    this.name = `biologue-tools:${input.run.conversationId}`;
    this.mcp = input.mcp;
    this.detach = this.mcp.subscribe({
      changed: async () => {
        this.publish();
        await this.configure();
      },
      notify: (text, level) => input.dialogs.notify(input.run, text, level),
    });
    this.approve = (name, args, callId, signal) =>
      input.permissions.request(
        {
          runId: input.run.id,
          conversationId: input.run.conversationId,
          tool: name,
          toolCallId: callId,
          description: `Call ${name}`,
          code: JSON.stringify(args, null, 2),
        },
        signal,
        input.run.settings?.mode,
      );
    this.publish();
  }
  private definitions(): NativeTool[] {
    return [
      ...this.input.tools,
      this.askTool(),
      this.codeTool(),
      this.searchTool(),
      ...this.mcp.tools(this.approve),
    ];
  }
  private publish() {
    if (this.stopped) return;
    const loader = this.input.loader;
    this.input.registry.install(
      defineExtension({
        name: this.name,
        tools: this.definitions().map((tool) => ({
          ...tool,
          replay: tool.replay ?? "unsafe",
          executionMode: "sequential",
        })),
        sections: [
          section(
            "project_instructions",
            () =>
              loader
                .getAgentsFiles()
                .agentsFiles.map((f) => `${f.path}\n${f.content}`)
                .join("\n\n") || undefined,
          ),
          section(
            "skills",
            () =>
              loader
                .getSkills()
                .skills.map((s) => `${s.name}: ${s.description}\nPath: ${s.filePath}`)
                .join("\n") || undefined,
          ),
          section("mcp_servers", () => this.mcp.instructions() || undefined),
        ],
      }),
    );
  }
  private async configure() {
    if (this.stopped) return;
    await this.input.conversation.configure(
      {
        tools: this.definitions().filter(
          (t) =>
            t.exposure !== "hidden" &&
            (!t.exposure || t.exposure === "direct" || this.active.has(t.name)),
        ),
      },
      BACKGROUND_CONTEXT,
    );
  }
  async start() {
    const saved = await this.input.harness.snapshot(
      AgentDoc,
      this.input.conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (Array.isArray(saved?.tools)) this.active = new Set(saved.tools);
    await awaitWithContext(
      this.mcp.start(this.active),
      withAbortSignal(this.input.signal, BACKGROUND_CONTEXT),
    );
    this.publish();
    await this.configure();
  }
  expand(text: string) {
    const expanded = expandPrompt(text, this.input.loader.getPrompts().prompts);
    if (expanded !== text) return expanded;
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const skill = match && this.input.loader.getSkills().skills.find((s) => s.name === match[1]);
    if (!skill) return text;
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim()}\n</skill>\n\n${match![2] ?? ""}`;
  }
  async command(text: string) {
    const match = /^\/mcp(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return false;
    await this.mcp.command(match[1] ?? "");
    return true;
  }
  private askTool() {
    return defineTool({
      name: "ask_user",
      description:
        "Ask the user a focused question when their answer is needed to continue. Provide suggested options or request free text.",
      replay: "safe",
      parameters: Type.Object({
        question: Type.String(),
        context: Type.Optional(Type.String()),
        options: Type.Optional(
          Type.Array(
            Type.Union([
              Type.String(),
              Type.Object({ title: Type.String(), description: Type.Optional(Type.String()) }),
            ]),
          ),
        ),
        allowFreeform: Type.Optional(Type.Boolean()),
        timeout: Type.Optional(Type.Number()),
      }),
      execute: async (args, api, context) => {
        const options = args.options?.map((o) => (typeof o === "string" ? o : o.title));
        const select = options?.length && args.allowFreeform === false;
        const answer = await this.input.dialogs.ask(
          this.input.run,
          api.callId,
          select ? "select" : "input",
          args.question +
            (args.context ? `\n${args.context}` : "") +
            (!select && options?.length ? `\nSuggestions: ${options.join("; ")}` : ""),
          select ? options : undefined,
          "Type your answer...",
          { signal: context.abortSignal, timeout: args.timeout ? args.timeout * 1000 : undefined },
        );
        return {
          content: [
            {
              type: "text",
              text:
                answer === undefined ? "User cancelled the question" : `User answered: ${answer}`,
            },
          ],
          details: {
            question: args.question,
            cancelled: answer === undefined,
            answer: answer ?? null,
          },
        };
      },
    });
  }
  private matches(query: string, tools = this.mcp.tools(this.approve), limit = 8) {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return tools
      .map((tool) => ({
        tool,
        score: words.reduce(
          (score, word) =>
            score +
            (JSON.stringify([tool.name, tool.description, tool.parameters])
              .toLowerCase()
              .includes(word)
              ? 1
              : 0),
          0,
        ),
      }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => m.tool);
  }
  private searchTool() {
    return defineTool({
      name: "tool_search",
      description:
        "Search connected MCP tools by name, description, or parameters and declare matches for the next model request.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execute: async ({ query, limit }, _api, context) => {
        await awaitWithContext(this.mcp.ready(), context);
        const matches = this.matches(query, undefined, limit);
        for (const tool of matches) this.active.add(tool.name);
        return {
          control: { addTools: matches.map((t) => t.name) },
          content: [
            {
              type: "text",
              text: JSON.stringify(
                matches.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              ),
            },
          ],
          details: { loaded: matches.map((t) => t.name) },
        };
      },
    });
  }
  private codeTool() {
    const tools = this.input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as CodemodeJsonSchema,
      execute: () => undefined,
    }));
    return defineTool({
      name: "codemode",
      description: `Run JavaScript that calls workspace or MCP tools, chains calls, or filters results. R/Python execution and inspection use workspace tools. Use text() or return for output; store()/load() retain JSON values. Discover MCP tools with tool_search before running scripts; searchTools(query, {limit, namespace}), describeTool(name), and describeNamespace(name) inspect already loaded tools. Scripts have no filesystem, network, or shell access.\n${renderDeclarations({ tools })}`,
      replay: "unsafe",
      parameters: Type.Object({ code: Type.String() }),
      execute: (args, api, context) => this.code(args.code, api, context),
    });
  }
  private async code(
    source: string,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> {
    const { code, options } = parseCodemodeSource(source);
    const definitions = this.definitions().filter(
      (t) => !["codemode", "tool_search"].includes(t.name) && t.exposure !== "hidden",
    );
    let number = 0;
    const tools: CodemodeTool[] = definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as CodemodeJsonSchema,
      execute: async (raw, { signal }) => {
        if (this.stopped || this.input.run.status !== "running")
          throw new Error("Agent run cancelled.");
        const call: ToolCall = {
          type: "toolCall",
          id: `${api.callId}/${++number}`,
          name: tool.name,
          arguments: raw as JsonObject,
        };
        const args = validateToolArguments(tool, call);
        const result = await tool.execute(
          args,
          { ...api, callId: call.id },
          withAbortSignal(
            AbortSignal.any([signal, ...(context.abortSignal ? [context.abortSignal] : [])]),
            context,
          ),
        );
        if (result?.isError)
          throw new Error(
            result.content
              ?.filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n") || "Tool failed.",
          );
        const details = result?.details as { structuredContent?: JsonValue } | undefined;
        return (
          details?.structuredContent ??
          (result?.content?.some((b) => b.type === "image")
            ? result.content
            : result?.content
                ?.filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n")) ??
          ""
        );
      },
    }));
    const describe = (name: string) => definitions.find((t) => t.name === name);
    const sandbox = new CodemodeSandbox({
      tools,
      globals: [
        {
          name: "searchTools",
          spread: true,
          execute: (raw) => {
            const [query, options] = raw as [string, { limit?: number; namespace?: string }?];
            return this.matches(
              query,
              definitions.filter(
                (t) => !options?.namespace || t.namespace?.includes(options.namespace),
              ),
              options?.limit,
            ).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
          },
        },
        {
          name: "describeTool",
          execute: (raw) => {
            const t = describe(String(raw));
            return t
              ? { name: t.name, description: t.description, parameters: t.parameters }
              : null;
          },
        },
        {
          name: "describeNamespace",
          execute: (raw) => ({
            instructions: this.mcp.instructions(),
            tools: definitions
              .filter((t) => t.namespace?.includes(String(raw)))
              .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
          }),
        },
      ],
      memoryLimitBytes: 128 * 1024 * 1024,
    });
    try {
      const state = await api.snapshot(CodeStore, api.conversationId, context);
      const result = await sandbox.execute(code, {
        signal: context.abortSignal,
        timeoutMs: options.timeoutMs ?? Infinity,
        store: state?.values,
      });
      if (result.ok)
        await api.commit(async (tx) => {
          const state = await tx.doc(CodeStore, api.conversationId);
          for (const key of result.storeWrites.delete) delete state.values[key];
          Object.assign(state.values, result.storeWrites.set);
        }, context);
      const content = [...result.output];
      if (result.ok && result.value !== undefined)
        content.push({ type: "text", text: JSON.stringify(result.value) });
      if (!result.ok)
        content.push({ type: "text", text: result.error.stack ?? result.error.message });
      const budget = Math.max(100, options.maxOutputTokens ?? 4000) * 4;
      let remaining = budget;
      return {
        content: content.map((item) => {
          if (item.type !== "text") return item;
          const text =
            item.text.length > remaining
              ? item.text.slice(0, remaining) +
                "\n[Output truncated; filter results or retrieve captured artifacts with workspace tools.]"
              : item.text;
          remaining = Math.max(0, remaining - text.length);
          return { ...item, text };
        }),
        isError: !result.ok,
        details: JSON.parse(JSON.stringify({ calls: result.calls })),
      };
    } finally {
      await sandbox.close();
    }
  }
  async stop() {
    this.stopped = true;
    this.detach();
    this.input.registry.uninstall(defineExtension({ name: this.name }));
  }
}
