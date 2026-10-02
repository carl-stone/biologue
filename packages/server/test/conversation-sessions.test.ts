import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@biologue/protocol";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { ContextService } from "../src/context.ts";
import { ConversationSessions } from "../src/conversation-sessions.ts";
import { createApp } from "../src/app.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biologue-chat-"));
  const store = new Store(join(root, "state.sqlite"));
  const events = new Events();
  const context = new ContextService(store, events);
  const conversation = context.createConversation("History");
  const sessions = new ConversationSessions(store, events);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  sessions.bind(harness);
  return {
    root,
    store,
    events,
    context,
    conversation,
    sessions,
    harness,
    close: async () => {
      sessions.unbind();
      await harness.close(ctx);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function append(sessions: ConversationSessions, id: string, text: string) {
  const c = await sessions.get(id);
  return c.commit(
    (tx) => tx.appendEntry(c.id, { kind: "pi.assistant", model: [fauxAssistantMessage(text)] }),
    ctx,
  );
}

test("conversation pages remain bounded and isolate histories and tied timestamps during new arrivals", async () => {
  const f = await fixture();
  try {
    const id = f.conversation.id;
    for (let i = 0; i < 135; i++) await append(f.sessions, id, `Observation ${i}`);
    const first = await f.sessions.page(id);
    assert.equal(first.items.length, 50);
    assert.equal(first.items[0].text, "Observation 85");
    await append(f.sessions, id, "New arrival");
    const second = await f.sessions.page(id, 50, first.next);
    const third = await f.sessions.page(id, 50, second.next);
    assert.equal(third.items.length, 35);
    assert.equal(third.next, undefined);
    const all = [...third.items, ...second.items, ...first.items];
    assert.equal(new Set(all.map((m) => m.id)).size, 135);
    assert.deepEqual(
      all.map((m) => m.text),
      Array.from({ length: 135 }, (_, i) => `Observation ${i}`),
    );
    const other = f.context.createConversation("Other");
    await assert.rejects(f.sessions.page(other.id, 50, first.next), /cursor/);
    assert.deepEqual((await f.sessions.page(other.id)).items, []);
    await assert.rejects(f.sessions.page(id, 50, "bad"), /cursor/);
  } finally {
    await f.close();
  }
});

test("the display index rebuilds from durable history and receipts without modifying raw history", async () => {
  const f = await fixture();
  try {
    const id = f.conversation.id,
      c = await f.sessions.get(id);
    const receipt = f.sessions.accept(id, "Accepted input", "run");
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "biologue.import.user",
          model: [{ role: "user", content: receipt.text, timestamp: Date.now() }],
          data: JSON.parse(JSON.stringify({ display: receipt })),
        }),
      ctx,
    );
    await append(f.sessions, id, "Canonical response");
    const pending = f.sessions.accept(id, "Unsent correction", "run");
    const before = (await f.sessions.page(id)).items;
    const raw = await f.sessions.history(id);
    f.store.db.exec("DELETE FROM chat_messages; DELETE FROM chat_delivered;");
    f.sessions.unbind();
    const reopened = new ConversationSessions(f.store, f.events);
    reopened.bind(f.harness);
    const after = (await reopened.page(id)).items;
    const values = (items: Message[]) => items.map(({ sequence: _s, ...m }) => m);
    assert.deepEqual(values(after), values(before));
    assert.deepEqual(
      reopened.pending(id).map((m) => m.id),
      [pending.id],
    );
    assert.deepEqual(await reopened.history(id), raw);
    reopened.unbind();
  } finally {
    await f.close();
  }
});

test("history forks inherit only the selected prefix and keep the source and pending receipts independent", async () => {
  const f = await fixture();
  try {
    const id = f.conversation.id;
    const ancestor = await append(f.sessions, id, "Shared ancestor");
    await append(f.sessions, id, "Source response");
    f.sessions.accept(id, "Pending correction", "run");
    const child = f.context.createConversation("Branch");
    await f.sessions.fork(id, child.id, String(ancestor.id));
    await append(f.sessions, child.id, "Child response");
    assert.deepEqual(
      (await f.sessions.page(child.id)).items.map((m) => m.text),
      ["Shared ancestor", "Child response"],
    );
    assert.deepEqual(
      (await f.sessions.page(id)).items.map((m) => m.text),
      ["Shared ancestor", "Source response", "Pending correction"],
    );
    assert.equal(f.sessions.pending(child.id).length, 0);
    assert.equal(f.sessions.pending(id).length, 1);
  } finally {
    await f.close();
  }
});

test("workspace snapshots keep dormant conversations unopened and messages page one selected conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-chat-api-"));
  const f = await createApp({
    project: root,
    stateDir: join(root, ".biologue"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  try {
    const other = f.context.createConversation("Dormant");
    const selected = f.context.createConversation("Selected");
    for (let i = 0; i < 80; i++) await append(f.sessions, selected.id, `Reply ${i}`);
    const snapshot = await f.app.inject({ method: "GET", url: "/api/snapshot" });
    assert.equal(snapshot.statusCode, 200);
    assert.equal("messages" in snapshot.json(), false);
    const response = await f.app.inject({
      method: "GET",
      url: `/api/conversations/${selected.id}/messages?limit=20`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items.length, 20);
    assert.ok(response.json().next);
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/conversations/${selected.id}/messages?before=bad`,
        })
      ).statusCode,
      400,
    );
    const missing = await f.app.inject({
      method: "GET",
      url: `/api/conversations/${other.id}/messages`,
    });
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missing.json().items, []);
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent correction restoration commits one entry despite repeated display failures", async () => {
  const f = await fixture();
  const put = f.store.put.bind(f.store);
  try {
    const input = f.sessions.accept(
      f.conversation.id,
      "Donor is the corrected experimental unit",
      "stopped-run",
    );
    f.store.put = (kind, id, value) => {
      if (kind === "durable-display") throw new Error("Display index unavailable");
      return put(kind, id, value);
    };
    const results = await Promise.allSettled([
      f.sessions.restore(input),
      f.sessions.restore(input),
    ]);
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.equal((await f.sessions.history(input.conversationId)).length, 1);
    f.store.put = put;
    await f.sessions.restore(input);
    const history = await f.sessions.history(input.conversationId);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].model, [
      {
        role: "user",
        content: [{ type: "text", text: input.text }],
        timestamp: Date.parse(input.createdAt),
      },
    ]);
    assert.equal(f.sessions.pending(input.conversationId).length, 0);
    assert.equal((await f.sessions.page(input.conversationId)).items[0].id, input.id);
  } finally {
    f.store.put = put;
    await f.close();
  }
});
