import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { ContextService } from "../src/context.ts";
import type { Conversation, Message } from "@biologue/protocol";

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("automatic titles update periodically, deduplicate requests, and respect manual renames", async () => {
  const store = new Store(":memory:");
  const context = new ContextService(store, new Events());
  try {
    const conversation = context.createConversation();
    const get = () => store.get<Conversation>("conversation", conversation.id)!;
    assert.equal(get().title, "New conversation");
    context.firstTitle(conversation.id, "Why do matched donors have different signals?");
    assert.equal(get().title, "Why do matched donors have different signals?");
    const messages: Message[] = [];
    function input(text: string) {
      const message: Message = {
        id: String(messages.length),
        conversationId: conversation.id,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
    }
    input("Compare the matched donors.");
    let calls = 0;
    const generate = async () => {
      calls++;
      return "Comparing matched donor signals";
    };
    context.refreshTitle(conversation.id, messages, generate);
    context.refreshTitle(conversation.id, messages, generate);
    await tick();
    assert.equal(calls, 1);
    assert.equal(get().title, "Comparing matched donor signals");
    for (let i = 0; i < 3; i++) {
      input("Another detail");
      context.refreshTitle(conversation.id, messages, generate);
      await tick();
    }
    assert.equal(calls, 1);
    input("Now consider the library preparation.");
    let finish!: (value: string) => void;
    context.refreshTitle(conversation.id, messages, () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    context.renameConversation(conversation.id, "Donor pilot — keep this name");
    finish("Library preparation differences");
    await tick();
    assert.equal(get().title, "Donor pilot — keep this name");
    assert.equal(get().titleMode, "manual");
    context.refreshTitle(conversation.id, messages, generate);
    assert.equal(calls, 2);
    const old = context.createConversation("Existing named investigation");
    context.firstTitle(old.id, "Different title");
    assert.equal(store.get<Conversation>("conversation", old.id)!.title, old.title);
  } finally {
    context.close();
    store.close();
  }
});

test("title failures retain the first-message name and closed workspaces ignore late results", async () => {
  const store = new Store(":memory:");
  const context = new ContextService(store, new Events());
  const conversation = context.createConversation();
  context.firstTitle(conversation.id, "A useful initial question");
  context.refreshTitle(conversation.id, [], async () => {
    throw new Error("offline");
  });
  await tick();
  assert.equal(
    store.get<Conversation>("conversation", conversation.id)!.title,
    "A useful initial question",
  );
  let finish!: (title: string) => void;
  context.refreshTitle(
    conversation.id,
    [],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  context.close();
  store.close();
  finish("Late name");
  await tick();
});
