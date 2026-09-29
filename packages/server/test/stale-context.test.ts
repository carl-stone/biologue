import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Execution, Language } from "@carl/protocol";
import { analyzeCode } from "../src/code-effects.ts";
import { ExecutionService, type KernelBackend } from "../src/execution.ts";
import { OutputService } from "../src/outputs.ts";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import type { ContextAcknowledgment } from "../src/stale-context.ts";
import { deferred } from "./helpers/pi-fixture.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biologue-context-"));
  const store = new Store(join(root, "test.sqlite"));
  const events = new Events();
  const calls: string[] = [];
  let generation = "first",
    hold: ReturnType<typeof deferred<void>> | undefined;
  let entered = deferred();
  const kernel: KernelBackend = {
    async execute(language, code, output, started) {
      started({ sessionId: language, kernelId: language, kernelGeneration: generation });
      calls.push(code);
      entered.resolve();
      if (hold) await hold.promise;
      if (code.includes("raise RuntimeError")) throw new Error("Failed after a possible mutation");
      output({ kind: "stream", text: "observed output" });
    },
    async interrupt() {
      hold?.resolve();
    },
  };
  const service = new ExecutionService(
    store,
    events,
    kernel,
    new OutputService(store, events, join(root, "artifacts")),
  );
  const conversationId = randomUUID();
  service.context.begin(conversationId);
  const run = (
    code: string,
    options: {
      language?: Language;
      agent?: boolean;
      conversation?: string;
      acknowledgment?: ContextAcknowledgment;
    } = {},
  ) => {
    const record = service.submit({
      language: options.language ?? "python",
      actor: options.agent ? "agent" : "human",
      code,
      conversationId: options.agent ? (options.conversation ?? conversationId) : undefined,
      acknowledgment: options.acknowledgment,
    });
    return service.wait(record.id);
  };
  const observe = (
    record: Execution,
    names: string[],
    conversation = conversationId,
    kind: "environment_preview" | "execution_result" = "environment_preview",
  ) => {
    service.context.observeContext(conversation, [
      {
        role: "toolResult",
        toolCallId: randomUUID(),
        toolName: "inspect_environment",
        content: [{ type: "text", text: "bounded preview" }],
        details: {
          biologueObservation: { executionId: record.id, names, kind },
        },
        isError: false,
        timestamp: Date.now(),
      },
    ]);
  };
  const inspect = async (
    names = ["A"],
    language: Language = "python",
    conversation = conversationId,
  ) => {
    const queued = service.submit({
      language,
      actor: "agent",
      code: "recorded_inspection",
      purpose: "inspection",
      inspection: "environment",
      conversationId: conversation,
    });
    const record = await service.wait(queued.id);
    observe(record, names, conversation);
    return record;
  };
  return {
    store,
    service,
    calls,
    run,
    inspect,
    observe,
    conversationId,
    restart() {
      generation = randomUUID();
    },
    pause() {
      hold = deferred();
      entered = deferred();
      return {
        entered: entered.promise,
        release() {
          hold!.resolve();
          hold = undefined;
        },
      };
    },
    async close() {
      await service.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const acknowledge = (record: Execution): ContextAcknowledgment => ({
  warningExecutionId: record.id,
  reason: "Use the scientist's updated normalization for this calculation.",
});

test("parsers distinguish names, labels, comments, local definitions, delayed bodies, and mutations", async () => {
  const r = await analyzeCode(
    "r",
    '# phantom <- x\nA <- A / 10\nmeans <- rowMeans(A)\nlabel <- "not_a_variable"\nf <- function(x) { hidden <<- x; x + secret }',
  );
  assert.deepEqual(r.reads, ["A", "rowMeans"]);
  assert.deepEqual(r.writes, ["A", "f", "label", "means"]);
  assert.equal(r.opaque, false);
  const py = await analyzeCode(
    "python",
    'local = 1\nmeans = A.mean(axis=local)\nA[0] = 2\nB = A\ndef f(x):\n hidden = x + secret\nresult = [x + local for x in A]\nprint(f"value {other}")',
  );
  assert.ok(py.reads.includes("A") && py.reads.includes("other"));
  for (const name of ["axis", "local", "mean", "x", "hidden", "secret"])
    assert.ok(!py.reads.includes(name), name);
  assert.ok(py.mutates.includes("A"));
  assert.ok(!py.calls.includes("A"), "method receivers remain data dependencies");
  assert.ok(py.calls.includes("print"));
  assert.deepEqual(py.aliases, [["B", "A"]]);
  assert.equal(py.opaque, true);
  assert.equal((await analyzeCode("python", "A = (")).opaque, true);
  assert.equal((await analyzeCode("r", "DT[, x := x / 10]")).opaque, true);
  assert.deepEqual((await analyzeCode("r", 'names(A) <- c("sample")')).mutates, ["A"]);
  assert.deepEqual((await analyzeCode("python", "B += [3]")).mutates, ["B"]);
  const branches = await analyzeCode("python", "if flag:\n x = 1\nprint(x)");
  assert.ok(
    branches.reads.includes("x"),
    "conditional definitions cannot hide external dependencies",
  );
});

for (const language of ["python", "r"] as const) {
  test(`${language}: checks at dispatch after a queued human mutation and records no execution on warning`, async () => {
    const f = fixture();
    try {
      await f.run(language === "r" ? "A <- c(10, 20)" : "A = [10, 20]", { language });
      const observation = await f.inspect(["A"], language);
      const pause = f.pause();
      const human = f.run(language === "r" ? "A <- A / 10" : "A[0] = 1", { language });
      await pause.entered;
      const proposed = f.run("print(A)", { agent: true, language });
      pause.release();
      const changed = await human,
        warning = await proposed;
      assert.equal(warning.status, "not_executed");
      assert.equal(warning.activitySequence, undefined);
      assert.equal(warning.startedAt, undefined);
      assert.equal(f.service.outputs.count(warning.id), 0);
      assert.ok(!f.calls.includes("print(A)"));
      assert.ok(
        warning.contextCheck!.issues.some(
          (issue) =>
            issue.executionId === changed.id && issue.observedExecutionId === observation.id,
        ),
      );
      assert.equal(f.service.get(warning.id)!.code, "print(A)");
      const retry = await f.run("print(A)", {
        agent: true,
        language,
        acknowledgment: acknowledge(warning),
      });
      assert.equal(retry.status, "succeeded", retry.error);
      assert.equal(retry.contextCheck!.disposition, "acknowledged");
    } finally {
      await f.close();
    }
  });
}

test("unrelated writes and harmless printing pass; relevant input and output changes require review", async () => {
  const f = fixture();
  try {
    await f.run("A = [10, 20]");
    await f.inspect();
    await f.run('unrelated = 3\nprint("hello")');
    assert.equal((await f.run("print(A)", { agent: true })).status, "succeeded");
    const changed = await f.run("means = 4");
    const overwrite = await f.run("means = 5", { agent: true });
    assert.equal(overwrite.status, "not_executed");
    assert.ok(
      overwrite.contextCheck!.issues.some(
        (issue) => issue.executionId === changed.id && issue.object === "means",
      ),
    );
    await f.run("A = 3", { language: "r" });
    assert.equal(
      (await f.run("print(A)", { agent: true })).status,
      "succeeded",
      "R activity cannot invalidate Python observations",
    );
  } finally {
    await f.close();
  }
});

test("acknowledgments cover only the shown evidence, code, conversation and kernel generation", async () => {
  const f = fixture();
  try {
    await f.run("A = [10, 20]");
    await f.inspect();
    await f.run("A[0] = 1");
    const first = await f.run("print(A)", { agent: true });
    const newer = await f.run("A[1] = 2");
    const second = await f.run("print(A)", { agent: true, acknowledgment: acknowledge(first) });
    assert.equal(second.status, "not_executed");
    assert.ok(second.contextCheck!.issues.some((issue) => issue.executionId === newer.id));
    assert.equal(
      (await f.run("print(A)", { agent: true, acknowledgment: acknowledge(second) })).status,
      "succeeded",
    );
    assert.equal(
      (await f.run("print(A[0])", { agent: true, acknowledgment: acknowledge(second) })).status,
      "not_executed",
    );
    assert.equal(
      (
        await f.run("print(A)", {
          agent: true,
          conversation: "another",
          acknowledgment: acknowledge(second),
        })
      ).status,
      "not_executed",
    );
    f.restart();
    const restarted = await f.run("print(A)", { agent: true, acknowledgment: acknowledge(second) });
    assert.equal(restarted.status, "not_executed");
    assert.ok(restarted.contextCheck!.issues.some((issue) => issue.kind === "kernel_changed"));
  } finally {
    await f.close();
  }
});

test("fresh delivered inspection resolves a warning; reading an old result cannot refresh it", async () => {
  const f = fixture();
  try {
    await f.run("A = 1");
    const old = await f.inspect();
    await f.run("A = 2");
    f.observe(old, ["A"]);
    assert.equal((await f.run("print(A)", { agent: true })).status, "not_executed");
    await f.inspect();
    f.observe(old, ["A"]); // Historical result must not even replace a newer observation.
    assert.equal((await f.run("print(A)", { agent: true })).status, "succeeded");
    assert.equal(
      (await f.run("print(A)", { agent: true, conversation: "another" })).status,
      "not_executed",
    );
  } finally {
    await f.close();
  }
});

test("possible alias mutations and partially failed code remain evidence", async () => {
  const f = fixture();
  try {
    await f.run("A = [1, 2]\nB = A");
    await f.inspect();
    const alias = await f.run("B[0] = 9");
    const warning = await f.run("print(A)", { agent: true });
    assert.ok(
      warning.contextCheck!.issues.some(
        (issue) => issue.executionId === alias.id && issue.kind === "unknown",
      ),
    );
    await f.inspect();
    const augmented = await f.run("B += [3]");
    const afterAugmented = await f.run("print(A)", { agent: true });
    assert.equal(afterAugmented.status, "not_executed");
    assert.ok(
      afterAugmented.contextCheck!.issues.some((issue) => issue.executionId === augmented.id),
    );
    await f.inspect();
    const failed = await f.run('A[1] = 8\nraise RuntimeError("later failure")');
    assert.equal(failed.status, "failed");
    const afterFailure = await f.run("print(A)", { agent: true });
    assert.equal(afterFailure.status, "not_executed");
    assert.ok(afterFailure.contextCheck!.issues.some((issue) => issue.executionId === failed.id));
  } finally {
    await f.close();
  }
});

test("a proposed opaque call considers changes to dependencies not named in its source", async () => {
  const f = fixture();
  try {
    await f.run("A = 1\ndef calculate():\n return A");
    await f.inspect(["A", "calculate"]);
    await f.run("A = 2");
    const warning = await f.run("answer = calculate()", { agent: true });
    assert.equal(warning.status, "not_executed");
    assert.ok(
      warning.contextCheck!.issues.some(
        (issue) => issue.kind === "unknown" && issue.message.includes("unresolved dependencies"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("unrelated results and inspections cannot erase unreviewed indirect dependencies", async () => {
  const f = fixture();
  try {
    await f.run("A = 1\nB = 1");
    await f.inspect(["A", "B"]);
    const change = await f.run("A = 2");
    const before = await f.run('eval("A")', { agent: true });
    assert.equal(before.status, "not_executed");
    const unrelated = await f.run("print(1)", { agent: true });
    f.observe(unrelated, [], f.conversationId, "execution_result");
    await f.run("B = 2");
    await f.inspect(["B"]);
    await f.inspect([]);
    const after = await f.run('eval("A")', { agent: true });
    assert.equal(after.status, "not_executed");
    assert.ok(after.contextCheck!.issues.some((issue) => issue.executionId === change.id));
    const accepted = await f.run('eval("A")', { agent: true, acknowledgment: acknowledge(after) });
    assert.equal(accepted.status, "succeeded");
    f.observe(accepted, [], f.conversationId, "execution_result");
    // Acknowledgment applies to the warned code, not to different future code.
    assert.equal((await f.run('eval("A + 1")', { agent: true })).status, "not_executed");
    await f.inspect(["A"]);
    assert.equal((await f.run('eval("A + 1")', { agent: true })).status, "succeeded");
  } finally {
    await f.close();
  }
});

test("an old advanced anchor is migrated without discarding pending change evidence", async () => {
  const f = fixture();
  try {
    await f.run("A = 1");
    await f.inspect();
    await f.run("A = 2");
    f.store.db.exec("UPDATE runtime_anchors SET seq=1000");
    f.store.delete("migration", "observation-coverage");
    const { StaleContext } = await import("../src/stale-context.ts");
    new StaleContext(f.store, f.service.repository);
    assert.equal((await f.run('eval("A")', { agent: true })).status, "not_executed");
  } finally {
    await f.close();
  }
});

test("fresh data previews allow built-in calls after opaque activity without hiding explicit callable changes", async () => {
  const f = fixture();
  try {
    await f.run("A = 1");
    await f.inspect();
    await f.run("print('A' in globals())");
    assert.equal((await f.run("print(A)", { agent: true })).status, "not_executed");
    await f.inspect();
    assert.equal((await f.run("print(A)", { agent: true })).status, "succeeded");
    assert.equal((await f.run('eval("A")', { agent: true })).status, "not_executed");
    await f.run("print = lambda x: x");
    assert.equal((await f.run("print(A)", { agent: true })).status, "not_executed");
  } finally {
    await f.close();
  }
});

test("a warning releases the queue; cancelled queued code creates no change evidence", async () => {
  const f = fixture();
  try {
    await f.run("A = 1");
    await f.inspect();
    const pause = f.pause();
    const first = f.run('print("hello")');
    await pause.entered;
    const cancelled = f.service.submit({ language: "python", actor: "human", code: "A = 5" });
    await f.service.cancel(cancelled.id);
    pause.release();
    await first;
    assert.equal((await f.run("print(A)", { agent: true })).status, "succeeded");
    await f.run("A = 2");
    const warning = f.run("print(A)", { agent: true });
    const human = f.run("B = 3");
    assert.equal((await warning).status, "not_executed");
    assert.equal((await human).status, "succeeded");
  } finally {
    await f.close();
  }
});

test("interrupted dispatched code can invalidate an observation, unlike cancelled queued code", async () => {
  const f = fixture();
  try {
    await f.run("A = 1");
    await f.inspect();
    const pause = f.pause();
    const human = f.service.submit({ language: "python", actor: "human", code: "A = 2" });
    await pause.entered;
    await f.service.cancel(human.id);
    pause.release();
    assert.equal((await f.service.wait(human.id)).status, "interrupted");
    const warning = await f.run("print(A)", { agent: true });
    assert.equal(warning.status, "not_executed");
    assert.ok(warning.contextCheck!.issues.some((issue) => issue.executionId === human.id));
  } finally {
    await f.close();
  }
});

test("incomplete parsing is explicit uncertainty and warning details stay out of history snapshots", async () => {
  const f = fixture();
  try {
    const warning = await f.run("A = (", { agent: true });
    assert.equal(warning.status, "not_executed");
    assert.equal(f.calls.length, 0);
    assert.ok(warning.contextCheck!.issues.some((issue) => issue.kind === "unknown"));
    assert.equal(f.service.repository.list().items[0].contextCheck, undefined);
    assert.ok(
      f.service.get(warning.id)!.contextCheck,
      "Full evidence remains retrievable with the exact execution",
    );
  } finally {
    await f.close();
  }
});
