import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { diagnosticValue, inspectDurable, type Diagnostics } from "./diagnostics.ts";
import type { Supervisor } from "./supervisor.ts";
import type { ExecutionService } from "./execution.ts";
import type { Store } from "./store.ts";
import type { AgentRun } from "@biologue/protocol";

const paging = {
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  since: z.iso.datetime().optional(),
};
const id = z.string().min(1).max(300).optional();
export function diagnosticRoutes(
  app: FastifyInstance,
  diagnostics: Diagnostics,
  supervisor: Supervisor,
  execution: ExecutionService,
  store: Store,
) {
  app.get("/api/diagnostics/status", async () => diagnostics.status());
  app.get("/api/diagnostics/live", async () => inspectDurable(supervisor.harness));
  app.get("/api/diagnostics/events", async (request) =>
    diagnostics.events(
      z
        .object({
          ...paging,
          runId: id,
          conversationId: id,
          nativeConversationId: id,
          taskId: id,
          toolCallId: id,
          executionId: id,
          requestId: id,
          sessionId: id,
          component: id,
          event: id,
          fingerprint: id,
          level: z.enum(["info", "warning", "error"]).optional(),
        })
        .parse(request.query),
    ),
  );
  app.get("/api/diagnostics/issues", async (request) =>
    diagnostics.issues(z.object(paging).parse(request.query)),
  );
  app.get("/api/diagnostics/bundle", async (request, reply) => {
    const query = z
      .object({
        runId: id,
        eventId: z.coerce.number().int().positive().optional(),
        after: paging.after,
        limit: paging.limit,
      })
      .refine((q) => q.runId || q.eventId, {
        message: "Provide runId or eventId.",
      })
      .parse(request.query);
    const event = query.eventId ? diagnostics.get(query.eventId) : undefined;
    if (query.eventId && !event)
      return reply.code(404).send({ error: "Diagnostic event does not exist or has expired." });
    const runId = query.runId ?? event?.runId;
    const page = runId
      ? diagnostics.events({ runId, after: query.after, limit: query.limit ?? 500 })
      : diagnostics.events({
          fingerprint: event?.fingerprint,
          ...(!event?.fingerprint
            ? {
                sessionId: event?.sessionId,
                requestId: event?.requestId,
                executionId: event?.executionId,
                taskId: event?.taskId,
                component: event?.component,
              }
            : {}),
          after: query.after,
          limit: query.limit ?? 100,
        });
    const run = runId ? store.get<AgentRun>("run", runId) : undefined;
    const nativeConversationId =
      run?.piSessionId ??
      event?.nativeConversationId ??
      page.items.find((e) => e.nativeConversationId)?.nativeConversationId;
    const ids = [
      ...new Set(
        [event?.executionId, ...page.items.map((e) => e.executionId)].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const executions = ids.slice(0, 100).map((executionId) => {
      const record = execution.get(executionId);
      if (!record) return { id: executionId, missing: true };
      const { code: _code, codePreview: _preview, ...metadata } = record;
      return {
        ...metadata,
        sourceUrl: `../executions/${executionId}`,
        outputs: execution.outputs.references(executionId, 0, 8).map((o) => ({
          id: o.id,
          kind: o.kind,
          mimeTypes: o.mimeTypes,
          url: `../outputs/${o.id}`,
        })),
        outputCount: execution.outputs.count(executionId),
      };
    });
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      diagnostics: diagnostics.status(),
      event,
      run: diagnosticValue(run && { ...run, activity: undefined, notices: undefined }),
      events: page,
      executions: diagnosticValue(executions),
      nativeEvents: nativeConversationId
        ? diagnostics.events({ nativeConversationId, limit: 100, since: run?.startedAt })
        : undefined,
      live: await inspectDurable(supervisor.harness),
      evidence: {
        durableDatabase: "pi/durable.sqlite",
        applicationDatabase: "biologue.sqlite",
        nativeConversationId,
        urlBase: "Resolve source and output URLs relative to this bundle endpoint.",
        note: "Canonical prompts, tool arguments/results, executed source and artifacts remain in their original stores. Logs and issue counts are retained for a bounded period. Follow pagination cursors for more events.",
      },
    };
  });
}
