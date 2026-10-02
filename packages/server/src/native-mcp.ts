import { awaitWithContext } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import {
  McpClient,
  McpError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
  parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import type { McpServerEntry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Diagnostics } from "./diagnostics.ts";

export type NativeTool = ToolRegistration & {
  exposure?: "direct" | "codemode" | "deferred" | "hidden";
  namespace?: string;
  requiresApproval?: boolean;
};
type Server = {
  entry: McpServerEntry;
  client?: McpClient;
  opening?: Promise<void>;
  callback?: OAuthCallbackServer;
  callbackClosing?: Promise<void>;
  error?: string;
  tools: NativeTool[];
  login?: Promise<void>;
};
const namespace = (name: string) => `mcp__${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
export function validateMcpServerNames(names: string[]) {
  const owners = new Map<string, string>();
  for (const name of names) {
    const key = namespace(name);
    const other = owners.get(key);
    if (other !== undefined && other !== name)
      throw Object.assign(new Error(`MCP server "${name}" conflicts with "${other}".`), {
        statusCode: 400,
      });
    owners.set(key, name);
  }
}
function toolName(server: string, tool: string, taken: (name: string) => boolean) {
  const plain = `${namespace(server)}__${tool.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  if (plain.length <= 64 && !taken(plain)) return plain;
  for (let attempt = 0; ; attempt++) {
    const hash = createHash("sha256")
      .update(JSON.stringify([server, tool, attempt]))
      .digest("hex")
      .slice(0, 8);
    const name = `${plain.slice(0, 55)}_${hash}`;
    if (!taken(name)) return name;
  }
}
const expandHome = (value: string) =>
  value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
function value(input: string) {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    if (process.env[name] === undefined) throw new Error(`Missing environment variable ${name}.`);
    return process.env[name]!;
  });
}
function exposure(entry: McpServerEntry, name: string): NativeTool["exposure"] {
  const overrides = entry.config.toolExposure ?? {};
  if (overrides[name]) return overrides[name];
  for (const [pattern, setting] of Object.entries(overrides))
    if (
      new RegExp(
        `^${pattern
          .split("*")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(name)
    )
      return setting;
  return entry.config.exposure ?? "codemode";
}

/** Protocol clients only. Calls execute as Pi Durable ToolTasks. */
export class NativeMcp {
  private servers: Server[];
  private toolOwners = new Map<string, string>();
  private closed = false;
  private authController = new AbortController();
  private closing?: Promise<void>;
  private listeners = new Set<{
    changed: () => void | Promise<void>;
    notify: (text: string, level?: "info" | "warning" | "error") => void;
  }>();
  private changed = async () => {
    await Promise.all([...this.listeners].map((listener) => listener.changed()));
  };
  private notify = (text: string, level?: "info" | "warning" | "error") => {
    for (const listener of this.listeners) listener.notify(text, level);
  };
  subscribe(listener: {
    changed: () => void | Promise<void>;
    notify: (text: string, level?: "info" | "warning" | "error") => void;
  }) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  constructor(
    private input: {
      entries: McpServerEntry[];
      project: string;
      stateDir: string;
      models: ModelRuntime;
      diagnostics?: Diagnostics;
    },
  ) {
    validateMcpServerNames(input.entries.map((entry) => entry.name));
    this.servers = input.entries
      .filter((e) => e.config.enabled !== false)
      .map((entry) => ({ entry, tools: [] }));
  }
  async start(active: Set<string> = new Set()) {
    await Promise.all(
      this.servers
        .filter(
          (server) =>
            server.entry.config.exposure === "direct" ||
            Object.values(server.entry.config.toolExposure ?? {}).includes("direct") ||
            [...active].some((name) => name.startsWith(namespace(server.entry.name) + "__")),
        )
        .map((server) => this.ensure(server)),
    );
  }
  private ensure(server: Server) {
    if (this.closed) throw new Error("MCP connections are closed.");
    if (server.opening) return server.opening;
    const opening = this.open(server).catch((error) => {
      if (server.opening !== opening) return;
      server.error = error instanceof Error ? error.message : String(error);
      this.input.diagnostics?.record({
        component: "mcp",
        event: "connection.failed",
        level: "error",
        actionable: !server.login && !this.closed,
        error,
        data: { server: server.entry.name },
      });
      if (!server.login) server.opening = undefined;
      if (!this.closed) this.notify(`${server.entry.name}: ${server.error}`, "warning");
    });
    server.opening = opening;
    return opening;
  }
  async ready(name?: string) {
    const servers = name ? this.servers.filter((s) => s.entry.name === name) : this.servers;
    if (name && !servers.length) throw new Error(`Unknown MCP server: ${name}`);
    await Promise.all(servers.map((server) => this.ensure(server)));
    this.authController.signal.throwIfAborted();
  }
  tools(
    approve?: (name: string, args: unknown, callId: string, signal?: AbortSignal) => Promise<void>,
  ) {
    return [
      ...this.servers
        .flatMap((server) => server.tools)
        .filter((tool) => tool.exposure !== "hidden")
        .map(
          (tool) =>
            ({
              ...tool,
              execute: async (args, api, context) => {
                if (tool.requiresApproval) {
                  if (!approve) throw new Error("MCP writes require an approval handler.");
                  await approve(tool.name, args, api.callId, context.abortSignal);
                }
                context.abortSignal?.throwIfAborted();
                return tool.execute(args, api, context);
              },
            }) satisfies NativeTool,
        ),
      ...(this.servers.length ? this.resources() : []),
    ];
  }
  instructions() {
    return this.servers
      .map(
        (s) =>
          `${namespace(s.entry.name)} (${s.entry.config.exposure ?? "codemode"}): ${s.entry.config.description ?? s.client?.instructions ?? s.error ?? "Discover tools with tool_search."}`,
      )
      .join("\n");
  }
  async command(args: string) {
    if (args.trim())
      throw new Error(
        "Manage MCP configuration in the workbench settings. Run /mcp to inspect connection status.",
      );
    this.notify(
      this.servers
        .map(
          (s) =>
            `${s.entry.name}: ${s.error ?? (s.client?.connectionState === "connected" ? `${s.tools.length} tools connected` : "not connected; connects on discovery or use")}`,
        )
        .join("\n") || "No MCP servers configured.",
    );
  }
  private async open(server: Server) {
    const { entry } = server,
      config = entry.config;
    this.authController.signal.throwIfAborted();
    const client = new McpClient({
      name: "biologue",
      version: "1.0.0",
      requestTimeoutMs: (config.timeout ?? 60) * 1000,
      roots: [{ uri: pathToFileURL(this.input.project).href, name: "project" }],
    });
    client.onError((error) =>
      this.input.diagnostics?.record({
        component: "mcp",
        event: "protocol.failed",
        level: "error",
        actionable: !this.closed,
        error,
        data: { server: server.entry.name },
      }),
    );
    server.client = client;
    let transport;
    if ("url" in config) {
      const headers = Object.fromEntries(
        Object.entries(config.headers ?? {}).map(([key, text]) => [key, value(text)]),
      );
      let authProvider;
      if (config.auth)
        authProvider = {
          token: async () => (await this.input.models.getAuth(config.auth!.provider))?.auth.apiKey,
        };
      else if (!Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
        const callbackUrl = config.oauth?.callbackUrl
          ? new URL(config.oauth.callbackUrl)
          : undefined;
        if (
          callbackUrl &&
          (callbackUrl.protocol !== "http:" ||
            !["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname))
        )
          throw new Error("MCP OAuth requires a loopback callback URL.");
        const directory = join(this.input.stateDir, "mcp-auth");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(
          directory,
          `${createHash("sha256")
            .update(JSON.stringify([entry.name, config.url]))
            .digest("hex")}.json`,
        );
        const makeProvider = (redirectUrl: string) =>
          new McpOAuthProvider({
            serverUrl: config.url,
            redirectUrl,
            clientMetadata: { client_name: config.oauth?.clientName ?? "Biologue" },
            clientId: config.oauth?.clientId,
            clientSecret: config.oauth?.clientSecret ? value(config.oauth.clientSecret) : undefined,
            store: {
              load: () =>
                existsSync(path)
                  ? (JSON.parse(readFileSync(path, "utf8")) as McpOAuthState)
                  : undefined,
              save: (state) => {
                writeFileSync(path + ".next", JSON.stringify(state), { mode: 0o600 });
                renameSync(path + ".next", path);
              },
            },
            onRedirect: (url) => this.notify(`Sign in to ${entry.name}: ${url.href}`),
          });
        let oauth = makeProvider(config.oauth?.callbackUrl ?? "http://127.0.0.1/callback");
        let delegate = adaptOAuthProvider(oauth);
        let callbackOpening: Promise<OAuthCallbackServer> | undefined;
        let configuredAttempt: Promise<void> | undefined;
        const flow = {
          serverUrl: config.url,
          scope: config.oauth?.scope,
          authorizationServerMetadataUrl: config.oauth?.authServerMetadataUrl
            ? new URL(config.oauth.authServerMetadataUrl)
            : undefined,
        };
        authProvider = {
          token: () => delegate.token(),
          onUnauthorized: async (
            challenge: Parameters<NonNullable<typeof delegate.onUnauthorized>>[0],
          ) => {
            // A callback listener exists only after an actual authentication challenge.
            const callback = await (callbackOpening ??= (async () => {
              const callbackHost = callbackUrl?.hostname.replace(/^\[|\]$/g, "");
              const opened = await OAuthCallbackServer.listen({
                port: callbackUrl?.port ? Number(callbackUrl.port) : config.oauth?.callbackPort,
                host: callbackHost === "::1" ? "::1" : undefined,
                redirectHost: callbackHost,
                path: callbackUrl?.pathname,
              });
              server.callback = opened;
              server.callbackClosing = undefined;
              if (this.closed) {
                await opened.close();
                throw new Error("MCP connection cancelled.");
              }
              oauth = makeProvider(opened.redirectUrl);
              delegate = adaptOAuthProvider(oauth);
              return opened;
            })());
            try {
              if (flow.scope || flow.authorizationServerMetadataUrl) {
                const metadata = parseWwwAuthenticate(
                  challenge.response.headers.get("www-authenticate"),
                );
                await (configuredAttempt ??= authorizeMcp(oauth, {
                  ...flow,
                  scope: flow.scope ?? metadata.scope,
                  resourceMetadataUrl: metadata.resourceMetadataUrl,
                  fetch: challenge.fetch,
                  skipRefresh: metadata.error === "insufficient_scope",
                })
                  .then((result) => {
                    if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
                  })
                  .finally(() => {
                    configuredAttempt = undefined;
                  }));
              } else await delegate.onUnauthorized!(challenge);
            } catch (error) {
              if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
              server.login ??= callback
                .waitForCallback(await oauth.state())
                .then(async ({ code, iss }) => {
                  await authorizeMcp(oauth, {
                    ...flow,
                    authorizationCode: code,
                    iss,
                    fetch: (url, init) =>
                      fetch(url, { ...init, signal: this.authController.signal }),
                  });
                  await this.closeCallback(server);
                  if (!this.closed) {
                    await client.close();
                    server.opening = this.open(server);
                    await server.opening;
                  }
                })
                .catch((cause) => {
                  this.input.diagnostics?.record({
                    component: "mcp",
                    event: "login.failed",
                    level: "warning",
                    error: cause,
                    data: { server: server.entry.name, closing: this.closed },
                  });
                  if (!this.closed)
                    this.notify(
                      `MCP sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                      "warning",
                    );
                })
                .finally(() => {
                  server.login = undefined;
                  if (server.error) server.opening = undefined;
                });
              throw error;
            }
          },
        };
      }
      transport = new StreamableHttpTransport({
        url: config.url,
        headers,
        authProvider,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([
              this.authController.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      });
    } else
      transport = new StdioTransport({
        command: expandHome(config.command),
        args: config.args?.map(expandHome),
        cwd: resolve(this.input.project, expandHome(config.cwd ?? ".")),
        env: Object.fromEntries(
          Object.entries(config.env ?? {}).map(([key, text]) => [key, value(text)]),
        ),
      });
    if (this.closed) {
      await client.close();
      throw new Error("MCP connection cancelled.");
    }
    try {
      await client.connect(transport);
      await this.refresh(server);
      server.error = undefined;
      this.input.diagnostics?.record({
        component: "mcp",
        event: "connection.ready",
        data: { server: server.entry.name, tools: server.tools.length },
      });
    } catch (error) {
      if (!server.login) await client.close();
      throw error;
    }
    client.onClose(() => {
      if (server.client === client && !this.closed) server.opening = undefined;
      this.input.diagnostics?.record({
        component: "mcp",
        event: "connection.closed",
        level: this.closed ? "info" : "warning",
        data: { server: server.entry.name, expected: this.closed },
      });
    });
    client.onNotification("notifications/tools/list_changed", () => {
      void this.refresh(server).catch((error) => {
        this.input.diagnostics?.record({
          component: "mcp",
          event: "tools.refresh_failed",
          level: "error",
          actionable: !this.closed,
          error,
          data: { server: server.entry.name },
        });
        this.notify(String(error), "warning");
      });
    });
  }
  private async refresh(server: Server) {
    const { client, entry } = server;
    const tools = await client!.listTools({ signal: this.authController.signal });
    const plainCounts = new Map<string, number>();
    for (const raw of new Set(tools.map((tool) => tool.name))) {
      const plain = toolName(entry.name, raw, () => false);
      plainCounts.set(plain, (plainCounts.get(plain) ?? 0) + 1);
    }
    server.tools = tools.map((tool) => {
      const owner = JSON.stringify([entry.name, tool.name]);
      const name = toolName(entry.name, tool.name, (candidate) => {
        const other = this.toolOwners.get(candidate);
        return (other !== undefined && other !== owner) || (plainCounts.get(candidate) ?? 0) > 1;
      });
      this.toolOwners.set(name, owner);
      return {
        name,
        namespace: namespace(entry.name),
        exposure: exposure(entry, tool.name),
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe<Record<string, unknown>>({
          ...tool.inputSchema,
          type: "object",
          properties: tool.inputSchema.properties ?? {},
        }),
        replay: "unsafe",
        executionMode: "sequential",
        requiresApproval: tool.annotations?.readOnlyHint !== true,
        execute: async (args, api, context) => {
          await awaitWithContext(this.ensure(server), context);
          if (server.error) throw new Error(server.error);
          const result = await server.client!.callTool(tool.name, args as Record<string, unknown>, {
            signal: context.abortSignal,
            onProgress: (progress) => {
              void api.details(JSON.parse(JSON.stringify(progress)), context).catch((error) =>
                this.input.diagnostics?.record({
                  component: "mcp",
                  event: "tool.progress_failed",
                  level: context.abortSignal?.aborted ? "info" : "error",
                  actionable: !context.abortSignal?.aborted,
                  error,
                  nativeConversationId: String(api.conversationId),
                  taskId: String(api.taskId),
                  toolCallId: api.callId,
                  data: { server: entry.name, tool: name },
                }),
              );
            },
          });
          return {
            content: toLlmContent(result),
            isError: result.isError === true,
            details: JSON.parse(
              JSON.stringify({
                ...(result.structuredContent
                  ? { structuredContent: result.structuredContent }
                  : {}),
              }),
            ),
          };
        },
      };
    });
    await this.changed();
  }
  private closeCallback(server: Server) {
    return (server.callbackClosing ??= server.callback?.close());
  }
  private resources(): NativeTool[] {
    return ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map(
      (name) => ({
        name,
        exposure: "direct",
        description: `${name.replaceAll("_", " ")}. Select a configured server by name.`,
        parameters: Type.Object({
          server: Type.Optional(Type.String()),
          cursor: Type.Optional(Type.String()),
          ...(name === "read_mcp_resource" ? { uri: Type.String() } : {}),
        }),
        replay: "unsafe",
        execute: async (raw, _api, context) => {
          const args = raw as { server?: string; cursor?: string; uri?: string };
          await awaitWithContext(this.ready(args.server), context);
          const servers = args.server
            ? this.servers.filter((s) => s.entry.name === args.server)
            : this.servers.filter((s) => s.client?.serverCapabilities?.resources);
          if (!servers.length || (name === "read_mcp_resource" && servers.length !== 1))
            throw new Error("Choose a configured MCP resource server.");
          const results = await Promise.all(
            servers.map(async (server) => {
              if (server.error) throw new Error(server.error);
              try {
                const result =
                  name === "read_mcp_resource"
                    ? await server.client!.readResource(args.uri!, { signal: context.abortSignal })
                    : name === "list_mcp_resources"
                      ? await server.client!.listResourcesPage(args.cursor, {
                          signal: context.abortSignal,
                        })
                      : await server.client!.listResourceTemplatesPage(args.cursor, {
                          signal: context.abortSignal,
                        });
                return { server: server.entry.name, ...result };
              } catch (error) {
                if (
                  error instanceof McpError &&
                  error.code === -32601 &&
                  name !== "read_mcp_resource"
                )
                  return {
                    server: server.entry.name,
                    ...(name === "list_mcp_resources"
                      ? { resources: [] }
                      : { resourceTemplates: [] }),
                  };
                throw error;
              }
            }),
          );
          return {
            content:
              name === "read_mcp_resource"
                ? toLlmContent({
                    content: results.flatMap((r) =>
                      "contents" in r
                        ? r.contents.map((resource) => ({ type: "resource" as const, resource }))
                        : [],
                    ),
                  })
                : [{ type: "text", text: JSON.stringify(results) }],
            details: JSON.parse(JSON.stringify(results)),
          };
        },
      }),
    );
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.authController.abort();
    return (this.closing = (async () => {
      this.listeners.clear();
      const results = await Promise.allSettled(
        this.servers.flatMap((s) => [s.client?.close(), this.closeCallback(s)]),
      );
      await Promise.allSettled(this.servers.flatMap((server) => [server.login, server.opening]));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "Could not close MCP clients.",
        );
    })());
  }
}
