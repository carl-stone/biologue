import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
  type Context,
} from "@earendil-works/pi-ai";
import type { Execution, Message } from "@carl/protocol";
import { collaboratorPrompt, deferred, fixture } from "./helpers/pi-fixture.ts";
import { scientificRetention } from "../src/pi.ts";
import { ConversationSessions } from "../src/conversation-sessions.ts";
import { digest } from "../src/documents.ts";
import { workspaceTools } from "../src/workspace-tools.ts";

const timeout = { timeout: 20_000 };
const textOf = (request: Context) => JSON.stringify(request);
const toolResults = (request: Context) =>
  request.messages.filter((message) => message.role === "toolResult");
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

// All of these use PiAdapter.create -> createAgentSession; only the provider and kernel are scripted.
test(
  "AgentSession preserves approval, unsaved source identity, streaming and canonical history",
  timeout,
  async () => {
    const f = await fixture();
    try {
      assert.equal(f.options.settingsManager.getCacheWarmingMode(), "off");
      const doc = f.documents.edit("analysis.py", "x = 2\nprint(x)", 1);
      f.faux.setResponses([
        call("execute_code", {
          language: "python",
          code: doc.content,
          document: { path: doc.path, version: doc.version },
          reason: "Check the existing object",
        }),
        fauxAssistantMessage("Observed test output; interpretation remains open."),
      ]);
      const requested = f.requested();
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Inspect the value.");
      const request = await requested;
      assert.equal(f.calls.length, 0);
      assert.equal(request.code, doc.content);
      f.permissions.decide(request.id, true);
      assert.equal((await finished).status, "completed");
      assert.deepEqual(f.calls, [doc.content]);
      const record = f.execution.get(f.execution.repository.list().items[0].id)!;
      assert.equal(record.codeHash, digest(doc.content));
      assert.deepEqual(record.document, { path: doc.path, version: doc.version });
      assert.equal(record.runId, run.id);
      assert.equal(record.toolCallId, request.toolCallId);
      assert.equal(record.kernelId, "kernel");
      assert.equal(readFileSync(join(f.root, "analysis.py"), "utf8"), "x = 1");
      assert.ok(f.observed.some((event) => event.type === "agent-delta"));
      assert.deepEqual(
        f.sessions.page(f.conversationId, 200).items.map((message) => message.delivery),
        ["delivered", "delivered"],
      );
      assert.equal(f.sessions.page(f.conversationId, 200).items[1].runId, run.id);
      assert.ok(existsSync(f.sessions.get(f.conversationId).getSessionFile()!));
      assert.equal(f.store.list("transcript").length, 0);
      assert.equal(f.store.list("message").length, 0);
      assert.ok(f.store.list("run-request").length >= 2);
    } finally {
      await f.close();
    }
  },
);

test("declined and cancelled Pi tool requests cannot execute", timeout, async () => {
  const f = await fixture();
  try {
    for (const cancel of [false, true]) {
      f.faux.setResponses([
        call("execute_code", {
          language: "python",
          code: "must_not_run()",
          reason: "A proposed action",
        }),
        fauxAssistantMessage("Permission was not granted."),
      ]);
      const requested = f.requested();
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Consider an action.");
      const request = await requested;
      if (cancel) await f.supervisor.cancel(run.id);
      else f.permissions.decide(request.id, false);
      assert.equal((await finished).status, cancel ? "cancelled" : "completed");
      assert.equal(f.calls.length, 0);
      assert.equal(f.permissions.list().length, 0);
    }
  } finally {
    await f.close();
  }
});

test("document identity is checked again after the approval wait", timeout, async () => {
  const f = await fixture();
  try {
    const document = f.documents.open("analysis.py");
    f.faux.setResponses([
      call("execute_code", {
        language: "python",
        code: document.content,
        document: { path: document.path, version: document.version },
        reason: "Run the current script",
      }),
      fauxAssistantMessage("The source changed while approval was pending."),
    ]);
    const requested = f.requested(),
      finished = f.finished();
    f.supervisor.start(f.conversationId, "Run the script.");
    const permission = await requested;
    f.documents.edit(document.path, "x = 99", document.version);
    f.permissions.decide(permission.id, true);
    await finished;
    const execution = f.execution.repository.list().items.at(-1)!;
    assert.equal(execution.status, "failed");
    assert.equal(execution.activitySequence, undefined);
    assert.equal(f.calls.length, 0);
    assert.equal(f.execution.outputs.count(execution.id), 0);
  } finally {
    await f.close();
  }
});

test(
  "a reopened session receives corrected scientific notes and the prior conversation",
  timeout,
  async () => {
    let f = await fixture();
    try {
      f.context.update("Function was not measured.", 0);
      f.faux.setResponses([fauxAssistantMessage("Which observation do you want to explain?")]);
      assert.equal((await f.run("The shape looks different.")).status, "completed");
      const before = f.sessions.page(f.conversationId, 200).items;
      const root = f.root;
      const sessionId = f.sessions.get(f.conversationId).getSessionId();
      await f.close(false);
      f = await fixture({ root });
      assert.equal(f.sessions.get(f.conversationId).getSessionId(), sessionId);
      assert.deepEqual(f.sessions.page(f.conversationId, 200).items, before);
      f.context.update(
        "Correction: function was measured separately. Shape and function are different observations.",
        1,
      );
      f.faux.setResponses([fauxAssistantMessage("The corrected notes are available.")]);
      const run = await f.run("Continue using the corrected context.");
      assert.equal(run.contextVersion, 2);
      const request = f.requests.at(-1)!;
      const systems = request.messages.filter((message) => message.role === "system");
      assert.equal(systems[0].sections?.preamble, collaboratorPrompt);
      assert.ok(systems[0].sections?.scientific_workspace);
      assert.equal(systems[0].sections?.scientific_retention, undefined);
      assert.match(
        systems.map(getSystemMessageText).join("\n"),
        /version 2[\s\S]*function was measured separately/,
      );
      assert.match(textOf(request), /The shape looks different/);
      assert.match(textOf(request), /Which observation/);
      assert.equal(f.sessions.page(f.conversationId, 200).items.length, 4);
    } finally {
      await f.close();
    }
  },
);

test(
  "Pi retries transient failures and Carl waits for the recovered response",
  timeout,
  async () => {
    const f = await fixture({
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
    });
    try {
      f.faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
        fauxAssistantMessage("Recovered after the transient failure."),
      ]);
      const run = await f.run("Continue the discussion.");
      assert.equal(run.status, "completed", run.error);
      assert.equal(f.faux.state.callCount, 2);
      assert.match(f.sessions.page(f.conversationId, 200).items.at(-1)!.text, /Recovered/);
      assert.equal(
        f.observed.filter((event) => event.type === "agent-run" && event.run.finishedAt).length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "unrecovered truncation and provider abort are not reported as successful runs",
  timeout,
  async () => {
    const f = await fixture();
    try {
      for (const stopReason of ["length", "aborted"] as const) {
        f.faux.setResponses([fauxAssistantMessage("An incomplete response", { stopReason })]);
        const run = await f.run("Please continue.");
        assert.equal(run.status, "failed");
        assert.equal(run.endReason, stopReason === "length" ? "truncated" : "interrupted");
      }
    } finally {
      await f.close();
    }
  },
);

test("AgentSession can finish after more than twelve tool turns", timeout, async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([
      ...Array.from({ length: 14 }, () => call("list_files", {})),
      fauxAssistantMessage("Completed after fourteen tool calls."),
    ]);
    const run = await f.run("Review the available files.");
    assert.equal(run.status, "completed", run.error);
    assert.equal(f.faux.state.callCount, 15);
    assert.match(f.sessions.page(f.conversationId, 200).items.at(-1)!.text, /fourteen/);
  } finally {
    await f.close();
  }
});

for (const cancel of [false, true])
  test(
    `scientist corrections survive ${cancel ? "cancellation" : "provider failure"} and restart`,
    timeout,
    async () => {
      let f = await fixture();
      try {
        const entered = deferred();
        const release = deferred();
        f.faux.setResponses([
          async (_context, options) => {
            entered.resolve();
            options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
            await release.promise;
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "Invalid test credentials",
            });
          },
        ]);
        const finished = f.finished();
        const run = f.supervisor.start(f.conversationId, "We have six independent samples.");
        await entered.promise;
        await f.supervisor.steer(
          run.id,
          "Correction: those are six aliquots from one donor, not six independent donors.",
        );
        assert.equal(f.sessions.page(f.conversationId, 200).items.at(-1)!.delivery, "pending");
        if (cancel) await f.supervisor.cancel(run.id);
        else release.resolve();
        assert.equal((await finished).status, cancel ? "cancelled" : "failed");
        const root = f.root;
        await f.close(false);
        f = await fixture({ root });
        const recovered = f.sessions
          .page(f.conversationId, 200)
          .items.filter((message) => message.text.startsWith("Correction:"));
        assert.equal(recovered.length, 1);
        f.faux.setResponses([fauxAssistantMessage("The sampling correction is available.")]);
        assert.equal((await f.run("Use the corrected experimental unit.")).status, "completed");
        assert.match(textOf(f.requests.at(-1)!), /six aliquots from one donor/);
        assert.equal(f.sessions.pending(f.conversationId).length, 0);
        assert.equal(
          f.sessions
            .page(f.conversationId, 200)
            .items.filter((message) => message.text.startsWith("Correction:")).length,
          1,
        );
      } finally {
        await f.close();
      }
    },
  );

test(
  "accepted messages survive a crash before Pi first flushes its new session",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const manager = f.sessions.get(f.conversationId);
      f.sessions.accept(f.conversationId, "The baseline is a paired sample.", randomUUID());
      assert.equal(existsSync(manager.getSessionFile()!), false);
      const reopened = new ConversationSessions(f.root, f.stateDir, f.store, f.events);
      assert.equal(reopened.pending(f.conversationId)[0].text, "The baseline is a paired sample.");
      reopened.restorePending(f.conversationId, "");
      assert.match(
        JSON.stringify(reopened.get(f.conversationId).buildSessionContext()),
        /paired sample/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "legacy transcripts and display-only corrections migrate without duplicate chat or tool replay",
  timeout,
  async () => {
    let f = await fixture();
    try {
      const first: Message = {
        id: randomUUID(),
        conversationId: f.conversationId,
        role: "user",
        text: "An old observation.",
        createdAt: new Date().toISOString(),
      };
      const correction: Message = {
        ...first,
        id: randomUUID(),
        text: "A correction formerly stranded in the chat record.",
      };
      f.store.put("message", first.id, first);
      f.store.put("message", correction.id, correction);
      f.store.put("transcript", f.conversationId, [
        { role: "user", content: first.text, timestamp: Date.now() },
        fauxAssistantMessage(
          fauxToolCall("execute_code", {
            language: "python",
            code: "never_replay()",
            reason: "Unfinished old action",
          }),
          { stopReason: "toolUse" },
        ),
      ]);
      f.faux.setResponses([fauxAssistantMessage("Recovered history is available.")]);
      assert.equal((await f.run("Continue carefully.")).status, "completed");
      const request = textOf(f.requests.at(-1)!);
      assert.match(request, /formerly stranded/);
      assert.doesNotMatch(request, /never_replay/);
      assert.match(request, /effects are unknown/);
      assert.equal(f.calls.length, 0);
      const messages = f.sessions.page(f.conversationId, 200).items;
      assert.equal(messages.filter((message) => message.id === first.id).length, 1);
      assert.equal(messages.filter((message) => message.id === correction.id).length, 1);
      const root = f.root;
      await f.close(false);
      f = await fixture({ root });
      assert.deepEqual(f.sessions.page(f.conversationId, 200).items, messages);
    } finally {
      await f.close();
    }
  },
);

test("kernel failures become Pi tool errors with recorded evidence", timeout, async () => {
  const f = await fixture({
    kernel: {
      execute: async (_language, _code, output, started) => {
        started({ sessionId: "shared", kernelId: "kernel" });
        output({ kind: "error", text: "ValueError: invalid input" });
        throw new Error("ValueError: invalid input");
      },
      interrupt: async () => {},
    },
  });
  try {
    f.faux.setResponses([
      call("inspect_environment", { language: "python" }),
      fauxAssistantMessage("Inspection failed; no inference follows."),
    ]);
    assert.equal((await f.run("Inspect the current data.")).status, "completed");
    const record = f.execution.get(f.execution.repository.list().items[0].id)!;
    assert.equal(record.status, "failed");
    assert.equal(record.purpose, "inspection");
    assert.equal(record.actor, "agent");
    assert.ok(record.toolCallId);
    const result = toolResults(f.requests.at(-1)!)[0];
    assert.equal(result.isError, true);
    assert.match(contentText(result.content), new RegExp(record.id));
  } finally {
    await f.close();
  }
});

test(
  "AgentSession receives pre-execution warnings, retains observations across runs, and can refresh or acknowledge",
  timeout,
  async () => {
    const sent: string[] = [];
    const f = await fixture({
      kernel: {
        async execute(_language, code, output, started) {
          started({ sessionId: "shared", kernelId: "kernel" });
          sent.push(code);
          output({
            kind: "stream",
            text: code.includes("def _carl_inspect")
              ? JSON.stringify([{ name: "A", type: "list", preview: "[1, 2]" }])
              : "actual output",
          });
        },
        async interrupt() {},
      },
    });
    const approve = f.events.subscribe((event) => {
      if (event.type === "permission") f.permissions.decide(event.request.id, true);
    });
    try {
      await f.execution.wait(
        f.execution.submit({ language: "python", actor: "human", code: "A = [10, 20]" }).id,
      );
      f.faux.setResponses([
        call("inspect_environment", { language: "python", names: ["A"] }),
        fauxAssistantMessage("I have a preview of A."),
      ]);
      await f.run("Inspect A.");
      const human = await f.execution.wait(
        f.execution.submit({ language: "python", actor: "human", code: "A[0] = 1" }).id,
      );
      f.faux.setResponses([
        call("execute_code", { language: "python", code: "print(A)", reason: "Use A" }),
        fauxAssistantMessage("The input changed; I will reconsider."),
      ]);
      await f.run("Continue.");
      const warning = f.execution.repository.list().items.at(-1)!;
      assert.equal(warning.status, "not_executed");
      assert.ok(!sent.includes("print(A)"));
      const returned = toolResults(f.requests.at(-1)!).at(-1)!;
      assert.equal(
        returned.isError,
        false,
        "A context warning is an actionable result, not a kernel failure",
      );
      const body = contentText(returned.content);
      assert.match(body, /^Not run/);
      assert.match(body, /A: may have changed/);
      assert.ok(body.includes(human.id));
      assert.ok(body.includes("A[0] = 1"));
      assert.equal(body.split(warning.id).length - 1, 1);
      assert.ok(body.length < 900, "A simple warning must fit in a short tool result");
      assert.doesNotMatch(
        body,
        /codeHash|kernelId|sessionId|activitySequence|contextCheck|executed|disposition/,
      );
      f.faux.setResponses([
        call("execute_code", {
          language: "python",
          code: "print(A)",
          reason: "Inspect the updated values",
          acknowledgment: {
            warningExecutionId: warning.id,
            reason: "Printing the updated A is the intended inspection.",
          },
        }),
        fauxAssistantMessage("The updated values were printed."),
      ]);
      await f.run("Proceed with the updated A.");
      assert.equal(sent.filter((code) => code === "print(A)").length, 1);
      await f.execution.wait(
        f.execution.submit({ language: "python", actor: "human", code: "A[1] = 3" }).id,
      );
      f.faux.setResponses([
        call("inspect_environment", { language: "python", names: ["A"] }),
        call("execute_code", {
          language: "python",
          code: "print(A)",
          reason: "Use the fresh preview",
        }),
        fauxAssistantMessage("The fresh observation was used."),
      ]);
      await f.run("Inspect again and continue.");
      assert.equal(f.execution.repository.list().items.at(-1)!.status, "succeeded");
      assert.equal(sent.filter((code) => code === "print(A)").length, 2);
    } finally {
      approve();
      await f.close();
    }
  },
);

test(
  "truncated inspection results only establish observations for the objects actually delivered",
  timeout,
  async () => {
    const f = await fixture({
      kernel: {
        async execute(_language, _code, output, started) {
          started({ sessionId: "shared", kernelId: "kernel" });
          output({
            kind: "stream",
            text: JSON.stringify(
              Array.from({ length: 120 }, (_, i) => ({
                name: `object_${i}`,
                type: "int",
                preview: `${i}`,
              })),
            ),
          });
        },
        async interrupt() {},
      },
    });
    const approve = f.events.subscribe((event) => {
      if (event.type === "permission") f.permissions.decide(event.request.id, true);
    });
    try {
      f.faux.setResponses([
        call("inspect_environment", { language: "python" }),
        call("execute_code", {
          language: "python",
          code: "print(object_110)",
          reason: "Use an omitted object",
        }),
        fauxAssistantMessage("A targeted inspection is needed."),
      ]);
      await f.run("Inspect the environment.");
      assert.equal(f.execution.repository.list().items.at(-1)!.status, "not_executed");
      const inspection = contentText(toolResults(f.requests.at(-1)!)[0].content);
      assert.equal(inspection.match(/^"object_/gm)?.length, 100);
      assert.match(inspection, /More: inspect_environment offset=100/);
      assert.doesNotMatch(inspection, /object_110/);
      f.faux.setResponses([
        call("inspect_environment", { language: "python", names: ["object_110"] }),
        call("execute_code", {
          language: "python",
          code: "print(object_110)",
          reason: "Use the targeted observation",
        }),
        fauxAssistantMessage("The named object was observed."),
      ]);
      await f.run("Inspect that object.");
      assert.equal(f.execution.repository.list().items.at(-1)!.status, "succeeded");
    } finally {
      approve();
      await f.close();
    }
  },
);

test(
  "Pi discovers skills while workspace reads stay bounded and honor unsaved buffers",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const skillPath = join(f.root, ".pi/skills/experimental-design/SKILL.md");
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(
        skillPath,
        "---\nname: experimental-design\ndescription: Elicit the experimental unit.\n---\nAsk whether samples share a donor.",
      );
      f.documents.edit(
        "analysis.py",
        Array.from({ length: 5000 }, (_, i) => `# unsaved line ${i + 1}`).join("\n"),
        1,
      );
      f.faux.setResponses([
        call("read", { path: "analysis.py" }),
        call("read", { path: skillPath }),
        fauxAssistantMessage("Read the selected material."),
      ]);
      assert.equal((await f.run("Understand the study design.")).status, "completed");
      const first = f.requests[0];
      assert.match(textOf(first), /experimental-design/);
      const names = first.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
      );
      assert.deepEqual(
        names.sort(),
        [
          "edit_document",
          "execute_code",
          "inspect_environment",
          "list_files",
          "read",
          "read_artifact",
          "read_execution",
        ].sort(),
      );
      const results = toolResults(f.requests.at(-1)!);
      const doc = contentText(results[0].content);
      assert.match(doc, /^analysis.py \(version 2\)/);
      assert.match(doc, /More: read offset=201/);
      assert.match(doc, /unsaved line 1/);
      assert.doesNotMatch(doc, /unsaved line 5000/);
      assert.ok(doc.length < 17_000);
      assert.match(contentText(results[1].content), /samples share a donor/);
    } finally {
      await f.close();
    }
  },
);

test("file lists and long file reads expose usable continuation hints", timeout, async () => {
  const f = await fixture();
  try {
    const files = Array.from({ length: 250 }, (_, i) => `data/sample_${i}.csv`);
    f.documents.list = () => files;
    f.documents.edit("analysis.py", "a".repeat(16_000) + "b".repeat(4000) + "\nlast line", 1);
    f.faux.setResponses([
      call("list_files", {}),
      call("list_files", { offset: 200 }),
      call("read", { path: "analysis.py", limit: 1 }),
      call("read", { path: "analysis.py", offset: 1, limit: 1, characterOffset: 16_000 }),
      call("read", { path: "analysis.py", offset: 2 }),
      fauxAssistantMessage("Read the complete buffer."),
    ]);
    await f.run("Read the current file.");
    const results = toolResults(f.requests.at(-1)!);
    assert.equal(
      contentText(results[0].content),
      files.slice(0, 200).join("\n") + "\n[More: list_files offset=200.]",
    );
    assert.equal(contentText(results[1].content), files.slice(200).join("\n"));
    const pages = results.slice(2).map((result) => contentText(result.content));
    assert.equal(
      pages[0],
      `analysis.py (version 2)\n${"a".repeat(16_000)}\n\n[More: read offset=1, limit=1, characterOffset=16000.]`,
    );
    assert.equal(
      pages[1],
      `analysis.py (version 2)\n${"b".repeat(4000)}\n\n[More: read offset=2.]`,
    );
    assert.equal(pages[2], "analysis.py (version 2)\nlast line");
  } finally {
    await f.close();
  }
});

test(
  "historical artifact receipts retain their checkpoint and never credit truncated objects",
  timeout,
  async () => {
    let rows = [{ name: "A", type: "int", preview: "1" }];
    const f = await fixture({
      kernel: {
        async execute(_language, _code, output, started) {
          started({ sessionId: "shared", kernelId: "kernel" });
          output({ kind: "stream", text: JSON.stringify(rows) });
        },
        async interrupt() {},
      },
    });
    const approve = f.events.subscribe((event) => {
      if (event.type === "permission") f.permissions.decide(event.request.id, true);
    });
    try {
      for (const large of [false, true]) {
        if (large)
          rows = Array.from({ length: 300 }, (_, i) => ({
            name: `A${i}`,
            type: "str",
            preview: "x".repeat(100),
          }));
        const name = large ? "A299" : "A";
        const historical = await f.execution.wait(
          f.execution.submit({
            language: "python",
            actor: "human",
            code: "recorded_inspection",
            purpose: "inspection",
            inspection: "environment",
          }).id,
        );
        const change = await f.execution.wait(
          f.execution.submit({ language: "python", actor: "human", code: `${name} = 2` }).id,
        );
        f.faux.setResponses([
          call("read_artifact", {
            executionId: historical.id,
            outputId: f.execution.outputs.references(historical.id)[0].id,
          }),
          call("execute_code", {
            language: "python",
            code: `print(${name})`,
            reason: "Check observation coverage",
          }),
          fauxAssistantMessage("The historical output does not establish the current value."),
        ]);
        await f.run("Read the captured artifact and use its object.");
        const record = f.execution.get(f.execution.repository.list().items.at(-1)!.id)!;
        assert.equal(record.status, "not_executed");
        const issue = record.contextCheck!.issues.find((issue) => issue.executionId === change.id)!;
        assert.ok(issue);
        assert.equal(issue.observedExecutionId, large ? undefined : historical.id);
        const artifact = toolResults(f.requests.at(-1)!)
          .filter((result) => result.toolName === "read_artifact")
          .at(-1)!;
        if (large) {
          assert.match(contentText(artifact.content), /More: read_artifact offset=16000/);
          assert.doesNotMatch(contentText(artifact.content), /A299/);
        } else assert.equal(contentText(artifact.content), JSON.stringify(rows));
      }
    } finally {
      approve();
      await f.close();
    }
  },
);

test("captured plots can reach the model without another kernel execution", timeout, async () => {
  const f = await fixture({
    kernel: {
      execute: async (_language, _code, output) =>
        output({
          kind: "display",
          data: {
            "image/png": readFileSync(join(process.cwd(), "src-tauri/icons/32x32.png")).toString(
              "base64",
            ),
            "text/plain": "Recorded figure",
          },
        }),
      interrupt: async () => {},
    },
  });
  try {
    const submitted = f.execution.submit({
      language: "python",
      actor: "human",
      code: "show_figure()",
    });
    const record = await f.execution.wait(submitted.id);
    f.faux.setResponses([
      call("read_artifact", {
        executionId: record.id,
        outputId: f.execution.outputs.references(record.id)[0].id,
      }),
      call("read_artifact", {
        executionId: record.id,
        outputId: f.execution.outputs.references(record.id)[0].id,
        offset: 1,
      }),
      fauxAssistantMessage("The recorded image is available for inspection."),
    ]);
    assert.equal((await f.run("Inspect the existing plot.")).status, "completed");
    const result = toolResults(f.requests.at(-1)!)[0];
    assert.equal(result.isError, false);
    assert.ok(result.content.some((block) => block.type === "image"));
    assert.equal(contentText(result.content), "Recorded figure");
    const continued = toolResults(f.requests.at(-1)!)[1];
    assert.equal(
      continued.content.some((block) => block.type === "image"),
      false,
    );
    assert.equal(contentText(continued.content), "ecorded figure");
    assert.equal(f.execution.repository.list().items.length, 1);
  } finally {
    await f.close();
  }
});

test(
  "automatic compaction uses scientific retention instructions and preserves raw history",
  timeout,
  async () => {
    const f = await fixture({
      settings: { compaction: { enabled: true, reserveTokens: 95_000, keepRecentTokens: 100 } },
    });
    try {
      f.context.update("Scientist correction: the independent unit is the donor.", 0);
      const manager = f.sessions.get(f.conversationId);
      manager.appendMessage({
        role: "user",
        content: "Historical observation: organoid shape changed. ".repeat(600),
        timestamp: Date.now() - 1000,
      });
      const old = fauxAssistantMessage("Working interpretation: function is unknown.", {
        timestamp: Date.now() - 900,
      });
      old.usage = { ...old.usage, input: 9000, totalTokens: 9010 };
      manager.appendMessage(old);
      f.faux.setResponses([
        fauxAssistantMessage(
          "Observed shape change; function unmeasured. Scientist corrected the unit to donor. Interpretation unresolved.",
        ),
        fauxAssistantMessage("We can continue with that distinction."),
      ]);
      const run = await f.run("What remains uncertain?");
      assert.equal(run.status, "completed", run.error);
      const summaryRequests = f.requests.filter((request) =>
        request.messages.some(
          (message) => message.role === "system" && message.sections?.scientific_retention,
        ),
      );
      assert.ok(summaryRequests.length);
      for (const request of summaryRequests)
        assert.equal(textOf(request).split(scientificRetention.split("\n")[0]).length - 1, 1);
      assert.ok(manager.getEntries().some((entry) => entry.type === "compaction"));
      assert.ok(
        manager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "message" &&
              JSON.stringify(entry.message).includes("Historical observation"),
          ),
      );
      const conversationRequests = f.requests.filter((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" && message.sections?.preamble === collaboratorPrompt,
        ),
      );
      assert.ok(conversationRequests.length);
      for (const request of conversationRequests)
        assert.match(textOf(request), /independent unit is the donor/);
      assert.ok(
        f.sessions
          .page(f.conversationId, 200)
          .items.some((message) => message.text.startsWith("Historical observation")),
      );
      f.context.update("Correction after compaction: donor pairing must be preserved.", 1);
      f.faux.setResponses([
        fauxAssistantMessage("The updated context is available after compaction."),
      ]);
      assert.equal((await f.run("Continue from the summary.")).status, "completed");
      assert.match(textOf(f.requests.at(-1)!), /Correction after compaction: donor pairing/);
    } finally {
      await f.close();
    }
  },
);

test(
  "Pi consumes distinct steering receipts, including repeated text, during a successful run",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const entered = deferred();
      const release = deferred();
      f.faux.setResponses([
        async () => {
          entered.resolve();
          await release.promise;
          return fauxAssistantMessage("Initial response.");
        },
        fauxAssistantMessage("First correction received."),
        fauxAssistantMessage("Repeated correction received."),
      ]);
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Discuss the observation.");
      await entered.promise;
      await f.supervisor.steer(run.id, "Keep the donor pairing.");
      await f.supervisor.steer(run.id, "Keep the donor pairing.");
      release.resolve();
      assert.equal((await finished).status, "completed");
      const corrections = f.sessions
        .page(f.conversationId, 200)
        .items.filter((message) => message.text === "Keep the donor pairing.");
      assert.equal(corrections.length, 2);
      assert.notEqual(corrections[0].id, corrections[1].id);
      assert.ok(corrections.every((message) => message.delivery === "delivered"));
      assert.equal(f.sessions.pending(f.conversationId).length, 0);
      assert.ok(
        f.requests.slice(1).every((request) => textOf(request).includes("Keep the donor pairing.")),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "cancelling AgentSession interrupts its running computation through ExecutionService",
  timeout,
  async () => {
    const started = deferred();
    let interrupted = false;
    const f = await fixture({
      kernel: {
        execute: async (_language, _code, _output, identity, signal) => {
          identity({ sessionId: "shared", kernelId: "kernel" });
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
        interrupt: async () => {
          interrupted = true;
        },
      },
    });
    try {
      f.faux.setResponses([
        call("execute_code", {
          language: "python",
          code: "long_computation()",
          reason: "Test cancellation",
        }),
      ]);
      const requested = f.requested();
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Start the computation.");
      f.permissions.decide((await requested).id, true);
      await started.promise;
      await f.supervisor.cancel(run.id);
      assert.equal((await finished).status, "cancelled");
      assert.equal(interrupted, true);
      assert.equal(
        f.execution.get(f.execution.repository.list().items[0].id)!.status,
        "interrupted",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "AgentSession cancellation settles even when kernel execution and interrupt never respond",
  timeout,
  async () => {
    const started = deferred();
    const release = deferred();
    const stopped = deferred();
    const f = await fixture({
      cancellationTimeoutMs: 20,
      kernel: {
        execute: async (_language, _code, output, identity) => {
          identity({ sessionId: "shared", kernelId: "kernel" });
          started.resolve();
          await release.promise;
          output({ kind: "stream", text: "late output" });
          stopped.resolve();
        },
        interrupt: () => new Promise(() => {}),
      },
    });
    try {
      f.faux.setResponses([call("inspect_environment", { language: "python" })]);
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Inspect the environment.");
      await started.promise;
      await f.supervisor.cancel(run.id);
      assert.equal((await finished).status, "cancelled");
      const record = f.execution.repository.list().items[0];
      assert.equal(record.status, "completion_unknown");
      release.resolve();
      await stopped.promise;
      assert.equal(f.execution.outputs.count(record.id), 0);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  "a failed scientific compaction stops visibly without a generic fallback or lost history",
  timeout,
  async () => {
    const f = await fixture({
      settings: { compaction: { enabled: true, reserveTokens: 95_000, keepRecentTokens: 100 } },
    });
    try {
      const manager = f.sessions.get(f.conversationId);
      manager.appendMessage({
        role: "user",
        content: "Keep the matched control. ".repeat(1500),
        timestamp: Date.now() - 1000,
      });
      const old = fauxAssistantMessage("The interpretation remains unresolved.", {
        timestamp: Date.now() - 900,
      });
      old.usage = { ...old.usage, input: 9000, totalTokens: 9010 };
      manager.appendMessage(old);
      f.faux.setResponses([
        fauxAssistantMessage("A response before compaction."),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid test credentials" }),
      ]);
      const run = await f.run("Continue the investigation.");
      assert.equal(run.status, "failed");
      assert.match(run.error!, /Scientific context compaction failed/);
      assert.equal(
        f.faux.state.callCount,
        2,
        "Only the original response and the failed scientific summary; no generic fallback",
      );
      assert.ok(textOf(f.requests.at(-1)!).includes(scientificRetention.split("\n")[0]));
      assert.ok(!manager.getEntries().some((entry) => entry.type === "compaction"));
      assert.ok(
        f.sessions
          .page(f.conversationId, 200)
          .items.some((message) => message.text.startsWith("Keep the matched control")),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "cancellation during Pi authentication preflight preserves the unsent prompt",
  timeout,
  async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const runtime = f.options.modelRuntime;
    const checkAuth = runtime.checkAuth.bind(runtime);
    runtime.checkAuth = async (provider, options) => {
      entered.resolve();
      await release.promise;
      return checkAuth(provider, options);
    };
    try {
      const finished = f.finished();
      const run = f.supervisor.start(f.conversationId, "Do not lose this new scientific question.");
      await entered.promise;
      const cancelled = f.supervisor.cancel(run.id);
      release.resolve();
      await cancelled;
      assert.equal((await finished).status, "cancelled");
      assert.equal(f.requests.length, 0, "Cancellation prevents a model turn after preflight");
      assert.ok(
        f.sessions
          .pending(f.conversationId)
          .some((message) => message.text === "Do not lose this new scientific question."),
      );
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  "Pi's split-turn compaction also receives scientific retention policy and current notes",
  timeout,
  async () => {
    const f = await fixture({ settings: { compaction: { keepRecentTokens: 100 } } });
    try {
      f.context.update("Scientist correction: samples share one donor.", 0);
      const manager = f.sessions.get(f.conversationId);
      manager.appendMessage({
        role: "user",
        content: "An earlier observation.",
        timestamp: Date.now() - 4000,
      });
      manager.appendMessage(
        fauxAssistantMessage("An earlier interpretation.", { timestamp: Date.now() - 3000 }),
      );
      manager.appendMessage({
        role: "user",
        content: "Current experimental context. ".repeat(500),
        timestamp: Date.now() - 2000,
      });
      manager.appendMessage(
        fauxAssistantMessage("Unresolved current interpretation. ".repeat(200), {
          timestamp: Date.now() - 1000,
        }),
      );
      const run = {
        id: randomUUID(),
        conversationId: f.conversationId,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        contextVersion: 1,
      };
      const session = await f.pi.create({
        manager,
        prompt: "Elicit scientific context.",
        research: f.context.get(),
        tools: (skills) => workspaceTools(run, f.documents, f.execution, f.permissions, skills),
        attributeMessage: (message) => message,
        onContext: () => {},
        onError: (error) => {
          throw error;
        },
      });
      try {
        f.faux.setResponses([
          fauxAssistantMessage("Prior observation and interpretation remain distinct."),
          fauxAssistantMessage("Current donor relationship is a scientist-provided correction."),
        ]);
        await session.compact("Retain the paired-control decision.");
        assert.equal(f.requests.length, 2);
        for (const request of f.requests) {
          assert.equal(textOf(request).split(scientificRetention.split("\n")[0]).length - 1, 1);
          assert.match(textOf(request), /samples share one donor/);
        }
        assert.match(textOf(f.requests[0]), /Retain the paired-control decision/);
        assert.ok(
          textOf(f.requests[1]).includes("# Conversation"),
          "The second request summarizes the split turn",
        );
        const compacted = manager.getEntries().find((entry) => entry.type === "compaction")!;
        assert.equal(compacted.type, "compaction");
        assert.match(compacted.summary, /Turn Context/);
      } finally {
        session.dispose();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "agent discovery and reading include untitled work without creating a project file",
  timeout,
  async () => {
    const f = await fixture();
    try {
      const initial = f.documents.createUntitled("python");
      const doc = f.documents.edit(
        initial.path,
        "# scientist's unsaved work\nx = 42",
        initial.version,
      );
      assert.ok(!f.documents.list().includes(doc.path));
      f.faux.setResponses([
        call("list_files", {}),
        call("read", { path: doc.path }),
        fauxAssistantMessage("The working document contains x = 42."),
      ]);
      await f.run("Read my untitled script.");
      const results = toolResults(f.requests.at(-1)!);
      assert.match(contentText(results[0].content), /Untitled-1.py/);
      assert.equal(
        contentText(results[1].content),
        `${doc.path} (version ${doc.version})\n${doc.content}`,
      );
      f.documents.saveAs(doc.path, "saved.py", doc.version);
      assert.ok(!f.documents.listWorking().includes(doc.path));
      assert.ok(f.documents.listWorking().includes("saved.py"));
      assert.throws(() => f.documents.edit(doc.path, "x = 99", doc.version), /saved as saved.py/);
      assert.equal(f.documents.open("saved.py").content, doc.content);
    } finally {
      await f.close();
    }
  },
);
