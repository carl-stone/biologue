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

test("title-cache failure cannot strand a native accepted run", timeout, async () => {
  const f = await fixture();
  const put = f.store.put.bind(f.store);
  try {
    let injected = false;
    f.store.put = (kind, id, value) => {
      if (!injected && kind === "conversation") {
        injected = true;
        throw new Error("Title cache unavailable");
      }
      return put(kind, id, value);
    };
    f.faux.setResponses([fauxAssistantMessage("Answered.")]);
    assert.equal((await f.run("Accepted despite a title-cache failure")).status, "completed");
    assert.ok(injected);
    assert.equal(f.requests.length, 1);
  } finally {
    f.store.put = put;
    await f.close();
  }
});

test(
  "scientific setup failure after acceptance is terminal and cannot resume as unfinished work",
  timeout,
  async () => {
    const f = await fixture();
    const begin = f.execution.context.begin.bind(f.execution.context);
    try {
      f.execution.context.begin = () => {
        throw new Error("Scientific source unavailable");
      };
      const finished = await f.run("Protect scientific provenance");
      assert.equal(finished.status, "failed");
      assert.match(finished.error!, /Scientific source unavailable/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.supervisor.isActive(), false);
      const state = await f.supervisor.harness.snapshot(
        RunsDoc,
        (await f.sessions.get(f.conversationId)).id,
        ctx,
      );
      assert.equal(state!.current!.run.status, "failed");
      assert.ok(state!.current!.run.finishedAt);
    } finally {
      f.execution.context.begin = begin;
      await f.close();
    }
  },
);

test(
  "a failed display write after native acceptance cannot strand or reject a run",
  timeout,
  async () => {
    const f = await fixture();
    const prepare = f.store.db.prepare.bind(f.store.db);
    try {
      let failed = false;
      f.store.db.prepare = ((sql: string) => {
        if (!failed && sql.startsWith("INSERT INTO chat_messages")) {
          failed = true;
          throw new Error("Chat projection unavailable");
        }
        return prepare(sql);
      }) as typeof f.store.db.prepare;
      f.faux.setResponses([fauxAssistantMessage("The accepted input was answered.")]);
      const finished = f.finished();
      const run = await f.supervisor.start(f.conversationId, "Accepted scientific request");
      assert.equal((await finished).status, "completed");
      assert.ok(failed);
      assert.equal(f.requests.length, 1);
      assert.equal(
        (await f.sessions.page(f.conversationId)).items.filter((m) => m.role === "user").length,
        1,
      );
      assert.equal(
        (await f.supervisor.harness.snapshot(
          RunsDoc,
          (await f.sessions.get(f.conversationId)).id,
          ctx,
        ))!.current!.run.status,
        "completed",
      );
    } finally {
      f.store.db.prepare = prepare;
      await f.close();
    }
  },
);

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
    const put = f.store.put.bind(f.store);
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
      f.store.put = (kind, id, value) => {
        if (kind === "durable-display") throw new Error("Projection unavailable");
        return put(kind, id, value);
      };
      f.faux.setResponses([fauxAssistantMessage("Retained in Pi.")]);
      const failed = await f.run("Discuss the observation.");
      assert.equal(failed.status, "failed");
      assert.equal(failed.endReason, "integration_error");
      assert.doesNotMatch(failed.error!, /Projection unavailable/);
      assert.match(failed.error!, /Disposal failed/);
      f.pi.create = create;
      f.store.put = put;
      f.faux.setResponses([fauxAssistantMessage("The conversation is usable again.")]);
      assert.equal((await f.run("Continue.")).status, "completed");
    } finally {
      f.pi.create = create;
      f.store.put = put;
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
      assert.doesNotMatch(result.error!, /Run disk failure/);
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
  "a failed final display write preserves the native successful outcome and releases the conversation",
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
      assert.equal(result.status, "completed");
      assert.equal(result.error, undefined);
      assert.ok(failed);
      assert.equal(f.store.get<any>("run", result.id).status, "completed");
      f.faux.setResponses([fauxAssistantMessage("Another response.")]);
      assert.equal((await f.run("Continue.")).status, "completed");
    } finally {
      f.store.put = put;
      await f.close();
    }
  },
);

test("unused request-journal failures cannot block native model dispatch", timeout, async () => {
  const f = await fixture();
  const put = f.store.put.bind(f.store);
  try {
    f.store.put = (kind, id, value) => {
      if (kind === "run-request") throw new Error("The removed journal must not be used");
      return put(kind, id, value);
    };
    f.faux.setResponses([fauxAssistantMessage("Completed without a second request journal")]);
    assert.equal((await f.run("Answer with the native harness")).status, "completed");
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.list("run-request").length, 0);
  } finally {
    f.store.put = put;
    await f.close();
  }
});
