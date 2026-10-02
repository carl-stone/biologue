import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { Permissions } from "../src/permissions.ts";
import { InputsDoc, RunsDoc } from "../src/durable-state.ts";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture } from "./helpers/pi-fixture.ts";

const timeout = { timeout: 20_000 };

test("failed permission writes reject all waiters, including aborts, and never grant execution", async () => {
  const store = new Store(":memory:");
  const events = new Events();
  const observed: unknown[] = [];
  events.subscribe((event) => observed.push(event));
  const permissions = new Permissions(store, events);
  const put = store.put.bind(store);
  store.put = (kind, id, value) => {
    if (kind === "permission") throw new Error("Disk full");
    return put(kind, id, value);
  };
  try {
    const input = { runId: "run", tool: "execute_code", description: "Proposed code" };
    const controller = new AbortController();
    const requested = [
      permissions.request(input),
      permissions.request(input),
      permissions.request(input, controller.signal),
    ];
    const settled = Promise.allSettled(requested);
    const [allowed] = permissions.list();
    assert.throws(() => permissions.decide(allowed.id, true), /Disk full/);
    assert.doesNotThrow(() => controller.abort());
    assert.throws(() => permissions.cancelRun("run"), /cancelled permission decisions/);
    const results = await settled;
    assert.ok(
      results.every(
        (result) => result.status === "rejected" && /Disk full/.test(result.reason.message),
      ),
    );
    assert.equal(permissions.list().length, 0);
    assert.equal(permissions.decide(allowed.id, true), false);
    assert.equal(
      observed.filter(
        (event: any) => event.type === "permission-resolved" && event.error.includes("Disk full"),
      ).length,
      3,
    );
  } finally {
    store.close();
  }
});

test(
  "native startup commits input and run metadata together and rejects failed admission",
  timeout,
  async () => {
    const f = await fixture();
    const conversation = await f.sessions.get(f.conversationId);
    const commit = conversation.commit.bind(conversation);
    try {
      conversation.commit = async () => {
        throw new Error("Native commit failed");
      };
      await assert.rejects(
        f.supervisor.start(f.conversationId, "Retain the matched control."),
        /Native commit failed/,
      );
      assert.equal(f.supervisor.isActive(), false);
      assert.equal(f.requests.length, 0);
      conversation.commit = commit;
      assert.equal((await f.sessions.pending(f.conversationId)).length, 0);
      let atomic = false;
      const detach = f.supervisor.harness.subscribeCommits((publication) => {
        const kinds = publication.changes
          .filter((c) => c.type === "document")
          .map((c) => c.record.kind);
        if (kinds.includes(InputsDoc.definition.kind) && kinds.includes(RunsDoc.definition.kind))
          atomic = true;
      });
      f.faux.setResponses([fauxAssistantMessage("The matched control is recorded.")]);
      assert.equal((await f.run("Retain the matched control.")).status, "completed");
      detach();
      assert.ok(atomic);
      assert.equal(f.store.list("input-receipt").length, 0);
      assert.equal(f.store.list("run-input").length, 0);
      assert.equal(
        (await f.supervisor.harness.snapshot(InputsDoc, conversation.id, ctx))!.receipts.length,
        1,
      );
    } finally {
      conversation.commit = commit;
      await f.close();
    }
  },
);

test(
  "disposal and publication failures cannot strand an agent run or reject its background task",
  timeout,
  async () => {
    const f = await fixture();
    const create = f.pi.create.bind(f.pi);
    const publish = f.sessions.publishMessages.bind(f.sessions);
    try {
      f.pi.create = async (input) => {
        const session = await create(input);
        const dispose = session.stop.bind(session);
        session.stop = async () => {
          await dispose();
          throw new Error("Disposal failed");
        };
        return session;
      };
      f.sessions.publishMessages = async () => {
        throw new Error("Projection unavailable");
      };
      f.faux.setResponses([fauxAssistantMessage("Retained in Pi.")]);
      const failed = await f.run("Discuss the observation.");
      assert.equal(failed.status, "failed");
      assert.equal(failed.endReason, "integration_error");
      assert.match(failed.error!, /Projection unavailable/);
      assert.match(failed.error!, /Disposal failed/);
      f.pi.create = create;
      f.sessions.publishMessages = publish;
      f.faux.setResponses([fauxAssistantMessage("The conversation is usable again.")]);
      assert.equal((await f.run("Continue.")).status, "completed");
    } finally {
      f.pi.create = create;
      f.sessions.publishMessages = publish;
      await f.close();
    }
  },
);

test(
  "cancellation settles tools despite failed permission and run persistence",
  timeout,
  async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("execute_code", {
            language: "python",
            code: "never_execute()",
            reason: "Test cancellation",
          }),
          { stopReason: "toolUse" },
        ),
      ]);
      const requested = f.requested(),
        finished = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Consider an action.");
      await requested;
      let runWriteFailed = false;
      f.store.put = (kind, id, value) => {
        if (kind === "permission") throw new Error("Permission disk failure");
        if (kind === "run" && !runWriteFailed) {
          runWriteFailed = true;
          throw new Error("Run disk failure");
        }
        return put(kind, id, value);
      };
      await f.supervisor.cancel(run.id);
      const result = await finished;
      assert.equal(result.status, "cancelled");
      assert.ok(result.finishedAt);
      assert.match(result.error!, /permission decisions/);
      assert.match(result.error!, /Run disk failure/);
      assert.equal(f.permissions.list().length, 0);
      assert.deepEqual(f.calls, []);
      f.store.put = put;
      f.faux.setResponses([fauxAssistantMessage("Ready.")]);
      assert.equal((await f.run("Continue.")).status, "completed");
    } finally {
      f.store.put = put;
      await f.close();
    }
  },
);

test(
  "a failed final run write is reported live and releases the conversation",
  timeout,
  async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    try {
      let failed = false;
      f.store.put = (kind, id, value) => {
        if (kind === "run" && (value as any).finishedAt && !failed) {
          failed = true;
          throw new Error("Final record failed");
        }
        return put(kind, id, value);
      };
      f.faux.setResponses([fauxAssistantMessage("A response.")]);
      const result = await f.run("Discuss.");
      assert.equal(result.status, "failed");
      assert.match(result.error!, /Final record failed/);
      assert.equal(f.store.get<any>("run", result.id).status, "failed");
      f.faux.setResponses([fauxAssistantMessage("Another response.")]);
      assert.equal((await f.run("Continue.")).status, "completed");
    } finally {
      f.store.put = put;
      await f.close();
    }
  },
);

test(
  "failed model-context provenance stops provider dispatch and scientific tools",
  timeout,
  async () => {
    const f = await fixture();
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("execute_code", {
            language: "python",
            code: "must_not_dispatch()",
            reason: "Test a failed context record",
          }),
          { stopReason: "toolUse" },
        ),
      ]);
      const put = f.store.put.bind(f.store);
      f.store.put = (kind, id, value) => {
        if (kind === "run-request") throw new Error("Context storage unavailable");
        return put(kind, id, value);
      };
      const run = await f.run("Inspect the shared object.");
      assert.equal(run.status, "failed");
      assert.equal(run.endReason, "integration_error");
      assert.match(run.error!, /Context storage unavailable/);
      assert.equal(f.faux.state.callCount, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(f.permissions.list().length, 0);
    } finally {
      await f.close();
    }
  },
);
