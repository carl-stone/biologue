import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Message, AppEvent } from "@biologue/protocol";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { ContextService } from "../src/context.ts";
import { ConversationSessions } from "../src/conversation-sessions.ts";
import { createApp } from "../src/app.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biologue-chat-"));
  const store = new Store(join(root, "state.sqlite"));
  const events = new Events();
  const context = new ContextService(store, events);
  const conversation = context.createConversation("History");
  const sessions = new ConversationSessions(root, root, store, events);
  return {
    root,
    store,
    events,
    context,
    conversation,
    sessions,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("conversation pages are bounded, isolate histories and preserve ties and cursors during new arrivals", () => {
  const f = fixture();
  try {
    const id = f.conversation.id;
    const manager = f.sessions.get(id);
    for (let i = 0; i < 135; i++) manager.appendMessage(fauxAssistantMessage(`Observation ${i}`));
    const first = f.sessions.page(id);
    assert.equal(first.items.length, 50);
    assert.equal(first.items.at(-1)!.text, "Observation 134");
    assert.equal(first.items[0].text, "Observation 85");
    manager.appendMessage(fauxAssistantMessage("A new arrival"));
    const second = f.sessions.page(id, 50, first.next);
    const third = f.sessions.page(id, 50, second.next);
    assert.equal(third.items.length, 35);
    assert.equal(third.next, undefined);
    const all = [...third.items, ...second.items, ...first.items];
    assert.equal(new Set(all.map((message) => message.id)).size, 135);
    assert.deepEqual(
      all.map((message) => message.text),
      Array.from({ length: 135 }, (_, i) => `Observation ${i}`),
    );
    const other = f.context.createConversation("Other");
    assert.throws(() => f.sessions.page(other.id, 50, first.next), /cursor/);
    assert.deepEqual(f.sessions.page(other.id).items, []);
    assert.throws(() => f.sessions.page(id, 50, "malformed"), /cursor/);
  } finally {
    f.close();
  }
});

test("finalized entries update the display index without rescanning historical branches or receipts", () => {
  const f = fixture();
  try {
    const id = f.conversation.id,
      manager = f.sessions.get(id);
    for (let i = 0; i < 250; i++) manager.appendMessage(fauxAssistantMessage(`Older ${i}`));
    f.sessions.page(id);
    manager.getEntries = () => {
      throw new Error("Full session scan");
    };
    manager.getBranch = () => {
      throw new Error("Full branch scan");
    };
    const getEntry = manager.getEntry.bind(manager);
    let visits = 0;
    manager.getEntry = (entryId) => {
      visits++;
      return getEntry(entryId);
    };
    const observed: AppEvent[] = [];
    f.events.subscribe((event) => observed.push(event));
    const input = f.sessions.accept(id, "An important correction.", "run");
    manager.appendMessage({
      role: "user",
      content: input.text,
      timestamp: Date.now(),
      biologue: { inputId: input.id },
    } as any);
    manager.appendMessage(fauxAssistantMessage("Correction retained."));
    f.sessions.publishMessages(id);
    f.sessions.publishMessages(id);
    assert.equal(visits, 2);
    assert.equal(observed.filter((event) => event.type === "message").length, 3);
    assert.equal(f.sessions.pending(id).length, 0);
    const latest = f.sessions.page(id).items;
    assert.equal(latest.filter((message) => message.id === input.id).length, 1);
    assert.equal(latest.find((message) => message.id === input.id)!.delivery, "delivered");
  } finally {
    f.close();
  }
});

test("the display index rebuilds from Pi and pending receipts without changing the canonical transcript", () => {
  const f = fixture();
  try {
    const id = f.conversation.id,
      manager = f.sessions.get(id);
    const receipt = f.sessions.accept(id, "Accepted input", "run");
    manager.appendMessage({
      role: "user",
      content: receipt.text,
      timestamp: Date.now(),
      biologue: { inputId: receipt.id },
    } as any);
    manager.appendMessage(fauxAssistantMessage("Canonical response"));
    const pending = f.sessions.accept(id, "Unsent correction", "run");
    const before = f.sessions.page(id).items;
    const raw = readFileSync(manager.getSessionFile()!, "utf8");
    f.store.db.exec("DELETE FROM chat_messages; DELETE FROM chat_delivered;");
    const reopened = new ConversationSessions(f.root, f.root, f.store, f.events);
    const after = reopened.page(id).items;
    const withoutSequence = (items: Message[]) =>
      items.map(({ sequence: _sequence, ...message }) => message);
    assert.deepEqual(withoutSequence(after), withoutSequence(before));
    assert.deepEqual(
      reopened.pending(id).map((message) => message.id),
      [pending.id],
    );
    assert.equal(readFileSync(manager.getSessionFile()!, "utf8"), raw);
  } finally {
    f.close();
  }
});

test("branch changes invalidate the display and never resurrect consumed steering receipts", () => {
  const f = fixture();
  try {
    const id = f.conversation.id,
      manager = f.sessions.get(id);
    const root = manager.appendMessage(fauxAssistantMessage("Shared ancestor"));
    const receipt = f.sessions.accept(id, "Consumed on an earlier branch", "run");
    manager.appendMessage({
      role: "user",
      content: receipt.text,
      timestamp: Date.now(),
      biologue: { inputId: receipt.id },
    } as any);
    manager.appendMessage(fauxAssistantMessage("Earlier branch response"));
    f.sessions.page(id);
    const observed: AppEvent[] = [];
    f.events.subscribe((event) => observed.push(event));
    manager.branch(root);
    manager.appendMessage(fauxAssistantMessage("Different branch response"));
    const page = f.sessions.page(id);
    assert.deepEqual(
      page.items.map((message) => message.text),
      ["Shared ancestor", "Different branch response"],
    );
    assert.equal(f.sessions.pending(id).length, 0);
    assert.deepEqual(observed, [{ type: "messages-reset", conversationId: id }]);
  } finally {
    f.close();
  }
});

test("workspace snapshots never open transcripts; the message API selects and pages one conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-chat-api-"));
  const f = await createApp({
    project: root,
    stateDir: join(root, ".biologue"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  try {
    const other = f.context.createConversation("A dormant conversation");
    f.store.put("pi-session", other.id, {
      file: join(root, "missing.jsonl"),
      persisted: true,
      sdkVersion: "0.87.1",
    });
    const selected = f.context.createConversation("Selected");
    const manager = f.sessions.get(selected.id);
    for (let i = 0; i < 80; i++) manager.appendMessage(fauxAssistantMessage(`Reply ${i}`));
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
    const invalid = await f.app.inject({
      method: "GET",
      url: `/api/conversations/${selected.id}/messages?before=bad`,
    });
    assert.equal(invalid.statusCode, 400);
    const missing = await f.app.inject({
      method: "GET",
      url: `/api/conversations/${other.id}/messages`,
    });
    assert.equal(missing.statusCode, 500);
    assert.match(missing.json().error, /missing/);
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
