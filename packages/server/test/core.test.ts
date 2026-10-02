import { OutputService } from "../src/outputs.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Document, Execution, Language, Output } from "@biologue/protocol";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { Documents, digest } from "../src/documents.ts";
import { ContextService } from "../src/context.ts";
import { ExecutionRepository } from "../src/execution-repository.ts";
import { ExecutionService, type KernelBackend } from "../src/execution.ts";
import { Permissions } from "../src/permissions.ts";
import { setTimeout as delay } from "node:timers/promises";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biologue-core-"));
  const store = new Store(join(root, "state.sqlite"));
  const events = new Events();
  return {
    root,
    store,
    events,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
class ControlledKernel implements KernelBackend {
  calls: { language: Language; code: string }[] = [];
  releases = new Map<Language, () => void>();
  async execute(
    language: Language,
    code: string,
    output: Parameters<KernelBackend["execute"]>[2],
    started: Parameters<KernelBackend["execute"]>[3],
    signal: AbortSignal,
  ) {
    started({ sessionId: language, kernelId: `${language}-kernel` });
    this.calls.push({ language, code });
    await new Promise<void>((resolve) => this.releases.set(language, resolve));
    if (signal.aborted) throw new Error("Interrupted");
    output({ kind: "stream", text: code });
  }
  async interrupt(language: Language) {
    this.releases.get(language)?.();
  }
  finish(language: Language) {
    this.releases.get(language)?.();
  }
  async waitForCalls(count: number) {
    for (let i = 0; i < 2000 && this.calls.length < count; i++) await delay(5);
    assert.ok(this.calls.length >= count, `Expected ${count} kernel dispatches`);
  }
}

test("human and agent share a FIFO per language; R can proceed independently", async () => {
  const f = fixture();
  try {
    const kernel = new ControlledKernel();
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    const human = service.submit({ language: "python", actor: "human", code: "sample = 1\n" });
    const agent = service.submit({ language: "python", actor: "agent", code: "sample += 1\n" });
    const other = service.submit({ language: "r", actor: "human", code: "sample <- 3" });
    await kernel.waitForCalls(2);
    assert.deepEqual(
      kernel.calls.map((call) => call.code),
      [human.code, other.code],
    );
    assert.equal(service.get(agent.id)?.status, "queued");
    kernel.finish("python");
    const first = await service.wait(human.id);
    await kernel.waitForCalls(3);
    assert.equal(kernel.calls[2].code, agent.code);
    assert.equal(first.codeHash, digest("sample = 1\n"));
    const captured = service.outputs.references(first.id)[0];
    assert.equal(service.outputs.get(captured.id)?.executionId, human.id);
    assert.equal(service.outputs.get(captured.id)?.text, first.code);
    kernel.finish("python");
    kernel.finish("r");
    const [second, third] = await Promise.all([service.wait(agent.id), service.wait(other.id)]);
    assert.equal(first.kernelId, second.kernelId);
    assert.notEqual(second.kernelId, third.kernelId);
  } finally {
    f.close();
  }
});

test("cancelling an agent run removes queued work before interrupting active work", async () => {
  const f = fixture();
  try {
    const kernel = new ControlledKernel();
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    const active = service.submit({
      language: "python",
      actor: "agent",
      code: "long task",
      runId: "run",
    });
    const queued = service.submit({
      language: "python",
      actor: "agent",
      code: "must not run",
      runId: "run",
    });
    const human = service.submit({ language: "python", actor: "human", code: "next human task" });
    await kernel.waitForCalls(1);
    await service.cancelRun("run");
    assert.equal((await service.wait(active.id)).status, "interrupted");
    assert.equal((await service.wait(queued.id)).status, "cancelled");
    await kernel.waitForCalls(2);
    assert.deepEqual(
      kernel.calls.map((call) => call.code),
      ["long task", "next human task"],
    );
    kernel.finish("python");
    assert.equal((await service.wait(human.id)).status, "succeeded");
  } finally {
    f.close();
  }
});

test("normal kernel completion after cancellation is retained without claiming interruption", async () => {
  const f = fixture();
  let finish!: () => void;
  let dispatch!: () => void;
  const started = new Promise<void>((resolve) => (dispatch = resolve));
  const service = new ExecutionService(
    f.store,
    f.events,
    {
      execute: async (_language, code, output, identity) => {
        identity({ sessionId: "r-session", kernelId: "r-kernel" });
        dispatch();
        await new Promise<void>((resolve) => (finish = resolve));
        output({ kind: "stream", text: "A later statement completed.\n" });
        assert.equal(code, "Sys.sleep(60); later_statement <- TRUE");
      },
      interrupt: async () => finish(),
    },
    new OutputService(f.store, f.events, join(f.root, "artifacts")),
  );
  try {
    const record = service.submit({
      language: "r",
      actor: "human",
      code: "Sys.sleep(60); later_statement <- TRUE",
    });
    await started;
    await service.cancel(record.id);
    const completed = await service.wait(record.id);
    assert.equal(completed.status, "succeeded");
    assert.match(completed.error!, /Cancellation was requested.*normal completion/);
    assert.equal(completed.code, record.code);
    assert.equal(service.outputs.raw(record.id)[0].text, "A later statement completed.\n");
  } finally {
    await service.close();
    f.close();
  }
});

for (const outcome of ["succeeded", "setup_failed", "restarted"])
  test(`session setup is recorded and guards exact source (${outcome})`, async () => {
    const f = fixture();
    const setupCode = "install_interrupt_handler()";
    const calls: string[] = [];
    const kernel: KernelBackend = {
      setupCode: (language) => (language === "r" ? setupCode : undefined),
      execute: async (_language, code, output, started) => {
        started({
          sessionId: "r-session",
          kernelId: "r-kernel",
          kernelGeneration: code !== setupCode && outcome === "restarted" ? "new" : "original",
        });
        calls.push(code);
        if (code === setupCode && outcome === "setup_failed") throw new Error("Setup failed");
        output({ kind: "stream", text: code });
      },
      interrupt: async () => {},
    };
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    try {
      const code = "x <- 2\n\n";
      const document = { path: "analysis.R", version: 7 };
      const record = await service.wait(
        service.submit({ language: "r", actor: "human", code, document }).id,
      );
      assert.equal(record.code, code);
      assert.equal(record.codeHash, digest(code));
      assert.deepEqual(record.document, document);
      assert.deepEqual(calls, outcome === "succeeded" ? [setupCode, code] : [setupCode]);
      assert.equal(record.status, outcome === "succeeded" ? "succeeded" : "failed");
      if (outcome !== "succeeded") assert.match(record.error!, /[Cc]ode was not run/);
      const setups = service.repository.list().items.filter((item) => item.purpose === "setup");
      assert.equal(setups.length, 1);
      const setup = service.get(setups[0].id)!;
      assert.equal(setup.actor, "system");
      assert.equal(setup.code, setupCode);
      assert.equal(setup.codeHash, digest(setupCode));
      assert.equal(setup.status, outcome === "setup_failed" ? "failed" : "succeeded");
      assert.deepEqual(service.repository.unfinished(), []);
    } finally {
      await service.close();
      f.close();
    }
  });

test("cancelling an agent during session setup prevents its scientific code from dispatching", async () => {
  const f = fixture();
  const kernel = new ControlledKernel() as ControlledKernel & KernelBackend;
  kernel.setupCode = (language) => (language === "r" ? "configure_interrupts()" : undefined);
  const service = new ExecutionService(
    f.store,
    f.events,
    kernel,
    new OutputService(f.store, f.events, join(f.root, "artifacts")),
  );
  try {
    const record = service.submit({
      language: "r",
      actor: "agent",
      runId: "stopped-agent",
      code: "must_not_run <- TRUE",
    });
    await kernel.waitForCalls(1);
    await service.cancelRun("stopped-agent");
    assert.deepEqual(
      kernel.calls.map((item) => item.code),
      ["configure_interrupts()"],
    );
    assert.equal((await service.wait(record.id)).status, "cancelled");
    const setup = service.repository.list().items.find((item) => item.purpose === "setup")!;
    assert.equal(setup.status, "interrupted");
  } finally {
    await service.close();
    f.close();
  }
});

test("unfinished work is marked abandoned after restart and never replayed", () => {
  const f = fixture();
  try {
    new ExecutionRepository(f.store).create({
      id: "old",
      code: "unknown side effects",
      codeHash: "hash",
      codePreview: "unknown side effects",
      language: "python",
      actor: "human",
      purpose: "analysis",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    const kernel = new ControlledKernel();
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    assert.equal(service.get("old")?.status, "abandoned");
    assert.equal(kernel.calls.length, 0);
  } finally {
    f.close();
  }
});

test("document revisions preserve exact buffers and reject stale edits, disk changes, and external paths", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "biologue-outside-"));
  try {
    writeFileSync(join(f.root, "analysis.py"), "x = 1\n");
    writeFileSync(join(outside, "private.py"), "private");
    symlinkSync(join(outside, "private.py"), join(f.root, "linked.py"));
    const documents = new Documents(f.root, f.store, f.events);
    const first = documents.open("analysis.py");
    const edited = documents.edit(first.path, "x = 2\n", first.version);
    assert.equal(readFileSync(join(f.root, first.path), "utf8"), "x = 1\n");
    assert.throws(() => documents.edit(first.path, "overwrite", first.version), /changed/);
    documents.verifyReference(first.path, edited.version, "x = 2\n");
    assert.throws(
      () => documents.verifyReference(first.path, edited.version, "different"),
      /exact/,
    );
    assert.equal(documents.save(first.path, edited.version).savedVersion, edited.version);
    writeFileSync(join(f.root, first.path), "external change");
    const refreshed = documents.open(first.path);
    assert.equal(refreshed.content, "external change");
    assert.equal(refreshed.version, edited.version + 1);
    assert.throws(() => documents.save(first.path, edited.version), /changed/);
    assert.throws(() => documents.open("../private.py"), /inside/);
    assert.throws(() => documents.open("linked.py"), /outside/);
    assert.equal(f.store.get<Document>("document-revision", "analysis.py:1")?.content, "x = 1\n");
  } finally {
    f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("creating and saving nested documents creates project folders without traversing excluded paths", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "biologue-nested-outside-"));
  try {
    const documents = new Documents(f.root, f.store, f.events);
    const source = documents.createUntitled("text");
    const text = "Δ area is an observation, not functional rescue.\n";
    const edited = documents.edit(source.path, text, source.version);
    const saved = documents.saveAs(source.path, "notes/day 1/lab notes.txt", edited.version);
    assert.equal(saved.content, text);
    assert.equal(readFileSync(join(f.root, saved.path), "utf8"), text);
    assert.equal(documents.open(source.path).savedAs, saved.path);
    const created = documents.create("scripts/python/analysis.py");
    assert.equal(created.content, "");
    assert.ok(documents.list().includes(created.path));
    assert.throws(() => documents.saveAs(saved.path, saved.path, saved.version), /already/);
    symlinkSync(outside, join(f.root, "outside-link"));
    assert.throws(() => documents.create("outside-link/new/subfolder/file.txt"), /outside/);
    assert.equal(existsSync(join(outside, "new")), false);
    assert.throws(() => documents.create(".biologue/new/file.txt"), /Internal/);
    assert.equal(existsSync(join(f.root, ".biologue/new")), false);
    assert.throws(() => documents.create("../new/subfolder/file.txt"), /inside/);
  } finally {
    f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("research corrections persist with their earlier versions and detect concurrent edits", () => {
  const f = fixture();
  try {
    const context = new ContextService(f.store, f.events);
    context.update("Only appearance was measured.", 0);
    context.update("Correction: function was measured; the earlier note was wrong.", 1);
    assert.equal(
      f.store.get<{ text: string }>("context-revision", "1")?.text,
      "Only appearance was measured.",
    );
    assert.throws(() => context.update("stale", 1), /changed/);
    assert.equal(new ContextService(f.store, f.events).get().version, 2);
  } finally {
    f.close();
  }
});

test("permissions bind the reviewed code to one decision, and cancellation rejects pending work", async () => {
  const f = fixture();
  try {
    const permissions = new Permissions(f.store, f.events);
    const pending = permissions.request({
      runId: "run",
      tool: "execute_code",
      description: "Inspect",
      code: "exact\ncode",
    });
    const request = permissions.list()[0];
    assert.equal(request.code, "exact\ncode");
    assert.equal(permissions.decide(request.id, true), true);
    await pending;
    assert.equal(permissions.decide(request.id, true), false);
    const cancelled = permissions.request({
      runId: "run",
      tool: "execute_code",
      description: "More work",
    });
    const rejected = assert.rejects(cancelled, /declined|cancelled/);
    permissions.cancelRun("run");
    await rejected;
    assert.equal(permissions.list().length, 0);
  } finally {
    f.close();
  }
});

test("display slots reference the same immutable artifact read by an agent", () => {
  const f = fixture();
  try {
    const outputs = new OutputService(f.store, f.events, join(f.root, "artifacts"));
    const execution = { id: "run", language: "python" as const, kernelId: "kernel" };
    const original = outputs.append(execution, {
      kind: "display",
      displayId: "plot",
      data: { "text/plain": "old" },
    });
    const update = outputs.append(execution, {
      kind: "update",
      displayId: "plot",
      data: { "text/plain": "new" },
    });
    outputs.append(execution, { kind: "clear", wait: true });
    const visible = outputs.visible({ executionId: execution.id }).items;
    assert.equal(visible[0].slotId, original.id);
    assert.equal(visible[0].id, update.id);
    assert.equal(outputs.get(visible[0].id)?.data?.["text/plain"], "new");
    assert.equal(outputs.get(original.id)?.data?.["text/plain"], "old");
    const replacement = outputs.append(execution, { kind: "stream", text: "replacement" });
    assert.equal(outputs.visible({ executionId: execution.id }).items[0].id, replacement.id);
    assert.equal(outputs.count(execution.id), 4);
  } finally {
    f.close();
  }
});

test("external disk edits reconcile explicitly and an interrupted save recovers without stale hashes", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "analysis.py"), "initial");
    const documents = new Documents(f.root, f.store, f.events);
    const first = documents.open("analysis.py");
    const working = documents.edit(first.path, "working", first.version);
    writeFileSync(join(f.root, first.path), "external");
    const conflicted = documents.open(first.path);
    assert.equal(conflicted.content, "working");
    assert.equal(conflicted.diskConflict?.content, "external");
    assert.throws(() => documents.save(first.path, working.version), /changed on disk/);
    writeFileSync(join(f.root, first.path), "external again");
    assert.throws(
      () => documents.reconcile(first.path, working.version, digest("external"), "working"),
      /changed/,
    );
    const saved = documents.reconcile(
      first.path,
      working.version,
      digest("external again"),
      "working",
    );
    assert.equal(readFileSync(join(f.root, first.path), "utf8"), "working");
    const edit = documents.edit(first.path, "next", saved.version);
    // Simulate rename succeeding before the process could commit savedVersion/diskHash.
    writeFileSync(join(f.root, first.path), "next");
    const recovered = documents.open(first.path);
    assert.equal(recovered.savedVersion, edit.version);
    assert.equal(recovered.diskHash, digest("next"));
    assert.equal(recovered.diskConflict, undefined);
    documents.edit(first.path, "retained", recovered.version);
    writeFileSync(join(f.root, first.path), "disk choice");
    const disk = documents.reconcile(
      first.path,
      recovered.version + 1,
      digest("disk choice"),
      "disk",
    );
    assert.equal(disk.content, "disk choice");
    assert.equal(
      f.store.get<Document>("document-revision", `${first.path}:${recovered.version + 1}`)?.content,
      "retained",
    );
  } finally {
    f.close();
  }
});

test("document synchronization retries are idempotent and preserve exact revision identity", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "analysis.py"), "A");
    const documents = new Documents(f.root, f.store, f.events);
    documents.open("analysis.py");
    const first = documents.edit("analysis.py", "B", 1, "request-1");
    assert.equal(documents.edit("analysis.py", "B", 1, "request-1").version, first.version);
    assert.throws(() => documents.edit("analysis.py", "C", 1, "request-2"), /changed/);
    documents.verifyReference("analysis.py", first.version, "B");
  } finally {
    f.close();
  }
});

test("output capture sends bounded events without rewriting execution history or embedding payloads", async () => {
  const f = fixture();
  try {
    const events: import("@biologue/protocol").AppEvent[] = [];
    f.events.subscribe((event) => events.push(event));
    const kernel: KernelBackend = {
      interrupt: async () => {},
      execute: async (_lang, _code, output) => {
        for (let i = 0; i < 100; i++) output({ kind: "stream", text: `${i}:` + "x".repeat(4000) });
      },
    };
    const outputs = new OutputService(f.store, f.events, join(f.root, "artifacts"));
    const service = new ExecutionService(f.store, f.events, kernel, outputs);
    const record = await service.wait(
      service.submit({ language: "python", actor: "human", code: "exact source" }).id,
    );
    assert.equal(record.status, "succeeded");
    assert.equal(outputs.count(record.id), 100);
    assert.equal(events.filter((event) => event.type === "execution").length, 3);
    assert.ok(JSON.stringify(events).length < 30_000);
    assert.equal("outputs" in service.repository.list().items[0], false);
    assert.equal("code" in service.repository.list().items[0], false);
    assert.equal(outputs.raw(record.id)[99].text, "99:" + "x".repeat(4000));
    assert.equal(service.get(record.id)?.code, "exact source");
    const last = outputs.visible({ executionId: record.id, limit: 20 });
    assert.equal(last.items[0].sequence, 80);
    assert.equal(
      outputs.visible({ executionId: record.id, limit: 20, before: last.next }).items[0].sequence,
      60,
    );
  } finally {
    f.close();
  }
});

test("subscriber and persistence failures settle callers and leave the language queue usable", async () => {
  const f = fixture();
  try {
    const errors: unknown[] = [];
    const events = new Events((error) => errors.push(error));
    events.subscribe(() => {
      throw new Error("broken viewer");
    });
    const kernel = new ControlledKernel();
    const service = new ExecutionService(
      f.store,
      events,
      kernel,
      new OutputService(f.store, events, join(f.root, "artifacts")),
    );
    const first = service.submit({ language: "python", actor: "human", code: "first" });
    const second = service.submit({ language: "python", actor: "human", code: "second" });
    const update = service.repository.update.bind(service.repository);
    let fail = true;
    service.repository.update = (record) => {
      if (record.id === first.id && record.status === "succeeded" && fail) {
        fail = false;
        throw new Error("disk full");
      }
      update(record);
    };
    const rejected = assert.rejects(
      service.wait(first.id),
      /Could not record execution.*disk full/,
    );
    await kernel.waitForCalls(1);
    kernel.finish("python");
    await rejected;
    await kernel.waitForCalls(2);
    assert.equal(kernel.calls[1].code, "second");
    kernel.finish("python");
    assert.equal((await service.wait(second.id)).status, "succeeded");
    assert.ok(errors.length > 0);
    // A failure while recording the running state must not strand the active marker either.
    service.repository.update = (record) => {
      if (record.status === "running") throw new Error("running write failed");
      update(record);
    };
    const third = service.submit({ language: "python", actor: "human", code: "never sent" });
    assert.equal((await service.wait(third.id)).status, "failed");
    service.repository.update = update;
    const fourth = service.submit({ language: "python", actor: "human", code: "fourth" });
    await kernel.waitForCalls(3);
    kernel.finish("python");
    assert.equal((await service.wait(fourth.id)).status, "succeeded");
  } finally {
    f.close();
  }
});

test("shutdown cancels queued work and settles active human and agent executions before returning", async () => {
  const f = fixture();
  try {
    const kernel = new ControlledKernel();
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    const human = service.submit({ language: "python", actor: "human", code: "long human" });
    const agent = service.submit({ language: "r", actor: "agent", code: "long agent" });
    const queued = service.submit({ language: "python", actor: "human", code: "never start" });
    await kernel.waitForCalls(2);
    await service.close();
    assert.equal((await service.wait(human.id)).status, "interrupted");
    assert.equal((await service.wait(agent.id)).status, "interrupted");
    assert.equal((await service.wait(queued.id)).status, "cancelled");
    assert.equal(kernel.calls.length, 2);
    assert.throws(
      () => service.submit({ language: "python", actor: "human", code: "too late" }),
      /shutting down/,
    );
  } finally {
    f.close();
  }
});

test("a disconnected kernel cannot write late output after shutdown has abandoned its execution", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const kernel: KernelBackend = {
      interrupt: async () => {},
      execute: async (_lang, _code, output) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        output({ kind: "stream", text: "late" });
      },
    };
    const service = new ExecutionService(
      f.store,
      f.events,
      kernel,
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
    );
    const record = service.submit({ language: "python", actor: "human", code: "long" });
    for (let i = 0; i < 2000 && !release; i++) await delay(5);
    assert.ok(release);
    await service.close(5);
    assert.equal((await service.wait(record.id)).status, "abandoned");
    assert.equal(service.outputs.count(record.id), 0);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.outputs.count(record.id), 0);
  } finally {
    f.close();
  }
});

test("display updates across executions share a kernel-scoped projection without changing old artifacts", () => {
  const f = fixture();
  try {
    const outputs = new OutputService(f.store, f.events, join(f.root, "artifacts"));
    const first = {
      id: "first",
      language: "python" as const,
      kernelId: "one",
      kernelGeneration: "generation-one",
    };
    const old = outputs.append(first, {
      kind: "display",
      displayId: "same",
      data: { "image/png": "old" },
    });
    outputs.append(
      { ...first, id: "different-kernel", kernelId: "two" },
      { kind: "display", displayId: "same", data: { "image/png": "unrelated" } },
    );
    const next = outputs.append(
      { ...first, id: "next" },
      { kind: "update", displayId: "same", data: { "image/png": "new" } },
    );
    assert.equal(outputs.visible({ executionId: first.id }).items[0].id, next.id);
    assert.equal(outputs.get(old.id)?.data?.["image/png"], "old");
    const unrelated = outputs.visible({ executionId: "different-kernel" }).items[0];
    assert.equal(outputs.get(unrelated.id)?.data?.["image/png"], "unrelated");
    outputs.append(
      { ...first, id: "restarted", kernelGeneration: "generation-two" },
      { kind: "update", displayId: "same", data: { "image/png": "after restart" } },
    );
    assert.equal(outputs.visible({ executionId: first.id }).items[0].id, next.id);
    const legacy = { id: "legacy", language: "python" as const, kernelId: "one" };
    const legacyOutput = outputs.append(legacy, {
      kind: "display",
      displayId: "same",
      data: { "image/png": "legacy" },
    });
    outputs.append(
      { ...legacy, id: "unknown-generation" },
      { kind: "update", displayId: "same", data: { "image/png": "unknown" } },
    );
    assert.equal(outputs.visible({ executionId: legacy.id }).items[0].id, legacyOutput.id);
  } finally {
    f.close();
  }
});

test("cancellation deadlines quarantine a session across restart until readiness is confirmed", async () => {
  const f = fixture();
  let release!: () => void;
  let ready = false;
  const calls: string[] = [];
  const kernel: KernelBackend = {
    async execute(language, code, output, started) {
      started({ sessionId: language, kernelId: language, kernelGeneration: "one" });
      calls.push(code);
      if (code === "A = 1")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      output({ kind: "stream", text: "result" });
    },
    async interrupt() {},
    async reconcile() {
      return ready;
    },
  };
  const outputs = new OutputService(f.store, f.events, join(f.root, "artifacts"));
  const service = new ExecutionService(f.store, f.events, kernel, outputs, 20);
  let reopened: ExecutionService | undefined;
  try {
    const active = service.submit({ language: "python", actor: "human", code: "A = 1" });
    while (!release) await delay(5);
    const queued = service.submit({ language: "python", actor: "human", code: "must_not_run()" });
    await Promise.all([service.cancel(active.id), service.cancel(active.id)]);
    assert.equal((await service.wait(active.id)).status, "completion_unknown");
    assert.equal((await service.wait(queued.id)).status, "failed");
    assert.equal(service.get(active.id)?.kernelUncertain, true);
    assert.equal(
      (
        await service.wait(
          service.submit({ language: "r", actor: "human", code: "other_language" }).id,
        )
      ).status,
      "succeeded",
    );
    await service.close();
    reopened = new ExecutionService(f.store, f.events, kernel, outputs, 20);
    const blocked = await reopened.wait(
      reopened.submit({ language: "python", actor: "human", code: "still_blocked()" }).id,
    );
    assert.equal(blocked.status, "failed");
    assert.deepEqual(calls, ["A = 1", "other_language"]);
    release();
    await delay(0);
    assert.equal(outputs.count(active.id), 0, "Late callbacks cannot alter the unknown execution");
    ready = true;
    const next = await reopened.wait(
      reopened.submit({ language: "python", actor: "human", code: "fresh()" }).id,
    );
    assert.equal(next.status, "succeeded");
    assert.equal(reopened.get(active.id)?.kernelUncertain, false);
    assert.equal(reopened.get(active.id)?.status, "completion_unknown");
  } finally {
    release?.();
    await service.close();
    await reopened?.close();
    f.close();
  }
});

test(
  "a stalled readiness check is bounded and late completion cannot release a newer execution slot",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const holds = new Map<string, () => void>();
    const calls: string[] = [];
    let ready = false;
    const kernel: KernelBackend = {
      async execute(language, code, output, started) {
        started({ sessionId: language, kernelId: language, kernelGeneration: "one" });
        calls.push(code);
        await new Promise<void>((resolve) => holds.set(code, resolve));
        output({ kind: "stream", text: code });
      },
      async interrupt() {},
      reconcile: () => (ready ? Promise.resolve(true) : new Promise(() => {})),
    };
    const outputs = new OutputService(f.store, f.events, join(f.root, "artifacts"));
    const service = new ExecutionService(f.store, f.events, kernel, outputs, 20);
    const submit = (code: string) => service.submit({ language: "python", actor: "human", code });
    try {
      const old = submit("old()");
      while (!holds.has("old()")) await delay(1);
      await service.cancel(old.id);
      const blocked = await service.wait(submit("blocked()").id);
      assert.equal(blocked.status, "failed");
      assert.equal(service.get(old.id)?.kernelUncertain, true);
      ready = true;
      const fresh = submit("fresh()");
      while (!holds.has("fresh()")) await delay(1);
      const queued = submit("queued()");
      holds.get("old()")!();
      await delay(10);
      assert.deepEqual(calls, ["old()", "fresh()"]);
      assert.equal(outputs.count(old.id), 0);
      assert.equal(service.get(queued.id)?.status, "queued");
      holds.get("fresh()")!();
      assert.equal((await service.wait(fresh.id)).status, "succeeded");
      while (!holds.has("queued()")) await delay(1);
      holds.get("queued()")!();
      assert.equal((await service.wait(queued.id)).status, "succeeded");
    } finally {
      for (const release of holds.values()) release();
      await service.close();
      f.close();
    }
  },
);

test(
  "cancellation during kernel connection cannot dispatch code later or quarantine an unused session",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    let connected!: () => void;
    let dispatched = false;
    const service = new ExecutionService(
      f.store,
      f.events,
      {
        async execute(language, _code, _output, started) {
          await new Promise<void>((resolve) => {
            connected = resolve;
          });
          started({ sessionId: language, kernelId: language });
          dispatched = true;
        },
        async interrupt() {},
      },
      new OutputService(f.store, f.events, join(f.root, "artifacts")),
      20,
    );
    try {
      const record = service.submit({ language: "python", actor: "human", code: "must_not_run()" });
      while (!connected) await delay(1);
      await service.cancel(record.id);
      assert.equal((await service.wait(record.id)).status, "cancelled");
      assert.equal(service.get(record.id)?.kernelUncertain, undefined);
      connected();
      await delay(0);
      assert.equal(dispatched, false);
    } finally {
      connected?.();
      await service.close();
      f.close();
    }
  },
);
