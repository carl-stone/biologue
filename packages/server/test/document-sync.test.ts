import { test } from "node:test";
import assert from "node:assert/strict";
import type { Document } from "@biologue/protocol";
import { DocumentSync, type PendingEdit } from "../../workbench/src/document-sync.ts";

const original: Document = {
  path: "analysis.py",
  content: "A",
  version: 1,
  savedVersion: 1,
  diskHash: "hash",
};
function fixture() {
  const requests: {
    path: string;
    edit: PendingEdit;
    resolve: (doc: Document) => void;
    reject: (error: Error) => void;
  }[] = [];
  let documents: Document[] = [],
    pending: Record<string, PendingEdit> = {};
  const persisted: Record<string, PendingEdit> = {};
  const sync = new DocumentSync(
    {
      send: (path, edit) =>
        new Promise((resolve, reject) => requests.push({ path, edit, resolve, reject })),
      changed: (docs, edits) => {
        documents = docs;
        pending = edits;
      },
      persist: (path, edit) => {
        if (edit) persisted[path] = edit;
        else delete persisted[path];
      },
      error: () => {},
    },
    10_000,
  );
  sync.receive(original);
  sync.connection(true);
  return {
    sync,
    requests,
    persisted,
    get document() {
      return documents[0];
    },
    get pending() {
      return pending;
    },
  };
}
const ack = (
  request: ReturnType<typeof fixture>["requests"][number],
  version: number,
): Document => ({
  ...original,
  content: request.edit.content,
  version,
  editId: request.edit.editId,
});

test("typing back to the original during sync preserves the latest edit and records both revisions", async () => {
  const f = fixture();
  try {
    f.sync.edit(original, "B");
    const flushed = f.sync.flush(original.path);
    f.sync.edit(original, "A");
    assert.equal(f.persisted[original.path].content, "A");
    f.requests[0].resolve(ack(f.requests[0], 2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].edit.content, "A");
    assert.equal(f.requests[1].edit.baseVersion, 2);
    f.requests[1].resolve(ack(f.requests[1], 3));
    assert.equal((await flushed).content, "A");
    assert.equal(f.document.version, 3);
    assert.deepEqual(f.pending, {});
  } finally {
    f.sync.close();
  }
});

test("SSE acknowledgement and lost HTTP response do not lose edits typed during the request", async () => {
  const f = fixture();
  try {
    f.sync.edit(original, "B");
    const flush = f.sync.flush(original.path);
    f.sync.edit(original, "C");
    f.sync.receive(ack(f.requests[0], 2));
    f.requests[0].reject(new Error("Lost response"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests[1].edit.content, "C");
    assert.equal(f.requests[1].edit.baseVersion, 2);
    f.requests[1].resolve(ack(f.requests[1], 3));
    assert.equal((await flush).content, "C");
  } finally {
    f.sync.close();
  }
});

test("a remote edit after acknowledgement remains a conflict; local work is recoverable", async () => {
  const f = fixture();
  try {
    f.sync.edit(original, "B");
    const flush = f.sync.flush(original.path);
    const rejected = assert.rejects(flush, /Review both versions/);
    f.sync.edit(original, "C");
    f.sync.receive(ack(f.requests[0], 2));
    f.sync.receive({ ...original, version: 3, content: "Agent edit", editId: "remote" });
    f.requests[0].resolve(ack(f.requests[0], 2));
    await rejected;
    assert.equal(f.pending[original.path].content, "C");
    assert.equal(f.pending[original.path].baseVersion, 2);
    assert.equal(f.document.content, "Agent edit");
    f.sync.keepLocal(original.path);
    const retry = f.sync.flush(original.path);
    assert.equal(f.requests[1].edit.baseVersion, 3);
    f.requests[1].resolve(ack(f.requests[1], 4));
    assert.equal((await retry).content, "C");
  } finally {
    f.sync.close();
  }
});

test("offline recovery keeps unsent edits and retries their identity after reconnect", async () => {
  const f = fixture();
  const restored = fixture();
  try {
    f.sync.connection(false);
    f.sync.edit(original, "offline");
    await assert.rejects(f.sync.flush(original.path), /offline/);
    assert.equal(f.requests.length, 0);
    restored.sync.restore(f.persisted);
    const flush = restored.sync.flush(original.path);
    assert.equal(restored.requests[0].edit.editId, f.persisted[original.path].editId);
    restored.requests[0].resolve(ack(restored.requests[0], 2));
    assert.equal((await flush).content, "offline");
  } finally {
    f.sync.close();
    restored.sync.close();
  }
});

test("a no-op acknowledgement settles a newer local edit with identical content", async () => {
  const f = fixture();
  try {
    f.sync.edit(original, "B");
    const flush = f.sync.flush(original.path);
    f.sync.edit(original, "C");
    f.sync.edit(original, "B");
    f.requests[0].resolve(ack(f.requests[0], 2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests[1].edit.content, "B");
    // A no-op doesn't create a new source revision, and older servers may retain the old edit ID.
    f.requests[1].resolve(ack(f.requests[0], 2));
    assert.equal((await flush).version, 2);
    assert.deepEqual(f.pending, {});
    assert.equal(f.requests.length, 2);
  } finally {
    f.sync.close();
  }
});
