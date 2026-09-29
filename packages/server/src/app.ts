import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { Snapshot, Execution, Document, Conversation, AgentRun } from "@carl/protocol";
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
import { adapters } from "./adapters.ts";

export interface AppOptions {
  project: string;
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
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2_100_000 });
  const events = new Events();
  const store = new Store(resolve(options.stateDir, "carl.sqlite"));
  const documents = new Documents(options.project, store, events, true);
  const context = new ContextService(store, events);
  const kernel =
    options.kernel ??
    new JupyterKernels(
      documents.root,
      options.jupyterUrl ?? "http://127.0.0.1:8889/",
      options.jupyterToken ?? "",
    );
  const outputs = new OutputService(store, events, resolve(options.stateDir, "artifacts"));
  const execution = new ExecutionService(store, events, kernel, outputs);
  const permissions = new Permissions(store, events);
  const sessions = new ConversationSessions(documents.root, options.stateDir, store, events);
  const pi = options.pi ?? new PiAdapter({ project: documents.root, stateDir: options.stateDir });
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
    allowedOrigins.add(`http://${host}:${process.env.CARL_PORT || 4317}`);
    allowedOrigins.add(`http://${host}:${process.env.CARL_UI_PORT || 5173}`);
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
        .header("Access-Control-Allow-Headers", "Content-Type, X-Carl-Client")
        .header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        .code(204)
        .send();
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-carl-client"] !== "workbench"
    )
      return reply.code(403).send({ error: "Missing workbench request header." });
  });
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
      .send(documents.createUntitled(z.object({ language }).parse(request.body).language)),
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
  app.patch("/api/conversations/:id", async (request) =>
    context.renameConversation(
      z.object({ id: z.string().uuid() }).parse(request.params).id,
      z.object({ title: z.string().trim().min(1).max(120) }).parse(request.body).title,
    ),
  );
  app.post("/api/agent/runs", async (request, reply) => {
    const body = z
      .object({ conversationId: z.string().uuid(), text: z.string().trim().min(1).max(50_000) })
      .parse(request.body);
    return reply.code(202).send(supervisor.start(body.conversationId, body.text));
  });
  app.post("/api/agent/runs/:id/cancel", async (request) => {
    await supervisor.cancel(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return { ok: true };
  });
  app.post("/api/agent/runs/:id/steer", async (request) => {
    await supervisor.steer(
      z.object({ id: z.string().uuid() }).parse(request.params).id,
      z.object({ text: z.string().trim().min(1).max(50_000) }).parse(request.body).text,
    );
    return { ok: true };
  });
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
