import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, contentText } from "@earendil-works/pi-ai";
import type { AgentQuestion, AgentSettings } from "@biologue/protocol";
import { fixture, deferred } from "./helpers/pi-fixture.ts";
import { Attachments } from "../src/attachments.ts";
import { ProviderAuth } from "../src/provider-auth.ts";
import type { PiAdapter } from "../src/pi.ts";
import { ConversationSessions } from "../src/conversation-sessions.ts";

const timeout = { timeout: 30_000 };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test(
  "native forks rebuild input identity and attachments from the selected prefix",
  timeout,
  async () => {
    const f = await fixture();
    let reopened: ConversationSessions | undefined;
    try {
      const attachment = { id: "image", name: "observations.png", mimeType: "image/png", size: 12 };
      const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
      f.faux.setResponses([fauxAssistantMessage("The observation remains unverified.")]);
      const finished = f.finished();
      await f.supervisor.start(f.conversationId, "Original observation", {
        attachments: [attachment],
        prepared: { text: "Original observation", images: [image] },
      });
      assert.equal((await finished).status, "completed");
      const originalMessages = (await f.sessions.page(f.conversationId)).items;
      const original = originalMessages[0];
      await f.sessions.accept(f.conversationId, "Unsent parent correction", "parent-run");
      const child = f.context.createConversation("Native branch");
      await f.sessions.fork(f.conversationId, child.id, original.entryId);
      f.store.db.exec(
        "DELETE FROM chat_messages; DELETE FROM records WHERE kind IN ('durable-display', 'durable-index');",
      );
      f.sessions.unbind();
      reopened = new ConversationSessions(f.store, f.events);
      reopened.bind(f.supervisor.harness);
      const branch = (await reopened.page(child.id)).items;
      assert.equal(branch.length, 1);
      assert.equal(branch[0].id, original.id);
      assert.equal(branch[0].createdAt, original.createdAt);
      assert.equal(branch[0].conversationId, child.id);
      assert.deepEqual(branch[0].attachments, [attachment]);
      assert.deepEqual(reopened.content(branch[0]).images, []);
      assert.ok(JSON.stringify(await reopened.history(child.id)).includes(image.data));
      assert.equal((await reopened.pending(child.id)).length, 0);
      assert.equal((await reopened.pending(f.conversationId)).length, 1);
      const rebuilt = (await reopened.page(f.conversationId)).items;
      assert.equal(
        rebuilt[1].runId,
        originalMessages[1].runId,
        "Finished assistant work must retain its run association without display caches",
      );
    } finally {
      reopened?.unbind();
      await f.close();
    }
  },
);

test(
  "native code mode preserves approval and exact shared-kernel execution provenance",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const document = f.documents.edit("analysis.py", "result = 42\nprint(result)", 1);
      f.faux.setResponses([
        call("codemode", {
          code: `text(await tools.execute_code(${JSON.stringify({ language: "python", code: document.content, document: { path: document.path, version: document.version }, reason: "Check result" })}));`,
        }),
        fauxAssistantMessage("Observed output."),
      ]);
      const requested = f.requested(),
        done = f.finished();
      await f.supervisor.start(f.conversationId, "Run through code mode.");
      const request = await requested;
      assert.equal(f.calls.length, 0);
      assert.equal(request.tool, "execute_code");
      f.permissions.decide(request.id, true);
      const result = await done;
      assert.equal(result.status, "completed", result.error);
      assert.deepEqual(f.calls, [document.content]);
      const record = f.execution.get(f.execution.repository.list().items[0].id)!;
      assert.deepEqual(record.document, { path: document.path, version: document.version });
      assert.equal(record.toolCallId, request.toolCallId);
      assert.ok(result.usage);
      assert.equal(result.usage.context?.contextWindow, 100_000);
      assert.ok(result.usage.context!.tokens! > 0);
      assert.equal(result.usage.subscription, false);
      const catalog = JSON.stringify(f.requests[0]);
      assert.doesNotMatch(catalog, /"name":"(?:bash|powershell|write)"/);
    } finally {
      await f.close();
    }
  },
);

test(
  "native ask_user waits for a browser answer, records it, and releases on cancellation",
  timeout,
  async () => {
    const f = await fixture();
    try {
      for (const cancel of [false, true]) {
        const question = deferred<AgentQuestion>();
        const unsubscribe = f.events.subscribe((event) => {
          if (event.type === "question") question.resolve(event.question);
        });
        f.faux.setResponses([
          call("ask_user", {
            question: "Which comparison?",
            options: [{ title: "Matched controls" }, { title: "All samples" }],
            allowFreeform: false,
          }),
          fauxAssistantMessage("Use the selected comparison."),
        ]);
        const done = f.finished();
        const run = await f.supervisor.start(f.conversationId, "Ask about the comparison.");
        const pending = await question.promise;
        assert.equal(pending.runId, run.id);
        assert.equal(pending.kind, "select");
        if (cancel) await f.supervisor.cancel(run.id);
        else f.supervisor.dialogs.answer(pending.id, pending.options![0]);
        assert.equal((await done).status, cancel ? "cancelled" : "completed");
        assert.equal(f.supervisor.dialogs.list().length, 0);
        if (!cancel) assert.ok(f.store.get("question-answer", pending.id));
        unsubscribe();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "permission modes use the active run despite a missing display cache and remain auditable",
  timeout,
  async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    try {
      f.store.put = (kind, id, value) => {
        if (kind === "run") throw new Error("Run display cache unavailable");
        return put(kind, id, value);
      };
      for (const mode of ["plan", "edit", "auto"] as const) {
        f.context.updateConversation(f.conversationId, {
          settings: {
            provider: f.options.provider,
            model: f.options.modelId,
            thinking: "off",
            mode,
          },
        });
        f.faux.setResponses([
          call("execute_code", {
            language: "python",
            code: `print('${mode}')`,
            reason: "Test mode",
          }),
          fauxAssistantMessage("Done."),
        ]);
        const done = f.finished();
        const requested = mode === "edit" ? f.requested() : undefined;
        await f.supervisor.start(f.conversationId, `Use ${mode} mode.`);
        if (requested) f.permissions.decide((await requested).id, false);
        const run = await done;
        assert.equal(run.settings?.mode, mode);
      }
      assert.deepEqual(f.calls, ["print('auto')"]);
      assert.ok(
        f.store
          .list<{ feedback?: string }>("permission")
          .some((item) => item.feedback === "Allowed by auto mode."),
      );
    } finally {
      f.store.put = put;
      await f.close();
    }
  },
);

test(
  "attachment snapshots retain unsaved source and survive conversation branching",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const attachments = new Attachments(f.store, f.documents);
      f.documents.edit("analysis.py", "unsaved = 7", 1);
      const file = attachments.create({ path: "analysis.py" });
      f.documents.edit("analysis.py", "later = 8", 2);
      assert.throws(() => attachments.create({ path: "../outside" }));
      assert.throws(() =>
        attachments.create({
          name: "bad.png",
          mimeType: "image/png",
          data: Buffer.from("not an image").toString("base64"),
        }),
      );
      const prepared = attachments.prepare("Review this file.", [file.id]);
      assert.match(prepared.text, /unsaved = 7/);
      assert.doesNotMatch(prepared.text, /later = 8/);
      f.faux.setResponses([fauxAssistantMessage("Read the attached snapshot.")]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "Review this file.", {
        prepared,
        attachments: prepared.attachments,
      });
      assert.equal((await done).status, "completed");
      const original = await f.sessions.export(f.conversationId);
      assert.equal(original[0].attachments?.[0].document?.version, 2);
      const leaf = await f.sessions.leaf(f.conversationId);
      const child = f.context.createConversation("Branch");
      await f.sessions.fork(f.conversationId, child.id, original[0].entryId);
      assert.equal(
        await f.sessions.leaf(f.conversationId),
        leaf,
        "Branching never rewinds the source session",
      );
      assert.equal((await f.sessions.export(child.id)).length, 1);
      assert.equal((await f.sessions.export(child.id))[0].attachments?.[0].id, file.id);
      assert.ok((await f.sessions.search("attached snapshot")).includes(f.conversationId));
    } finally {
      await f.close();
    }
  },
);

test(
  "queued prompt templates can be restored for editing without losing or duplicating receipts",
  timeout,
  async () => {
    const f = await fixture();
    try {
      f.faux.setResponses([
        call("execute_code", { language: "python", code: "print(1)", reason: "Wait" }),
        fauxAssistantMessage("Finished."),
      ]);
      const requested = f.requested(),
        done = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Begin.");
      const permission = await requested;
      await f.supervisor.steer(run.id, "/review-analysis", "followUp");
      await f.supervisor.steer(run.id, "Change the comparison.", "steer");
      const removed = await f.supervisor.clearQueue(run.id);
      assert.deepEqual(
        removed.map((item) => item.text).sort(),
        ["/review-analysis", "Change the comparison."].sort(),
      );
      assert.equal((await f.sessions.pending(f.conversationId)).length, 0);
      f.permissions.decide(permission.id, false);
      assert.equal((await done).status, "completed");
      assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /Change the comparison/);
    } finally {
      await f.close();
    }
  },
);

test(
  "native MCP discovery and nested code-mode calls retain approval and expose connection status",
  timeout,
  async () => {
    let calls = 0;
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
      let result: unknown = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        };
      if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "write",
              description: "Write a test value",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        };
      if (message.method === "tools/call") {
        calls++;
        result = { content: [{ type: "text", text: "Stored" }] };
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const f = await fixture();
    try {
      const address = server.address() as { port: number };
      f.pi.saveMcpServer("test", { url: `http://127.0.0.1:${address.port}`, exposure: "codemode" });
      f.faux.setResponses([
        call("codemode", { code: "text(await tools.mcp__test__write({}));" }),
        fauxAssistantMessage("MCP call completed."),
      ]);
      const requested = f.requested(),
        done = f.finished();
      await f.supervisor.start(f.conversationId, "Use the MCP server.");
      const request = await requested;
      assert.equal(calls, 0);
      assert.equal(request.tool, "mcp__test__write");
      f.permissions.decide(request.id, true);
      assert.equal((await done).status, "completed");
      assert.equal(calls, 1);
      const status = await f.run("/mcp");
      assert.equal(status.status, "completed", status.error);
      assert.ok(status.notices?.some((item) => /test/.test(item.text)));
      assert.equal((await f.sessions.pending(f.conversationId)).length, 0);
    } finally {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "provider login sends only challenges to the browser and rejects stale answers",
  timeout,
  async () => {
    let credential = "";
    const prompted = deferred();
    const runtime = {
      getProvider: () => ({ auth: { apiKey: { login: true } } }),
      login: async (
        _provider: string,
        _type: string,
        options: { prompt: (value: object) => Promise<string> },
      ) => {
        const answer = options.prompt({ type: "secret", message: "API key" });
        prompted.resolve();
        credential = await answer;
      },
    };
    const auth = new ProviderAuth({ modelRuntime: async () => runtime } as unknown as PiAdapter);
    try {
      const flow = await auth.start("test", "api_key");
      await prompted.promise;
      const prompt = flow.prompt!;
      assert.throws(() => auth.respond(flow.id, "old-step", "abc"));
      assert.throws(() => auth.respond(flow.id, prompt.id, "!echo secret"));
      auth.respond(flow.id, prompt.id, "test-secret-value");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(credential, "test-secret-value");
      assert.equal(auth.get(flow.id).status, "complete");
      assert.doesNotMatch(JSON.stringify(auth.get(flow.id)), /test-secret-value/);
    } finally {
      auth.close();
    }
  },
);

test(
  "steering takes priority over follow-up while message identities stay attached to their own text",
  timeout,
  async () => {
    const f = await fixture();
    try {
      f.faux.setResponses([
        call("execute_code", {
          language: "python",
          code: "print(1)",
          reason: "Wait for a decision",
        }),
        fauxAssistantMessage("Responding to steering."),
        fauxAssistantMessage("Responding to follow-up."),
      ]);
      const requested = f.requested(),
        done = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Initial question.");
      const permission = await requested;
      await f.supervisor.steer(run.id, "Afterwards, review assumptions.", "followUp");
      await f.supervisor.steer(run.id, "First, correct the comparison.", "steer");
      f.permissions.decide(permission.id, false);
      assert.equal((await done).status, "completed");
      const requests = f.requests.map((request) =>
        request.messages
          .filter((message) => message.role === "user")
          .map((message) => contentText(message.content)),
      );
      assert.deepEqual(requests[1], ["Initial question.", "First, correct the comparison."]);
      assert.deepEqual(requests[2], [
        "Initial question.",
        "First, correct the comparison.",
        "Afterwards, review assumptions.",
      ]);
      const messages = (await f.sessions.export(f.conversationId)).filter(
        (message) => message.role === "user",
      );
      assert.equal(messages.find((message) => message.text.startsWith("First,"))?.queue, "steer");
      assert.equal(
        messages.find((message) => message.text.startsWith("Afterwards,"))?.queue,
        "followUp",
      );
      assert.ok(messages.every((message) => message.delivery === "delivered"));
      assert.equal((await f.sessions.pending(f.conversationId)).length, 0);
    } finally {
      await f.close();
    }
  },
);

test("native stdio MCP transports close when the response session ends", timeout, async () => {
  const f = await fixture();
  try {
    const script = join(f.root, "mcp-test.mjs"),
      closed = join(f.root, "mcp-closed");
    writeFileSync(
      script,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
process.on("exit", () => writeFileSync(${JSON.stringify(closed)}, "closed"));
process.on("SIGTERM", () => process.exit(0));
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stdio-test", version: "1" } } : m.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
    );
    f.pi.saveMcpServer("stdio", { command: process.execPath, args: [script] });
    const run = await f.run("/mcp");
    assert.equal(run.status, "completed", run.error);
    assert.ok(run.notices?.some((notice) => /stdio/.test(notice.text)));
    for (let attempt = 0; attempt < 30 && !existsSync(closed); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(closed), "The MCP subprocess exits before the session is discarded");
  } finally {
    await f.close();
  }
});

test(
  "native prompt arguments and skill contents reach durable model context while chat retains the command",
  timeout,
  async () => {
    const f = await fixture();
    try {
      mkdirSync(join(f.root, ".pi", "prompts"), { recursive: true });
      mkdirSync(join(f.root, ".pi", "skills", "units"), { recursive: true });
      writeFileSync(
        join(f.root, ".pi", "prompts", "compare.md"),
        "---\ndescription: Compare selected samples\n---\nCompare $1 against ${2:-matched controls}; retain $ARGUMENTS.",
      );
      writeFileSync(
        join(f.root, ".pi", "skills", "units", "SKILL.md"),
        "---\nname: units\ndescription: Verify the independent unit\n---\nTreat donor as the independent unit. Never equate wells with replicates.",
      );
      f.faux.setResponses([
        fauxAssistantMessage("Comparison recorded."),
        fauxAssistantMessage("The donor distinction is retained."),
      ]);
      assert.equal((await f.run('/compare "treated donors"')).status, "completed");
      assert.match(
        JSON.stringify(f.requests[0]),
        /Compare treated donors against matched controls/,
      );
      assert.equal((await f.run("/skill:units Check the design")).status, "completed");
      assert.match(JSON.stringify(f.requests.at(-1)), /Never equate wells with replicates/);
      assert.ok(
        (await f.sessions.page(f.conversationId)).items.some(
          (m) => m.text === '/compare "treated donors"',
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "Stop cancels MCP discovery before model admission and releases the conversation",
  timeout,
  async () => {
    const f = await fixture();
    const connected = deferred();
    const server = createServer((_request, _reply) => connected.resolve());
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      f.pi.saveMcpServer("hanging", {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
        exposure: "direct",
      });
      const done = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Read the connected tools.");
      await connected.promise;
      await f.supervisor.cancel(run.id);
      assert.equal((await done).status, "cancelled");
      assert.equal(f.supervisor.isActive(), false);
      assert.equal(f.faux.state.callCount, 0);
      assert.equal(f.calls.length, 0);
      assert.equal((await f.sessions.pending(f.conversationId)).length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  },
);
