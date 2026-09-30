import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, Page } from "@biologue/protocol";
import { ConversationHistory } from "../../workbench/src/conversation-history.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const message = (id: string, conversationId = "one"): Message => ({
  id,
  conversationId,
  role: "user",
  text: id,
  createdAt: "2026-09-28T00:00:00Z",
  delivery: "pending",
});

test("late conversation pages cannot overwrite a switched conversation or reconnect", async () => {
  const requests: ReturnType<typeof deferred<Page<Message>>>[] = [];
  const history = new ConversationHistory(
    () => {
      const request = deferred<Page<Message>>();
      requests.push(request);
      return request.promise;
    },
    () => {},
  );
  const first = history.select("one"),
    second = history.select("two");
  requests[1].resolve({ items: [message("second", "two")] });
  await second;
  requests[0].resolve({ items: [message("first")] });
  await first;
  assert.equal(history.state.items[0].text, "second");
  const reconnect = history.select("two", true);
  history.receive({ ...message("new", "two"), delivery: "delivered" });
  requests[2].resolve({ items: [] });
  await reconnect;
  assert.deepEqual(
    history.state.items.map((item) => item.id),
    ["new"],
  );
});

test("live delivery wins over a stale page and earlier pagination retains new messages", async () => {
  let before: string | undefined;
  let request = deferred<Page<Message>>();
  const history = new ConversationHistory(
    (_id, cursor) => {
      before = cursor;
      return request.promise;
    },
    () => {},
  );
  const first = history.select("one");
  history.receive({ ...message("b"), delivery: "delivered" });
  request.resolve({ items: [message("b")], next: "older" });
  await first;
  assert.equal(history.state.items[0].delivery, "delivered");
  request = deferred();
  const older = history.load();
  history.receive(message("c"));
  request.resolve({ items: [message("a"), message("b")] });
  await older;
  assert.equal(before, "older");
  assert.deepEqual(
    history.state.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(history.state.items[1].delivery, "delivered");
  assert.equal(history.state.next, undefined);
  history.receive(message("unselected", "two"));
  assert.equal(history.state.items.length, 3);
});

test("a failed page can be retried without clearing messages or advancing its cursor", async () => {
  let fail = false;
  const history = new ConversationHistory(
    async (_id, before) => {
      if (!before) return { items: [message("b")], next: "older" };
      if (fail) throw new Error("Disconnected");
      return { items: [message("a")] };
    },
    () => {},
  );
  await history.select("one");
  fail = true;
  await history.load();
  assert.equal(history.state.next, "older");
  assert.equal(history.state.items.length, 1);
  assert.match(history.state.error, /Disconnected/);
  fail = false;
  await history.load();
  assert.equal(history.state.error, "");
  assert.equal(history.state.items.length, 2);
});
