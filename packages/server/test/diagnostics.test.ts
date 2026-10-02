import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentRun, Conversation } from "@biologue/protocol";
import {
  Diagnostics,
  diagnosticEvents,
  diagnosticIssues,
  diagnosticValue,
} from "../src/diagnostics.ts";
import { createApp } from "../src/app.ts";
import { PiAdapter } from "../src/pi.ts";
import { scriptedModel } from "./helpers/pi-fixture.ts";

const timeout = { timeout: 30_000 };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("diagnostics survive reopening, redact credentials, preserve usage and group recurring failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-diagnostics-"));
  const path = join(root, "diagnostics.sqlite");
  let diagnostics = new Diagnostics(path);
  try {
    const circular: Record<string, unknown> = { value: "valid" };
    circular.self = circular;
    for (const [runId, number] of [
      ["first", 12],
      ["second", 38],
    ] as const) {
      diagnostics.record({
        component: "tool",
        event: "tool.failed",
        level: "error",
        actionable: true,
        runId,
        error: new Error(`Failed reading /tmp/project-${number}/file.py:${number}:4`),
        data: {
          tool: "read",
          headers: { Authorization: "Bearer private-bearer" },
          clientSecret: "private-secret",
          url: "https://user:password@example.test/callback?access_token=private-query&code=private-code",
          usage: { tokens: { input: 21 }, estimatedInputTokens: 32, totalTokens: 41 },
          circular,
        },
      });
    }
    const withCause = new Error("access_token=private-error sk-private123456", {
      cause: new Error("password='private-password'"),
    });
    diagnostics.record({ component: "app", event: "failure", level: "error", error: withCause });
    const values = diagnostics.events().items;
    const text = JSON.stringify(values);
    assert.doesNotMatch(
      text,
      /private-bearer|private-secret|private-query|private-code|private-error|private123456|private-password|user:password/,
    );
    assert.match(text, /REDACTED/);
    assert.match(text, /CIRCULAR/);
    assert.deepEqual((values[0].data!.usage as { tokens: { input: number } }).tokens, {
      input: 21,
    });
    assert.equal(
      (values[0].data!.usage as { estimatedInputTokens: number }).estimatedInputTokens,
      32,
    );
    const issues = diagnostics.issues().items;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].occurrences, 2);
    assert.equal(issues[0].runs, 2);
    assert.equal(values[0].fingerprint, values[1].fingerprint);
    const session = diagnostics.sessionId;
    await diagnostics.close();
    diagnostics = new Diagnostics(path);
    assert.notEqual(diagnostics.sessionId, session);
    assert.equal(diagnostics.events().items.length, 3);
    assert.equal(diagnostics.events({ runId: "second" }).items.length, 1);
    const page = diagnostics.events({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.next, page.items[0].id);
    assert.equal(diagnostics.events({ after: page.next }).items.length, 2);
  } finally {
    await diagnostics.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic retention, incident watermarks and metadata bounds are independent of canonical history", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-diagnostic-retention-"));
  const path = join(root, "diagnostics.sqlite");
  const d = new Diagnostics(path, { maxEvents: 3 });
  try {
    for (let i = 0; i < 6; i++)
      d.record({
        component: "app",
        event: `failure${i}`,
        level: "error",
        actionable: true,
        error: new Error(`failure ${String.fromCharCode(65 + i)}`),
      });
    const first = d.issues({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(d.issues({ after: first.next }).items.length, 4);
    const bounded = diagnosticValue({
      values: Array.from({ length: 1000 }, () => "x".repeat(100_000)),
    });
    assert.ok(JSON.stringify(bounded).length < 900_000);
    await d.close();
    const db = new DatabaseSync(path);
    try {
      assert.equal(diagnosticEvents(db).items.length, 3);
      assert.equal(diagnosticEvents(db).items[0].id, 4);
      assert.equal(diagnosticEvents(db, { after: 1 }).cursorGap, true);
      assert.equal(diagnosticEvents(db, { after: 4 }).cursorGap, false);
      assert.equal(diagnosticIssues(db, { after: 6 }).items.length, 0);
      assert.equal(diagnosticIssues(db, { after: 6 }).watermark, 6);
      db.exec("DELETE FROM diagnostic_events");
      assert.equal(diagnosticEvents(db, { after: 4 }).cursorGap, true);
      assert.equal(diagnosticEvents(db, { after: 6 }).cursorGap, false);
      assert.equal(diagnosticIssues(db).watermark, 6);
    } finally {
      db.close();
    }
  } finally {
    await d.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "HTTP failures retain request identity and stacks and repeated signals count as one execution",
  timeout,
  async () => {
    const f = await appFixture();
    const get = f.execution.get.bind(f.execution);
    try {
      f.execution.get = () => {
        throw new Error("Storage failed with Bearer private-access-token");
      };
      for (let i = 0; i < 2; i++) {
        const response = await f.app.inject({
          url: "/api/executions/12345678-1234-4123-8123-123456789012?access_token=private-query-token",
        });
        assert.equal(response.statusCode, 500);
      }
      const failures = f.diagnostics.events({ event: "request.failed" }).items;
      assert.equal(failures.length, 2);
      assert.notEqual(failures[0].requestId, failures[1].requestId);
      assert.ok(failures[0].error?.stack);
      assert.equal(f.diagnostics.issues().items[0].occurrences, 2);
      assert.doesNotMatch(JSON.stringify(failures), /private-access-token|private-query-token/);
      f.diagnostics.record({
        component: "kernel",
        event: "execution.exception",
        level: "error",
        actionable: true,
        executionId: "one-execution",
        error: new Error("Some execution failure"),
      });
      f.diagnostics.record({
        component: "kernel",
        event: "execution.failed",
        level: "error",
        actionable: true,
        executionId: "one-execution",
        error: new Error("Some execution failure"),
      });
      const group = f.diagnostics
        .issues()
        .items.find((i) => i.sample.executionId === "one-execution")!;
      assert.equal(group.occurrences, 1);
      assert.equal(group.signals, 2);
    } finally {
      f.execution.get = get;
      await f.close();
    }
  },
);

for (const mode of ["exception", "rejection"])
  test(
    `fatal ${mode} is durably logged without preventing process termination`,
    timeout,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "biologue-diagnostic-crash-"));
      const path = join(root, "diagnostics.sqlite");
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "packages/server/test/helpers/diagnostic-crash-worker.ts",
            path,
            mode,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
        assert.equal(result.status, 1, result.stderr);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const event = diagnosticEvents(db, { event: "process.fatal" }).items[0];
          assert.equal(event.error?.message, "Fatal test failure");
          assert.equal(event.actionable, true);
          assert.equal(
            event.data?.origin,
            mode === "exception" ? "uncaughtException" : "unhandledRejection",
          );
        } finally {
          db.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

async function appFixture(kernelFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "biologue-diagnostic-agent-"));
  writeFileSync(join(root, "analysis.py"), "x = 1");
  const stateDir = join(root, ".biologue");
  const model = await scriptedModel();
  const pi = new PiAdapter({ project: root, stateDir, ...model.options });
  pi.conversationTitle = async () => "";
  const calls: string[] = [];
  const f = await createApp({
    project: root,
    stateDir,
    repository: process.cwd(),
    pi,
    kernel: {
      execute: async (_language, code, output, started) => {
        started({ sessionId: "shared", kernelId: "kernel", kernelGeneration: "generation" });
        calls.push(code);
        if (kernelFailure) throw new Error("NameError: missing_value is not defined");
        output({ kind: "stream", text: "PAYLOAD_DO_NOT_LOG" });
      },
      interrupt: async () => {},
    },
  });
  const conversationId = f.store.list<Conversation>("conversation")[0].id;
  f.context.updateConversation(conversationId, {
    settings: {
      provider: model.options.provider,
      model: model.options.modelId,
      thinking: "off",
      mode: "auto",
    },
  });
  const finished = () =>
    new Promise<AgentRun>((resolve) => {
      const off = f.events.subscribe((e) => {
        if (e.type === "agent-run" && e.run.finishedAt) {
          off();
          resolve(e.run);
        }
      });
    });
  return {
    ...f,
    ...model,
    pi,
    calls,
    root,
    stateDir,
    conversationId,
    finished,
    close: async () => {
      await f.app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "real Durable runs log model, nested tool and kernel correlations and expose diagnostic evidence",
  timeout,
  async () => {
    const f = await appFixture();
    try {
      f.faux.setResponses([
        call("codemode", {
          code: 'text(await tools.execute_code({language:"python",code:"print(123)",reason:"test"}));',
        }),
        call("read_diagnostics", { kind: "events", limit: 5 }),
        fauxAssistantMessage("Complete"),
      ]);
      const done = f.finished();
      const run = await f.supervisor.start(f.conversationId, "PROMPT_DO_NOT_LOG");
      assert.equal((await done).status, "completed");
      assert.deepEqual(f.calls, ["print(123)"]);
      const events = f.diagnostics.events({ runId: run.id, limit: 1000 }).items;
      for (const name of [
        "run.started",
        "request.started",
        "request.finished",
        "tool.started",
        "tool.finished",
        "execution.dispatched",
        "execution.succeeded",
        "run.finished",
      ])
        assert.ok(
          events.some((e) => e.event === name),
          name,
        );
      const nested = events.find(
        (e) => e.event === "tool.started" && e.data?.tool === "execute_code",
      )!;
      assert.ok(nested.taskId);
      assert.match(nested.toolCallId!, /\/1$/);
      assert.ok(nested.data?.parentCallId);
      const execution = events.find((e) => e.event === "execution.succeeded")!;
      assert.equal(execution.toolCallId, nested.toolCallId);
      assert.ok(execution.executionId);
      assert.equal(events.find((e) => e.event === "execution.outputs")?.data?.count, 1);
      assert.ok(events.some((e) => e.event === "permission.resolved"));
      assert.ok(
        events.some((e) => e.event === "request.finished" && Number(e.data?.durationMs) >= 0),
      );
      assert.ok(f.diagnostics.events({ component: "durable", event: "task.state" }).items.length);
      const exported = JSON.stringify(events);
      assert.doesNotMatch(exported, /PROMPT_DO_NOT_LOG|PAYLOAD_DO_NOT_LOG|print\(123\)/);
      const bundle = await f.app.inject({ url: `/api/diagnostics/bundle?runId=${run.id}` });
      assert.equal(bundle.statusCode, 200, bundle.body);
      assert.equal(bundle.json().executions[0].id, execution.executionId);
      assert.match(bundle.json().executions[0].sourceUrl, /executions/);
      assert.doesNotMatch(bundle.body, /PROMPT_DO_NOT_LOG|PAYLOAD_DO_NOT_LOG|print\(123\)/);
      const page = await f.app.inject({ url: `/api/diagnostics/events?runId=${run.id}&limit=2` });
      assert.equal(page.statusCode, 200);
      assert.equal(page.json().items.length, 2);
      assert.ok(page.json().next);
      const invalid = await f.app.inject({ url: "/api/diagnostics/events?limit=9999" });
      assert.equal(invalid.statusCode, 400);
      assert.equal((await f.app.inject({ url: "/api/diagnostics/live" })).statusCode, 200);
      assert.equal(f.diagnostics.issues().items.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "auxiliary title model calls retain request identity and usage without transcript payloads",
  timeout,
  async () => {
    const f = await appFixture();
    try {
      f.faux.setResponses([
        fauxAssistantMessage("A useful conversation title"),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      ]);
      const messages = [
        {
          id: "title-input",
          conversationId: f.conversationId,
          role: "user" as const,
          text: "TITLE_TRANSCRIPT_DO_NOT_LOG",
          createdAt: new Date().toISOString(),
        },
      ];
      const generate = () => PiAdapter.prototype.conversationTitle.call(f.pi, messages);
      assert.equal(await generate(), "A useful conversation title");
      assert.equal(await generate(), "");
      const events = f.diagnostics.events({ component: "model" }).items;
      assert.equal(events.length, 4);
      assert.equal(events[0].requestId, events[1].requestId);
      assert.notEqual(events[0].requestId, events[2].requestId);
      assert.equal(events[1].data?.kind, "title");
      assert.ok(events[1].data?.usage);
      assert.equal(events[3].level, "warning");
      assert.equal(events[3].error?.message, "503 service unavailable");
      assert.doesNotMatch(JSON.stringify(events), /TITLE_TRANSCRIPT_DO_NOT_LOG/);
    } finally {
      await f.close();
    }
  },
);

test(
  "agent code failures become candidates, human code failures do not, and offline exports survive shutdown",
  timeout,
  async () => {
    const f = await appFixture(true);
    try {
      f.faux.setResponses([
        call("execute_code", { language: "python", code: "missing_value", reason: "test" }),
        fauxAssistantMessage("Failed"),
      ]);
      const done = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Run it");
      await done;
      const failures = f.diagnostics.issues().items;
      assert.ok(
        failures.some((i) => i.sample.event === "execution.failed" && i.sample.runId === run.id),
      );
      const before = failures.length;
      const human = f.execution.submit({
        language: "python",
        actor: "human",
        code: "missing_value",
      });
      await f.execution.wait(human.id);
      assert.equal(f.diagnostics.issues().items.length, before);
      assert.ok(f.diagnostics.events({ executionId: human.id, level: "error" }).items.length);
      const id = failures[0].latestEventId;
      assert.equal(
        (await f.app.inject({ url: `/api/diagnostics/bundle?eventId=${id}` })).statusCode,
        200,
      );
      await f.app.close();
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/diagnostics.ts", "issues", "--state-dir", f.stateDir],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(cli.status, 0, cli.stderr);
      assert.ok(JSON.parse(cli.stdout).items.length);
      const db = new DatabaseSync(join(f.stateDir, "diagnostics.sqlite"), { readOnly: true });
      try {
        assert.ok(diagnosticIssues(db).items.length);
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "denied execution is observable without becoming an automatic issue candidate",
  timeout,
  async () => {
    const f = await appFixture();
    try {
      f.context.updateConversation(f.conversationId, {
        settings: {
          provider: f.options.provider,
          model: f.options.modelId,
          thinking: "off",
          mode: "ask",
        },
      });
      const off = f.events.subscribe((e) => {
        if (e.type === "permission") f.permissions.decide(e.request.id, false);
      });
      f.faux.setResponses([
        call("execute_code", { language: "r", code: "x <- 1", reason: "test" }),
        fauxAssistantMessage("Declined"),
      ]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "Propose code");
      await done;
      off();
      assert.equal(f.calls.length, 0);
      assert.equal(f.diagnostics.issues().items.length, 0);
      assert.ok(f.diagnostics.events({ event: "tool.failed" }).items.length);
      f.faux.setResponses([
        call("codemode", {
          code: 'text(await tools.execute_code({language:"r",code:"x <- 1",reason:"test"}));',
        }),
        fauxAssistantMessage("Declined"),
      ]);
      const nestedDone = f.finished();
      const denyNested = f.events.subscribe((e) => {
        if (e.type === "permission") f.permissions.decide(e.request.id, false);
      });
      await f.supervisor.start(f.conversationId, "Propose nested code");
      await nestedDone;
      denyNested();
      assert.equal(f.calls.length, 0);
      assert.equal(f.diagnostics.issues().items.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "diagnostic write failures cannot stop successful agent and kernel work",
  timeout,
  async () => {
    const f = await appFixture();
    const error = console.error;
    try {
      console.error = () => {};
      const broken = new DatabaseSync(join(f.stateDir, "diagnostics.sqlite"));
      broken.exec("DROP TABLE diagnostic_events");
      broken.close();
      f.faux.setResponses([
        call("execute_code", { language: "python", code: "x=1", reason: "test" }),
        fauxAssistantMessage("Done"),
      ]);
      const done = f.finished();
      await f.supervisor.start(f.conversationId, "Run");
      assert.equal((await done).status, "completed");
      assert.deepEqual(f.calls, ["x=1"]);
      assert.ok(f.diagnostics.status().dropped > 0);
      assert.equal(
        (await f.app.inject({ url: "/api/diagnostics/status" })).json().available,
        false,
      );
    } finally {
      await f.close();
      console.error = error;
    }
  },
);

test("an unavailable diagnostic file is reported without throwing from the collector", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-diagnostic-failure-"));
  const path = join(root, "directory.sqlite");
  mkdirSync(path);
  const previous = console.error;
  let d: Diagnostics | undefined;
  try {
    console.error = () => {};
    assert.doesNotThrow(() => {
      d = new Diagnostics(path);
    });
    assert.equal(d!.status().available, false);
    assert.doesNotThrow(() => d!.record({ component: "app", event: "failed" }));
    assert.ok(d!.status().dropped >= 2);
  } finally {
    await d?.close();
    console.error = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
