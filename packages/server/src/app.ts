import { projectRoutes } from "./projects.ts";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { Snapshot, Execution, Document, Conversation, AgentRun } from "@biologue/protocol";
import { OutputService } from "./outputs.ts";
import { Store } from "./store.ts";
import { Events } from "./events.ts";
import { Documents } from "./documents.ts";
import { ContextService } from "./context.ts";
import { ExecutionService, type KernelBackend } from "./execution.ts";
import { JupyterKernels } from "./kernels.ts";
import { Permissions } from "./permissions.ts";
import { PiAdapter } from "./pi.ts";
import { Supervisor } from "./supervisor.ts";
import { ConversationSessions } from "./conversation-sessions.ts";
import { EnvironmentService } from "./environment.ts";
import { adapters } from "./adapters.ts";
import { ProviderAuth } from "./provider-auth.ts";
import { Attachments } from "./attachments.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export interface AppOptions {
  project: string;
  projects?: boolean;
  jupyterRoot?: string;
  stateDir: string;
  repository: string;
  jupyterUrl?: string;
  jupyterToken?: string;
  externalOrigin?: string;
  kernel?: KernelBackend;
  pi?: PiAdapter;
  logger?: boolean;
}
const language = z.enum(["python", "r"]);
const pathSchema = z.object({ path: z.string().min(1).max(1000) });

export async function createApp(options: AppOptions) {
  const externalOrigin = options.externalOrigin ? new URL(options.externalOrigin) : undefined;
  if (
    externalOrigin &&
    (externalOrigin.protocol !== "https:" || externalOrigin.origin !== options.externalOrigin)
  )
    throw new Error("externalOrigin must be an HTTPS origin without a path.");
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 6_000_000 });
  const pi =
    options.pi ?? new PiAdapter({ project: resolve(options.project), stateDir: options.stateDir });
  // Claim ownership before application services reconcile unfinished executions.
  const opened = await pi.openHarness();
  try {
    return await createOwnedApp(options, externalOrigin, app, pi, opened);
  } catch (error) {
    await opened.harness.close(BACKGROUND_CONTEXT);
    pi.releaseHarness();
    throw error;
  }
}

async function createOwnedApp(
  options: AppOptions,
  externalOrigin: URL | undefined,
  app: FastifyInstance,
  pi: PiAdapter,
  opened: Awaited<ReturnType<PiAdapter["openHarness"]>>,
) {
  const events = new Events();
  const store = new Store(resolve(options.stateDir, "biologue.sqlite"));
  const documents = new Documents(options.project, store, events, true);
  const context = new ContextService(store, events);
  const kernel =
    options.kernel ??
    new JupyterKernels(
      documents.root,
      options.jupyterUrl ?? "http://127.0.0.1:8889/",
      options.jupyterToken ?? "",
      options.jupyterRoot,
    );
  const outputs = new OutputService(store, events, resolve(options.stateDir, "artifacts"));
  const execution = new ExecutionService(store, events, kernel, outputs);
  const environment = new EnvironmentService(execution, events);
  const permissions = new Permissions(store, events);
  const sessions = new ConversationSessions(store, events);
  const auth = new ProviderAuth(pi);
  const attachments = new Attachments(store, documents);
  const supervisor = new Supervisor(
    store,
    events,
    context,
    documents,
    execution,
    permissions,
    pi,
    readFileSync(resolve(options.repository, "prompts/collaborator.md"), "utf8"),
    sessions,
  );
  try {
    await supervisor.initialize(opened);
  } catch (error) {
    environment.close();
    auth.close();
    await execution.close();
    if (kernel instanceof JupyterKernels) kernel.dispose();
    documents.close();
    context.close();
    store.close();
    await app.close();
    throw error;
  }
  const streams = new Set<ServerResponse>();
  const allowedOrigins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);
  for (const host of ["127.0.0.1", "localhost"]) {
    allowedOrigins.add(`http://${host}:${process.env.BIOLOGUE_PORT || 4317}`);
    allowedOrigins.add(`http://${host}:${process.env.BIOLOGUE_UI_PORT || 5173}`);
  }
  if (externalOrigin) allowedOrigins.add(externalOrigin.origin);

  app.addHook("onRequest", async (request, reply) => {
    const host = new URL(`http://${request.headers.host || "localhost"}`).hostname;
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(host) &&
      request.headers.host !== externalOrigin?.host
    )
      return reply.code(403).send({ error: "Host is not allowed." });
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin))
      return reply.code(403).send({ error: "Origin is not allowed." });
    if (origin) reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
    if (request.method === "OPTIONS")
      return reply
        .header("Access-Control-Allow-Headers", "Content-Type, X-Biologue-Client")
        .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        .code(204)
        .send();
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-biologue-client"] !== "workbench"
    )
      return reply.code(403).send({ error: "Missing workbench request header." });
  });
  if (options.projects) projectRoutes(app, options, store);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(error) });
    const failure = error as Error & { statusCode?: number; code?: string };
    return reply
      .code(failure.statusCode ?? (failure.code === "ENOENT" ? 404 : 500))
      .send({ error: failure.message });
  });
  const snapshot = (): Snapshot => {
    const history = execution.repository.list(100);
    return {
      project: documents.root,
      files: documents.list(),
      documents: store.list<Document>("document").filter((doc) => !doc.savedAs),
      executions: history.items,
      executionCursor: history.next,
      conversations: store.list<Conversation>("conversation"),
      researchContext: context.get(),
      runs: store.list<AgentRun>("run", 100),
      permissions: permissions.list(),
      permissionHistory: permissions.history(),
      sessions: kernel instanceof JupyterKernels ? kernel.sessions() : [],
      agent: pi.status(),
      questions: supervisor.dialogs.list(),
      layout: store.get("settings", "layout"),
    };
  };
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/snapshot", async () => snapshot());
  app.get("/api/events", (request, reply) => {
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    if (request.headers.origin) headers["Access-Control-Allow-Origin"] = request.headers.origin;
    reply.hijack();
    reply.raw.writeHead(200, headers);
    const send = (value: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      // A slow client reconnects to a bounded snapshot instead of retaining unbounded buffers.
      if (reply.raw.writableLength > 8_000_000) {
        reply.raw.destroy();
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    const unsubscribe = events.subscribe(send);
    streams.add(reply.raw);
    send({ type: "snapshot", snapshot: snapshot() });
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15000);
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(reply.raw);
    });
  });
  app.get("/api/documents", async (request) =>
    documents.open(pathSchema.parse(request.query).path),
  );
  app.post("/api/documents", async (request, reply) =>
    reply.code(201).send(documents.create(pathSchema.parse(request.body).path)),
  );
  app.post("/api/documents/untitled", async (request, reply) =>
    reply
      .code(201)
      .send(
        documents.createUntitled(
          z.object({ language: z.enum(["r", "python", "text"]) }).parse(request.body).language,
        ),
      ),
  );
  app.post("/api/documents/save-as", async (request) => {
    const body = z
      .object({
        path: z.string().min(1),
        target: z.string().min(1).max(1000),
        expectedVersion: z.number().int().positive(),
      })
      .parse(request.body);
    return documents.saveAs(body.path, body.target, body.expectedVersion);
  });
  app.put("/api/documents", async (request) => {
    const body = pathSchema
      .extend({
        content: z.string().max(2_000_000),
        expectedVersion: z.number().int().min(1),
        editId: z.string().uuid().optional(),
      })
      .parse(request.body);
    return documents.edit(body.path, body.content, body.expectedVersion, body.editId);
  });
  app.post("/api/documents/save", async (request) => {
    const body = pathSchema
      .extend({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    return documents.save(body.path, body.expectedVersion);
  });
  app.post("/api/documents/reconcile", async (request) => {
    const body = pathSchema
      .extend({
        expectedVersion: z.number().int().min(1),
        expectedDiskHash: z.string().nullable(),
        choice: z.enum(["disk", "working"]),
      })
      .parse(request.body);
    return documents.reconcile(body.path, body.expectedVersion, body.expectedDiskHash, body.choice);
  });
  app.get("/api/executions", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: z.string().optional(),
      })
      .parse(request.query);
    return execution.repository.list(query.limit, query.before);
  });
  app.get("/api/outputs", async (request) => {
    const query = z
      .object({
        executionId: z.string().uuid().optional(),
        language: language.optional(),
        kind: z.enum(["plots", "tables"]).optional(),
        before: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    return outputs.visible(query);
  });
  app.get("/api/outputs/:id/reference", async (request, reply) => {
    const reference = outputs.reference(
      z.object({ id: z.string().uuid() }).parse(request.params).id,
    );
    return reference ?? reply.code(404).send({ error: "Output does not exist." });
  });
  app.get("/api/outputs/:id", async (request, reply) => {
    const output = outputs.get(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return output ?? reply.code(404).send({ error: "Output does not exist." });
  });
  app.get("/api/outputs/:id/png", async (request, reply) => {
    const output = outputs.get(z.object({ id: z.string().uuid() }).parse(request.params).id);
    const png = output?.data?.["image/png"];
    return typeof png === "string"
      ? reply
          .type("image/png")
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .send(Buffer.from(png, "base64"))
      : reply.code(404).send({ error: "Image does not exist." });
  });
  app.get("/api/outputs/:id/table", async (request, reply) => {
    const result = outputs.table(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return result ?? reply.code(404).send({ error: "This output is not a table." });
  });
  app.get(
    "/api/executions/:id/result",
    async (request) =>
      outputs.result(z.object({ id: z.string().uuid() }).parse(request.params).id) ?? null,
  );
  app.post("/api/executions", async (request, reply) => {
    const body = z
      .object({
        language,
        code: z.string().min(1).max(200_000),
        document: z
          .object({
            path: z.string(),
            version: z.number().int(),
            selection: z
              .object({ from: z.number().int().min(0), to: z.number().int().min(1) })
              .optional(),
          })
          .optional(),
      })
      .parse(request.body);
    if (body.document)
      documents.verifyReference(
        body.document.path,
        body.document.version,
        body.code,
        body.document.selection,
      );
    return reply.code(202).send(execution.submit({ ...body, actor: "human" }));
  });
  app.get("/api/executions/:id", async (request, reply) => {
    const record = execution.get(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return record ?? reply.code(404).send({ error: "Execution does not exist." });
  });
  app.post("/api/executions/:id/cancel", async (request) => {
    await execution.cancel(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return { ok: true };
  });
  app.post("/api/environment", async (request) => {
    const body = z.object({ language }).parse(request.body);
    return environment.refresh(body.language);
  });
  app.post("/api/inspect", async (request, reply) => {
    const body = z
      .object({
        language,
        names: z.array(z.string().max(1000)).max(100).optional(),
        offset: z.number().int().min(0).default(0),
      })
      .parse(request.body);
    return reply.code(202).send(
      execution.submit({
        language: body.language,
        actor: "human",
        code: adapters[body.language].inspectionCode(body),
        inspectionOptions: { names: body.names, offset: body.offset },
        inspection: "environment",
        purpose: "inspection",
      }),
    );
  });
  app.post("/api/table", async (request, reply) => {
    const body = z.object({ language, name: z.string().min(1).max(500) }).parse(request.body);
    return reply.code(202).send(
      execution.submit({
        language: body.language,
        actor: "human",
        code: adapters[body.language].tableCode(body.name),
        inspection: "table",
        purpose: "inspection",
      }),
    );
  });
  app.put("/api/context", async (request) => {
    const body = z
      .object({ text: z.string().max(100_000), expectedVersion: z.number().int().min(0) })
      .parse(request.body);
    return context.update(body.text, body.expectedVersion);
  });
  app.get("/api/conversations/:id/messages", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().max(2000).optional(),
      })
      .parse(request.query);
    return sessions.page(id, query.limit, query.before);
  });
  app.post("/api/conversations", async (request) =>
    context.createConversation(
      z.object({ title: z.string().trim().min(1).max(120).optional() }).parse(request.body).title,
    ),
  );
  const conversationId = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.patch("/api/conversations/:id", async (request) => {
    const id = conversationId(request.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        archived: z.boolean().optional(),
        pinned: z.boolean().optional(),
      })
      .parse(request.body);
    if (body.archived && supervisor.isActive(id))
      throw Object.assign(new Error("Stop this response before archiving."), { statusCode: 409 });
    if (body.title) context.renameConversation(id, body.title);
    return context.updateConversation(id, {
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
    });
  });
  app.get("/api/conversations/search", async (request) => {
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(request.query);
    return { ids: await sessions.search(q) };
  });
  app.post("/api/conversations/:id/fork", async (request) => {
    const id = conversationId(request.params);
    if (supervisor.isActive(id))
      throw Object.assign(new Error("Stop this response before branching."), { statusCode: 409 });
    const body = z.object({ entryId: z.string().min(1).max(100).optional() }).parse(request.body);
    const parent = store.get<Conversation>("conversation", id);
    if (!parent) throw Object.assign(new Error("Conversation not found."), { statusCode: 404 });
    const leaf = body.entryId ?? String((await sessions.leaf(id)) ?? "");
    if (!leaf || !(await sessions.history(id)).some((entry) => String(entry.id) === leaf))
      throw Object.assign(new Error("Choose a delivered message to branch from."), {
        statusCode: 400,
      });
    const child = context.createConversation(`${parent.title.slice(0, 100)} (branch)`);
    await sessions.fork(id, child.id, leaf);
    return context.updateConversation(child.id, { parentId: id, settings: parent.settings });
  });
  app.get("/api/conversations/:id/export", async (request, reply) => {
    const id = conversationId(request.params);
    const conversation = store.get<Conversation>("conversation", id);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found." });
    const text =
      `# ${conversation.title}\n\n` +
      (await sessions.export(id))
        .map(
          (message) =>
            `## ${message.role === "user" ? "You" : "Biologue"}\n\n${message.text}${message.attachments?.length ? "\n\nAttachments: " + message.attachments.map((item) => item.name).join(", ") : ""}`,
        )
        .join("\n\n");
    return reply
      .type("text/markdown; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="conversation.md"')
      .send(text);
  });
  app.post("/api/conversations/:id/compact", async (request) =>
    supervisor.start(conversationId(request.params), "", { kind: "compaction" }),
  );
  let modelConfiguring = false;
  app.get("/api/agent/models", async (request) =>
    pi.models(
      z.object({ all: z.enum(["true", "false"]).optional() }).parse(request.query).all === "true",
    ),
  );
  app.put("/api/conversations/:id/settings", async (request) => {
    const id = conversationId(request.params);
    if (supervisor.isActive(id))
      throw Object.assign(new Error("Stop this response before changing settings."), {
        statusCode: 409,
      });
    const body = z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        thinking: z.string(),
        mode: z.enum(["ask", "plan", "edit", "auto"]).default("ask"),
      })
      .parse(request.body);
    await pi.validate(body);
    if (supervisor.isActive(id))
      throw Object.assign(
        new Error("This conversation started responding. Stop it before changing settings."),
        { statusCode: 409 },
      );
    return context.updateConversation(id, { settings: body });
  });
  app.get("/api/agent/preferences", async () => pi.preferences());
  app.put("/api/agent/preferences", async (request) =>
    pi.configurePreferences(
      z
        .object({
          autoCompact: z.boolean(),
          autoRetry: z.boolean(),
          steeringMode: z.enum(["all", "one-at-a-time"]),
          followUpMode: z.enum(["all", "one-at-a-time"]),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/agent/resources", async () => pi.resources());
  const mcpExposure = z.union([
    z.enum(["direct", "codemode", "deferred", "hidden"]),
    z.literal("codemode-deferred").transform(() => "deferred" as const),
  ]);
  const mcpCommon = {
    enabled: z.boolean().optional(),
    exposure: mcpExposure.optional(),
    toolExposure: z.record(z.string(), mcpExposure).optional(),
    timeout: z.number().min(1).max(600).optional(),
  };
  // Configure MCP explicitly in Pi's project agent directory. Secrets use environment references.
  const referenceValue = z
    .string()
    .max(2000)
    .refine(
      (value) => !value.trim().startsWith("!"),
      "Use an environment variable reference instead of a command.",
    );
  const mcpConfig = z.union([
    z
      .object({
        ...mcpCommon,
        type: z.literal("http").optional(),
        url: z.url(),
        headers: z.record(z.string(), referenceValue).optional(),
        oauth: z
          .object({
            clientId: z.string().optional(),
            clientSecret: referenceValue.optional(),
            callbackPort: z.number().int().min(1).max(65535).optional(),
            callbackUrl: z
              .url()
              .refine((value) => {
                const url = new URL(value);
                return (
                  url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                );
              }, "Use an HTTP loopback callback URL.")
              .optional(),
            scope: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...mcpCommon,
        type: z.literal("stdio").optional(),
        command: z.string().min(1).max(1000),
        args: z.array(z.string().max(2000)).max(100).optional(),
        env: z.record(z.string(), referenceValue).optional(),
        cwd: z.string().max(1000).optional(),
      })
      .strict(),
  ]);
  app.get("/api/agent/mcp", async () =>
    pi.mcpServers().map(({ name, config }) => {
      const visible = structuredClone(config);
      for (const field of ["headers", "env"] as const) {
        const values =
          field in visible
            ? (visible as unknown as Record<string, Record<string, string>>)[field]
            : undefined;
        for (const [key, value] of Object.entries(values ?? {}))
          if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) values![key] = "[configured]";
      }
      if ("oauth" in visible && visible.oauth && visible.oauth.clientSecret)
        visible.oauth.clientSecret = "[configured]";
      return { name, config: visible };
    }),
  );
  app.put("/api/agent/mcp/:name", async (request) => {
    const { name } = z
      .object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) })
      .parse(request.params);
    const config = mcpConfig.nullable().parse(request.body);
    if (supervisor.isActive())
      throw Object.assign(new Error("Stop active responses before changing connections."), {
        statusCode: 409,
      });
    if (config && "url" in config && !["http:", "https:"].includes(new URL(config.url).protocol))
      throw Object.assign(new Error("Use an HTTP or HTTPS endpoint."), { statusCode: 400 });
    const previous = pi.mcpServers().find((item) => item.name === name)?.config;
    for (const field of ["headers", "env"] as const) {
      const values =
        config && field in config
          ? ((config as Record<string, unknown>)[field] as Record<string, string> | undefined)
          : undefined;
      for (const [key, value] of Object.entries(values ?? {}))
        if (value === "[configured]") {
          const saved =
            previous && field in previous
              ? (previous as unknown as Record<string, Record<string, string>>)[field]?.[key]
              : undefined;
          if (saved === undefined)
            throw Object.assign(new Error("Enter a value for this configuration field."), {
              statusCode: 400,
            });
          values![key] = saved;
        }
    }
    if (
      config &&
      "oauth" in config &&
      config.oauth &&
      config.oauth.clientSecret === "[configured]"
    ) {
      const saved =
        previous && "oauth" in previous && previous.oauth ? previous.oauth.clientSecret : undefined;
      if (!saved)
        throw Object.assign(new Error("Enter the OAuth client secret."), { statusCode: 400 });
      config.oauth.clientSecret = saved;
    }
    pi.saveMcpServer(name, config);
    return { ok: true };
  });
  app.get("/api/agent/providers", async () => auth.providers());
  app.get("/api/agent/auth", async () => auth.current());
  app.post("/api/agent/auth", async (request) => {
    const body = z
      .object({ provider: z.string().min(1).max(200), type: z.enum(["oauth", "api_key"]) })
      .parse(request.body);
    return auth.start(body.provider, body.type);
  });
  app.get("/api/agent/auth/:id", async (request) => auth.get(conversationId(request.params)));
  app.post("/api/agent/auth/:id/answer", async (request) => {
    const body = z
      .object({ promptId: z.string().uuid(), value: z.string().min(1).max(16000) })
      .parse(request.body);
    return auth.respond(conversationId(request.params), body.promptId, body.value);
  });
  app.post("/api/agent/auth/:id/cancel", async (request) =>
    auth.cancel(conversationId(request.params)),
  );
  app.post("/api/agent/providers/logout", async (request) => {
    if (supervisor.isActive())
      throw Object.assign(new Error("Stop active responses before signing out."), {
        statusCode: 409,
      });
    return auth.logout(
      z.object({ provider: z.string().min(1).max(200) }).parse(request.body).provider,
    );
  });
  app.post("/api/agent/questions/:id", async (request) =>
    supervisor.dialogs.answer(
      conversationId(request.params),
      z.object({ answer: z.string().max(50000).optional() }).parse(request.body).answer,
    ),
  );
  app.post("/api/attachments", async (request) =>
    attachments.create(
      z
        .object({
          path: z.string().max(1000).optional(),
          name: z.string().max(200).optional(),
          mimeType: z.string().max(200).optional(),
          data: z.string().max(5_400_000).optional(),
        })
        .parse(request.body),
    ),
  );
  app.put("/api/agent/settings", async (request, reply) => {
    if (
      modelConfiguring ||
      store
        .list<AgentRun>("run")
        .some((run) => ["running", "awaiting_permission", "queued"].includes(run.status))
    )
      return reply
        .code(409)
        .send({ error: "Stop the current response before changing its model." });
    const body = z
      .object({
        provider: z.string(),
        model: z.string(),
        thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      })
      .parse(request.body);
    modelConfiguring = true;
    try {
      const agent = await pi.configure(body.provider, body.model, body.thinking);
      events.emit({ type: "agent-settings", agent });
      return agent;
    } finally {
      modelConfiguring = false;
    }
  });
  app.post("/api/agent/runs", async (request, reply) => {
    if (modelConfiguring)
      return reply.code(409).send({ error: "Model settings are updating. Try sending again." });
    const body = z
      .object({
        conversationId: z.string().uuid(),
        text: z.string().trim().min(1).max(50_000),
        attachments: z.array(z.string().uuid()).max(8).default([]),
      })
      .parse(request.body);
    const prepared = attachments.prepare(body.text, body.attachments);
    return reply.code(202).send(
      await supervisor.start(body.conversationId, body.text, {
        prepared,
        attachments: prepared.attachments,
      }),
    );
  });
  app.post("/api/agent/runs/:id/cancel", async (request) => {
    await supervisor.cancel(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return { ok: true };
  });
  app.post("/api/agent/runs/:id/steer", async (request) => {
    const body = z
      .object({
        text: z.string().trim().min(1).max(50_000),
        mode: z.enum(["steer", "followUp"]).default("steer"),
        attachments: z.array(z.string().uuid()).max(8).default([]),
      })
      .parse(request.body);
    const prepared = attachments.prepare(body.text, body.attachments);
    await supervisor.steer(
      z.object({ id: z.string().uuid() }).parse(request.params).id,
      body.text,
      body.mode,
      { prepared, attachments: prepared.attachments },
    );
    return { ok: true };
  });
  app.post("/api/agent/runs/:id/clear-queue", async (request) =>
    supervisor.clearQueue(conversationId(request.params)),
  );
  app.get("/api/permissions/:id", async (request, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const record = permissions.get(id);
    return record ?? reply.code(404).send({ error: "This request could not be found." });
  });
  app.post("/api/permissions/:id", async (request, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const { allow, feedback } = z
      .object({
        allow: z.boolean(),
        feedback: z.string().trim().min(1).max(5000).optional(),
      })
      .refine(
        (value) => !value.allow || !value.feedback,
        "Feedback accompanies a declined request.",
      )
      .parse(request.body);
    return permissions.decide(id, allow, feedback)
      ? { ok: true }
      : reply.code(409).send({ error: "This request is no longer pending." });
  });
  app.put("/api/layout", async (request) => {
    store.put("settings", "layout", request.body);
    return { ok: true };
  });
  const staticRoot = resolve(options.repository, "packages/workbench/dist");
  if (existsSync(staticRoot)) await app.register(fastifyStatic, { root: staticRoot, list: false });
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  app.addHook("onClose", async () => {
    environment.close();
    auth.close();
    documents.close();
    context.close();
    try {
      const results = await Promise.allSettled([supervisor.close(), execution.close()]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      if (kernel instanceof JupyterKernels) kernel.dispose();
      store.close();
    }
  });
  return {
    app,
    outputs,
    execution,
    documents,
    context,
    events,
    store,
    permissions,
    supervisor,
    sessions,
  };
}
