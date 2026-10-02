import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AgentRun, AgentQuestion } from "@biologue/protocol";
import { deferred, fixture, scriptedModel } from "./helpers/pi-fixture.ts";
import { RunsDoc } from "../src/durable-state.ts";
import { PiAdapter } from "../src/pi.ts";

async function eventually<T>(
  read: () => T | Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 1500; i++) {
    const value = await read();
    if (matches(value)) return value;
    await delay(20);
  }
  throw new Error("Recovery did not reach the expected state.");
}
async function crash(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "biologue-crash-"));
  const child = fork(
    fileURLToPath(new URL("./helpers/durable-crash-worker.ts", import.meta.url)),
    [root, scenario],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(child, "message").then(
      ([message]) => message as { run: AgentRun; runs?: AgentRun[]; question?: AgentQuestion },
    ),
    exited.then(() => {
      throw new Error(`Worker exited before its checkpoint: ${stderr}`);
    }),
    delay(60_000, undefined, { ref: false }).then(() => {
      child.kill("SIGKILL");
      throw new Error(`Worker timed out: ${stderr}`);
    }),
  ]);
  if (scenario !== "question-answered") child.kill("SIGKILL");
  await exited;
  return { root, ...ready };
}
for (const scenario of ["execute", "nested"])
  test(
    `SIGKILL recovery settles interrupted ${scenario} work without replaying scientific effects`,
    { timeout: 90_000 },
    async () => {
      const killed = await crash(scenario);
      const model = await scriptedModel();
      model.faux.setResponses([
        fauxAssistantMessage("The interrupted effect needs review; donor is the corrected unit."),
        fauxAssistantMessage("The donor correction remains in context."),
      ]);
      const f = await fixture({ root: killed.root, model });
      try {
        const run = await eventually(
          () => f.store.get<AgentRun>("run", killed.run.id)!,
          (r) => !!r.finishedAt,
        );
        assert.equal(run.status, "completed", run.error);
        assert.equal(
          f.calls.length,
          0,
          "An interrupted tool must never dispatch again on recovery.",
        );
        assert.equal(
          readFileSync(join(killed.root, "external-effects.txt"), "utf8"),
          "effect_once()\n",
        );
        const history = await f.sessions.history(run.conversationId);
        assert.match(JSON.stringify(history), /interrupted|unknown|replay/i);
        assert.match(JSON.stringify(model.requests), /independent unit is the donor/);
        assert.match(JSON.stringify(model.requests), /Corrected unit: donor/);
        const chat = (await f.sessions.page(run.conversationId, 200)).items;
        assert.equal(
          chat.filter((m) => m.text === "Continue the scientific investigation.").length,
          1,
        );
        assert.equal(
          chat.filter((m) => m.text === "Correction: the independent unit is the donor.").length,
          1,
        );
        assert.equal(f.execution.repository.list().items[0].status, "abandoned");
        assert.equal((await f.supervisor.harness.inspect(ctx)).tasks.length, 0);
      } finally {
        await f.close();
      }
    },
  );
for (const scenario of ["question-pending", "question-answered"])
  test(
    `SIGKILL recovery preserves ${scenario} identity and consumes durable answers once`,
    { timeout: 90_000 },
    async () => {
      const killed = await crash(scenario);
      const model = await scriptedModel();
      model.faux.setResponses([fauxAssistantMessage("We will use donor as the independent unit.")]);
      const f = await fixture({ root: killed.root, model });
      try {
        if (scenario === "question-pending") {
          const questions = await eventually(
            () => f.supervisor.dialogs.list(),
            (list) => list.length > 0,
          );
          assert.equal(questions[0].id, killed.question!.id);
          f.supervisor.dialogs.answer(questions[0].id, questions[0].options![0]);
        }
        const run = await eventually(
          () => f.store.get<AgentRun>("run", killed.run.id)!,
          (r) => !!r.finishedAt,
        );
        assert.equal(run.status, "completed", run.error);
        assert.equal(f.supervisor.dialogs.list().length, 0);
        assert.equal(f.store.list("question-answer").length, 1);
        assert.equal(
          f.faux.state.callCount,
          1,
          "The old question request must not be generated again.",
        );
        const history = await f.sessions.history(run.conversationId);
        assert.equal(
          history
            .flatMap((e) => e.model ?? [])
            .filter((m) => m.role === "toolResult" && m.toolName === "ask_user").length,
          1,
        );
        assert.match(JSON.stringify(model.requests), /Donor/);
      } finally {
        await f.close();
      }
    },
  );
test(
  "SIGKILL recovery deduplicates an admitted input and resumes an unfinished provider request",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("provider");
    const model = await scriptedModel();
    model.faux.setResponses([fauxAssistantMessage("Recovered response.")]);
    const f = await fixture({
      root: killed.root,
      model,
      beforeInitialize: (_pi, store) => {
        // Native state is authoritative even if every app run/chat projection is lost.
        store.db.exec(
          "DELETE FROM records WHERE kind IN ('run', 'durable-index', 'durable-display'); DELETE FROM chat_messages;",
        );
        const put = store.put.bind(store);
        let injected = false;
        store.put = (kind, id, value) => {
          if (!injected && kind === "run") {
            injected = true;
            throw new Error("Recovery display cache unavailable");
          }
          return put(kind, id, value);
        };
      },
    });
    try {
      const run = await eventually(
        () => f.store.get<AgentRun>("run", killed.run.id),
        (r) => !!r?.finishedAt,
      );
      assert.ok(run);
      assert.equal(run.status, "completed", run.error);
      assert.equal(
        (await f.sessions.page(run.conversationId)).items.filter((m) => m.role === "user").length,
        1,
      );
      assert.equal(model.requests.length, 1);
      assert.match(JSON.stringify(model.requests), /Correction during interrupted request: donor/);
    } finally {
      await f.close();
    }
  },
);
test("a live storage owner blocks another harness and orderly shutdown releases ownership", async () => {
  const f = await fixture();
  const root = f.root;
  try {
    const adapter = new PiAdapter({ project: root, stateDir: f.stateDir, ...f.options });
    await assert.rejects(adapter.openHarness(), /already owned/);
    await f.close(false);
    const opened = await adapter.openHarness();
    await opened.harness.close(ctx);
    adapter.releaseHarness();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "shutdown drains native input acceptance and resumes it once on reopening",
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    const root = f.root;
    const conversation = await f.sessions.get(f.conversationId);
    const commit = conversation.commit.bind(conversation);
    const entered = deferred(),
      release = deferred();
    conversation.commit = async (...args) => {
      entered.resolve();
      await release.promise;
      return commit(...args);
    };
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const accepting = f.supervisor.start(f.conversationId, "Accepted during shutdown");
      await entered.promise;
      const closing = f.supervisor.close();
      await assert.rejects(f.supervisor.start(f.conversationId, "Too late"), /shutting down/);
      release.resolve();
      const run = await accepting;
      await closing;
      assert.equal(f.requests.length, 0);
      await f.close(false);
      const model = await scriptedModel();
      model.faux.setResponses([fauxAssistantMessage("Accepted input recovered")]);
      reopened = await fixture({ root, model });
      const result = await eventually(
        () => reopened!.store.get<AgentRun>("run", run.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(result.status, "completed", result.error);
      assert.equal(model.requests.length, 1);
      assert.equal(
        (await reopened.sessions.page(run.conversationId)).items.filter((m) => m.role === "user")
          .length,
        1,
      );
    } finally {
      release.resolve();
      conversation.commit = commit;
      if (reopened) await reopened.close();
      else {
        await f.close(false);
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
for (const scenario of ["provider", "question"])
  test(
    `orderly shutdown suspends pending ${scenario} work and reopening resumes the same run`,
    { timeout: 90_000 },
    async () => {
      let f = await fixture();
      try {
        const entered = deferred();
        if (scenario === "provider")
          f.faux.setResponses([
            async (_context, options) => {
              const stopped = deferred();
              options?.signal?.addEventListener("abort", () => stopped.resolve(), { once: true });
              entered.resolve();
              await stopped.promise;
              return fauxAssistantMessage("", { stopReason: "aborted" });
            },
          ]);
        else
          f.faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall("ask_user", {
                question: "Which experimental unit should we use?",
                options: [{ title: "Donor" }, { title: "Aliquot" }],
                allowFreeform: false,
              }),
              { stopReason: "toolUse" },
            ),
          ]);
        const run = await f.supervisor.start(f.conversationId, "Continue the investigation.");
        const question =
          scenario === "question"
            ? (
                await eventually(
                  () => f.supervisor.dialogs.list(),
                  (list) => list.length > 0,
                )
              )[0]
            : undefined;
        if (!question) await entered.promise;
        const root = f.root;
        await f.close(false);
        const model = await scriptedModel();
        model.faux.setResponses([fauxAssistantMessage("The suspended investigation resumed.")]);
        f = await fixture({ root, model });
        if (question) {
          const restored = (
            await eventually(
              () => f.supervisor.dialogs.list(),
              (list) => list.length > 0,
            )
          )[0];
          assert.equal(restored.id, question.id);
          f.supervisor.dialogs.answer(restored.id, restored.options![0]);
        }
        const resumed = await eventually(
          () => f.store.get<AgentRun>("run", run.id)!,
          (value) => !!value.finishedAt,
        );
        assert.equal(resumed.status, "completed", resumed.error);
        assert.equal(model.requests.length, 1);
        assert.equal(
          (await f.sessions.page(run.conversationId)).items.filter((m) => m.role === "user").length,
          1,
        );
        if (question) assert.match(JSON.stringify(model.requests), /Donor/);
      } finally {
        await f.close();
      }
    },
  );
test(
  "recovery installs every active conversation's tools and scientific policy before scheduling",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("providers");
    const model = await scriptedModel();
    model.faux.setResponses([
      fauxAssistantMessage("Recovered first answer."),
      fauxAssistantMessage("Recovered second answer."),
    ]);
    const f = await fixture({ root: killed.root, model });
    try {
      assert.equal(killed.runs!.length, 2);
      for (const old of killed.runs!) {
        const run = await eventually(
          () => f.store.get<AgentRun>("run", old.id)!,
          (r) => !!r.finishedAt,
        );
        assert.equal(run.status, "completed", run.error);
        assert.equal(
          (await f.sessions.page(run.conversationId)).items.filter((m) => m.role === "user").length,
          1,
        );
      }
      assert.equal(model.requests.length, 2);
      assert.ok(
        model.requests.every((r) =>
          JSON.stringify(r).includes("Correction during interrupted request: donor"),
        ),
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "a committed scientific summary survives SIGKILL before placement without another model request or duplicate usage",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("summary");
    const model = await scriptedModel();
    const f = await fixture({ root: killed.root, model });
    try {
      const run = await eventually(
        () => f.store.get<AgentRun>("run", killed.run.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(run.status, "completed", run.error);
      assert.equal(model.requests.length, 0);
      const history = await f.sessions.history(run.conversationId);
      assert.equal(history.filter((e) => e.kind === "pi.compaction").length, 1);
      assert.match(JSON.stringify(history), /Original scientific measurements/);
      assert.ok(run.usage!.tokens.total > 0);
      const usage = await f.supervisor.harness.usage(ctx);
      assert.equal(
        run.usage!.tokens.total,
        Object.values(usage.models).reduce((n, u) => n + u.totalTokens, 0),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "failed recovery setup cannot start another conversation before its scientific policy is installed",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("providers");
    const [first, second] = killed.runs!;
    const model = await scriptedModel();
    model.faux.setResponses([fauxAssistantMessage("Recovered second answer")]);
    const entered = deferred(),
      release = deferred();
    const opening = fixture({
      root: killed.root,
      model,
      beforeInitialize: async (pi, _store, context, harness) => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(
            RunsDoc,
            Number(first.piSessionId) as import("@earendil-works/pi-durable").ConversationId,
          );
          state.runs.find((saved) => saved.run.id === first.id)!.run.settings!.model =
            "removed-model";
        }, ctx);
        context.update(
          "Newest correction: the biological unit is the donor.",
          context.get().version,
        );
        const create = pi.create.bind(pi);
        pi.create = async (input) => {
          if (input.run.id === second.id) {
            entered.resolve();
            await release.promise;
          }
          return create(input);
        };
      },
    });
    await entered.promise;
    // Setup failure in the first conversation must not resume the global scheduler.
    try {
      await delay(150);
      assert.equal(model.requests.length, 0);
    } finally {
      release.resolve();
    }
    const f = await opening;
    try {
      const failed = await eventually(
        () => f.store.get<AgentRun>("run", first.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(failed.status, "failed");
      const recovered = await eventually(
        () => f.store.get<AgentRun>("run", second.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(recovered.status, "completed", recovered.error);
      assert.equal(model.requests.length, 1);
      assert.match(
        JSON.stringify(model.requests[0]),
        /Newest correction: the biological unit is the donor/,
      );
      assert.ok(
        model.requests[0].messages.some(
          (m) => m.role === "system" && m.toolsAdded?.some((t) => t.name === "execute_code"),
        ),
      );
      assert.equal(
        f.store.list<{ runId: string }>("run-request").filter((r) => r.runId === second.id).length,
        2,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "SIGKILL after native compaction admission recovers the same task before the app pointer is saved",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("summary-admitted");
    const model = await scriptedModel();
    model.faux.setResponses([
      fauxAssistantMessage("Measurements retained; interpretation remains unresolved."),
    ]);
    const f = await fixture({ root: killed.root, model });
    try {
      const run = await eventually(
        () => f.store.get<AgentRun>("run", killed.run.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(run.status, "completed", run.error);
      assert.equal(model.requests.length, 1);
      assert.equal(
        (await f.sessions.history(run.conversationId)).filter((e) => e.kind === "pi.compaction")
          .length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "SIGKILL before initial admission preserves startup follow-ups after the original input",
  { timeout: 90_000 },
  async () => {
    const killed = await crash("startup");
    const model = await scriptedModel();
    model.faux.setResponses([
      fauxAssistantMessage("Initial investigation response"),
      fauxAssistantMessage("Startup correction received"),
    ]);
    const f = await fixture({ root: killed.root, model });
    try {
      const run = await eventually(
        () => f.store.get<AgentRun>("run", killed.run.id)!,
        (r) => !!r.finishedAt,
      );
      assert.equal(run.status, "completed", run.error);
      const inputs = (await f.sessions.history(run.conversationId))
        .flatMap((e) => e.model ?? [])
        .filter((m) => m.role === "user");
      assert.equal(inputs.length, 2);
      assert.match(JSON.stringify(inputs[0].content), /Continue the scientific investigation/);
      assert.match(JSON.stringify(inputs[1].content), /Startup correction: use donor as the unit/);
      const initial = model.requests[0].messages.find((m) => m.role === "user")!;
      assert.match(JSON.stringify(initial.content), /Continue the scientific investigation/);
      assert.equal((await f.sessions.pending(run.conversationId)).length, 0);
    } finally {
      await f.close();
    }
  },
);
