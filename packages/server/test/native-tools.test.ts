import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AgentDoc, UsageDoc } from "@earendil-works/pi-durable";
import type { AgentQuestion } from "@biologue/protocol";
import { fixture, deferred } from "./helpers/pi-fixture.ts";
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const timeout = { timeout: 30_000 };

test(
  "native code-mode state follows the selected fork prefix without a custom entry journal",
  timeout,
  async () => {
    const f = await fixture();
    try {
      f.faux.setResponses([
        call("codemode", { code: 'store("selectedTool", "read"); text(load("selectedTool"));' }),
        fauxAssistantMessage("First selection saved."),
        call("codemode", {
          code: 'store("selectedTool", "inspect_environment"); text(load("selectedTool"));',
        }),
        fauxAssistantMessage("Second selection saved."),
        call("codemode", { code: 'text(load("selectedTool"));' }),
        fauxAssistantMessage("Branch selection read."),
      ]);
      assert.equal((await f.run("Select a tool")).status, "completed");
      const at = (await f.sessions.page(f.conversationId)).items.at(-1)!.entryId!;
      assert.equal((await f.run("Change the selection")).status, "completed");
      const branch = f.context.createConversation("Selected prefix");
      await f.sessions.fork(f.conversationId, branch.id, at);
      const done = f.finished();
      await f.supervisor.start(branch.id, "Read the saved selection");
      assert.equal((await done).status, "completed");
      const history = await f.sessions.history(branch.id);
      assert.equal(history.filter((entry) => entry.kind.startsWith("biologue.custom.")).length, 0);
      const result = history.filter((entry) => entry.kind === "pi.tool-result").at(-1);
      assert.ok(result);
      assert.match(JSON.stringify(result), /"text":"read"/);
      assert.doesNotMatch(JSON.stringify(result), /inspect_environment/);
    } finally {
      await f.close();
    }
  },
);

test(
  "native tool discovery activates deferred MCP tools and resource reads preserve images",
  timeout,
  async () => {
    let calls = 0,
      connections = 0;
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      if (request.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (request.method === "initialize") {
        connections++;
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "catalog", version: "1" },
        };
      }
      if (request.method === "tools/list")
        result = {
          tools: [
            {
              name: "list_items",
              description: "List catalog items",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      if (request.method === "tools/call") {
        calls++;
        result = {
          content: [{ type: "text", text: "Listed items" }],
          structuredContent: { items: ["one"] },
        };
      }
      if (request.method === "resources/list")
        result = { resources: [{ uri: "catalog://image", name: "Image" }], nextCursor: "next" };
      if (request.method === "resources/read")
        result = { contents: [{ uri: "catalog://image", mimeType: "image/png", blob: "YWJj" }] };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const f = await fixture();
    try {
      f.pi.saveMcpServer("catalog", {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        exposure: "deferred",
      });
      f.faux.setResponses([
        call("tool_search", { query: "catalog list items" }),
        call("mcp__catalog__list_items", {}),
        fauxAssistantMessage("Catalog read."),
        call("mcp__catalog__list_items", {}),
        call("list_mcp_resources", { server: "catalog" }),
        call("read_mcp_resource", { server: "catalog", uri: "catalog://image" }),
        fauxAssistantMessage("Resource read."),
      ]);
      assert.equal((await f.run("Discover the catalog")).status, "completed");
      assert.equal(calls, 1);
      const conversation = await f.sessions.get(f.conversationId);
      const agent = await f.supervisor.harness.snapshot(AgentDoc, conversation.id, ctx);
      assert.ok(Array.isArray(agent!.tools) && agent!.tools.includes("mcp__catalog__list_items"));
      assert.equal(
        (await f.run("Use the activated tool and read the resource")).status,
        "completed",
      );
      assert.equal(calls, 2);
      assert.equal(connections, 1, "Responses share the same MCP connection");
      const history = JSON.stringify(await f.sessions.history(f.conversationId));
      assert.match(history, /"nextCursor":"next"/);
      assert.match(history, /"mimeType":"image\/png"/);
      assert.match(history, /"data":"YWJj"/);
      assert.equal(f.permissions.list().length, 0);
    } finally {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "native compaction records spend in its conversation without creating a child agent",
  timeout,
  async () => {
    const f = await fixture({
      settings: { compaction: { enabled: false, keepRecentTokens: 100 } },
    });
    try {
      const conversation = await f.sessions.get(f.conversationId);
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: "Original source and unresolved interpretation. ".repeat(400),
              timestamp: Date.now(),
            },
          ],
        });
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [
            { role: "user", content: "Recent question. ".repeat(100), timestamp: Date.now() },
          ],
        });
      }, ctx);
      f.faux.setResponses([fauxAssistantMessage("Source retained; interpretation unresolved.")]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "", { kind: "compaction" });
      const run = await done;
      assert.equal(run.status, "completed", run.error);
      const children = await f.supervisor.harness.commit(
        (tx) => tx.scanConversations({ ownerConversationId: conversation.id }, 100),
        ctx,
      );
      assert.equal(children.items.length, 0);
      assert.ok(
        (await f.sessions.history(f.conversationId)).some((e) => e.kind === "pi.compaction"),
      );
      const usage = await f.supervisor.harness.snapshot(UsageDoc, conversation.id, ctx);
      const native = Object.values(usage!.models).reduce(
        (sum, model) => sum + model.totalTokens,
        0,
      );
      assert.ok(native > 0);
      assert.equal(run.usage!.tokens.total, native);
      assert.equal(
        Object.values((await f.supervisor.harness.usage(ctx)).models).reduce(
          (sum, model) => sum + model.totalTokens,
          0,
        ),
        native,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "native MCP sign-in honors configured scopes, resumes discovery and persists credentials",
  timeout,
  async () => {
    let address = "",
      authenticated = false,
      toolCalls = 0;
    const server = createServer(async (req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ resource: address + "/mcp", authorization_servers: [address] }));
        return;
      }
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: address,
            authorization_endpoint: address + "/authorize",
            token_endpoint: address + "/token",
            registration_endpoint: address + "/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.url === "/register") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ...JSON.parse(raw),
            client_id: "scientist-client",
            token_endpoint_auth_method: "none",
          }),
        );
        return;
      }
      if (req.url === "/token") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token: "local-test-token",
            token_type: "Bearer",
            scope: "samples:read",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (req.url !== "/mcp" || req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (req.headers.authorization !== "Bearer local-test-token") {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${address}/.well-known/oauth-protected-resource"`,
          })
          .end();
        return;
      }
      authenticated = true;
      const request = JSON.parse(raw);
      if (request.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (request.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "secured", version: "1" },
        };
      if (request.method === "tools/list")
        result = {
          tools: [
            {
              name: "read_samples",
              description: "Read sample metadata",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      if (request.method === "tools/call") {
        toolCalls++;
        result = { content: [{ type: "text", text: "Sample metadata" }] };
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const f = await fixture();
    try {
      f.pi.saveMcpServer("secured", {
        url: address + "/mcp",
        exposure: "direct",
        oauth: { scope: "samples:read" },
      });
      const redirected = deferred<string>(),
        question = deferred<AgentQuestion>();
      const unsubscribe = f.events.subscribe((event) => {
        if (event.type === "question") question.resolve(event.question);
        if (event.type === "agent-run")
          for (const notice of event.run.notices ?? [])
            if (notice.text.startsWith("Sign in to secured: "))
              redirected.resolve(notice.text.slice("Sign in to secured: ".length));
      });
      f.faux.setResponses([
        call("ask_user", { question: "Which independent unit?", allowFreeform: true }),
        call("mcp__secured__read_samples", {}),
        fauxAssistantMessage("Metadata retrieved."),
      ]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "Connect to the sample service");
      const url = new URL(await redirected.promise);
      assert.equal(url.searchParams.get("scope"), "samples:read");
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "local-code");
      assert.equal((await fetch(callback)).status, 200);
      const native = await f.sessions.get(f.conversationId);
      for (let i = 0; i < 100; i++) {
        const agent = await f.supervisor.harness.snapshot(AgentDoc, native.id, ctx);
        if (Array.isArray(agent?.tools) && agent.tools.includes("mcp__secured__read_samples"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(authenticated);
      const agent = await f.supervisor.harness.snapshot(AgentDoc, native.id, ctx);
      assert.ok(Array.isArray(agent?.tools) && agent.tools.includes("mcp__secured__read_samples"));
      f.supervisor.dialogs.answer((await question.promise).id, "Donor");
      assert.equal((await done).status, "completed");
      assert.equal(toolCalls, 1);
      unsubscribe();
      f.faux.setResponses([
        call("mcp__secured__read_samples", {}),
        fauxAssistantMessage("Credentials reused."),
      ]);
      const next = await f.run("Read the metadata again");
      assert.equal(next.status, "completed");
      assert.equal(toolCalls, 2);
      assert.ok(!next.notices?.some((notice) => notice.text.startsWith("Sign in to")));
    } finally {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "MCP names stay unique and bounded while direct and code-mode calls reach the original tools",
  timeout,
  async () => {
    const remote = [
      "read-file",
      "read_file",
      "read_" + "source_metadata_".repeat(8) + "a",
      "read_" + "source_metadata_".repeat(8) + "b",
    ];
    const called: string[] = [],
      approved: string[] = [];
    let reversed = false;
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      if (request.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (request.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "metadata", version: "1" },
        };
      if (request.method === "tools/list")
        result = {
          tools: (reversed ? [...remote].reverse() : remote).map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        };
      if (request.method === "tools/call") {
        called.push(request.params.name);
        result = { content: [{ type: "text", text: request.params.name }] };
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const f = await fixture();
    try {
      f.pi.saveMcpServer("sample-metadata", {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        exposure: "direct",
      });
      const question = deferred<AgentQuestion>();
      const unsubscribe = f.events.subscribe((event) => {
        if (event.type === "question") question.resolve(event.question);
        if (event.type === "permission") {
          approved.push(event.request.tool);
          f.permissions.decide(event.request.id, true);
        }
      });
      f.faux.setResponses([call("ask_user", { question: "Which sample?" })]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "Inspect sample metadata");
      const waiting = await question.promise;
      const registrations = getCurrentTools(f.requests[0].messages).filter((tool) =>
        tool.name.startsWith("mcp__"),
      );
      assert.equal(registrations.length, remote.length);
      const names = remote.map(
        (raw) => registrations.find((tool) => tool.description === raw)!.name,
      );
      assert.equal(new Set(names).size, remote.length);
      for (const name of names) {
        assert.ok(name.length <= 64);
        assert.match(name, /^[A-Za-z0-9_]+$/);
      }
      f.faux.setResponses([
        call(names[0], {}),
        call(names[1], {}),
        call("codemode", {
          code: `for (const name of ${JSON.stringify(names.slice(2))}) text(await tools[name]({}));`,
        }),
        fauxAssistantMessage("All original tools called."),
      ]);
      f.supervisor.dialogs.answer(waiting.id, "Donor");
      const completed = await done;
      assert.equal(completed.status, "completed", completed.error);
      assert.deepEqual(called, remote);
      assert.deepEqual(approved, names);
      reversed = true;
      f.faux.setResponses([
        call(names[0], {}),
        call(names[1], {}),
        fauxAssistantMessage("Names survived reordered discovery."),
      ]);
      const next = await f.run("Inspect again");
      assert.equal(next.status, "completed", next.error);
      assert.deepEqual(called, [...remote, ...remote.slice(0, 2)]);
      const nextTools = getCurrentTools(f.requests.at(-3)!.messages);
      assert.deepEqual(
        remote.map((raw) => nextTools.find((tool) => tool.description === raw)!.name),
        names,
      );
      unsubscribe();
    } finally {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "shared MCP calls keep approvals and cancellation scoped to their own conversation",
  timeout,
  async () => {
    const slow = deferred();
    let connections = 0;
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === "initialize") {
        connections++;
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "shared", version: "1" },
        };
      }
      if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "write",
              description: "Write a selected item",
              inputSchema: {
                type: "object",
                properties: { item: { type: "string" } },
                required: ["item"],
              },
            },
          ],
        };
      if (message.method === "tools/call") {
        if (message.params.arguments.item === "slow") {
          slow.resolve();
          return;
        }
        result = { content: [{ type: "text", text: "Item written" }] };
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const f = await fixture();
    const approvals: { runId: string; conversationId?: string }[] = [];
    const detach = f.events.subscribe((event) => {
      if (event.type === "permission") {
        approvals.push({
          runId: event.request.runId,
          conversationId: event.request.conversationId,
        });
        f.permissions.decide(event.request.id, true);
      }
    });
    try {
      f.pi.saveMcpServer("shared", {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        exposure: "direct",
      });
      f.faux.setResponses([call("mcp__shared__write", { item: "slow" })]);
      const first = await f.supervisor.start(f.conversationId, "Start the slow write");
      await slow.promise;
      const other = f.context.createConversation("Other");
      f.faux.setResponses([
        call("mcp__shared__write", { item: "quick" }),
        fauxAssistantMessage("Written"),
      ]);
      const done = f.finished();
      const second = await f.supervisor.start(other.id, "Write the other item");
      assert.equal((await done).id, second.id);
      assert.equal(f.supervisor.isActive(f.conversationId), true);
      const cancelled = f.finished();
      await f.supervisor.cancel(first.id);
      assert.equal((await cancelled).status, "cancelled");
      f.faux.setResponses([
        call("mcp__shared__write", { item: "again" }),
        fauxAssistantMessage("Written again"),
      ]);
      const completed = f.finished();
      const third = await f.supervisor.start(other.id, "Write once more");
      assert.equal((await completed).status, "completed");
      assert.equal(connections, 1, "Stopping one conversation preserves the shared transport");
      assert.deepEqual(approvals, [
        { runId: first.id, conversationId: f.conversationId },
        { runId: second.id, conversationId: other.id },
        { runId: third.id, conversationId: other.id },
      ]);
    } finally {
      detach();
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("a failed shared MCP connection can reconnect on the next response", timeout, async () => {
  let available = false,
    connections = 0,
    calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (!available) {
      res.writeHead(503).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      connections++;
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "retry", version: "1" },
      };
    }
    if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "read",
            description: "Read an item",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    if (message.method === "tools/call") {
      calls++;
      result = { content: [{ type: "text", text: "Read" }] };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture();
  try {
    f.pi.saveMcpServer("retry", {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      exposure: "direct",
    });
    f.faux.setResponses([fauxAssistantMessage("Connection unavailable")]);
    assert.equal((await f.run("Check connection")).status, "completed");
    available = true;
    f.faux.setResponses([call("mcp__retry__read", {}), fauxAssistantMessage("Read successfully")]);
    assert.equal((await f.run("Try again")).status, "completed");
    assert.equal(connections, 1);
    assert.equal(calls, 1);
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
