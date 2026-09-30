import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

test("creating a document cannot overwrite work or escape the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-create-"));
  const outside = mkdtempSync(join(tmpdir(), "biologue-outside-"));
  const f = await createApp({
    project: root,
    stateDir: join(root, ".carl"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  const headers = { "x-carl-client": "workbench" };
  try {
    const created = await f.app.inject({
      method: "POST",
      url: "/api/documents",
      headers,
      payload: { path: "new.py" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().version, 1);
    assert.equal(readFileSync(join(root, "new.py"), "utf8"), "");
    f.documents.edit("new.py", "unsaved = 1", 1);
    const duplicate = await f.app.inject({
      method: "POST",
      url: "/api/documents",
      headers,
      payload: { path: "new.py" },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(f.documents.open("new.py").content, "unsaved = 1");
    symlinkSync(outside, join(root, "external"));
    for (const path of ["../escape.py", "external/escape.py", ".carl/internal.py"]) {
      const response = await f.app.inject({
        method: "POST",
        url: "/api/documents",
        headers,
        payload: { path },
      });
      assert.equal(response.statusCode, 400, path);
    }
    assert.ok(
      (await f.app.inject({ method: "GET", url: "/api/snapshot" })).json().files.includes("new.py"),
    );
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("selected execution verifies exact revision offsets and records only the selected code", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-selection-"));
  const calls: string[] = [];
  const f = await createApp({
    project: root,
    stateDir: join(root, ".carl"),
    repository: process.cwd(),
    kernel: {
      execute: async (_language, code) => {
        calls.push(code);
      },
      interrupt: async () => {},
    },
  });
  const headers = { "x-carl-client": "workbench" };
  try {
    const source = '# 🧬 synthetic\nx = 2\nprint(x)\nraise Exception("not selected")\n';
    writeFileSync(join(root, "analysis.py"), source);
    const doc = f.documents.open("analysis.py");
    const from = source.indexOf("print(x)"),
      to = from + "print(x)".length;
    const document = { path: doc.path, version: doc.version, selection: { from, to } };
    const valid = await f.app.inject({
      method: "POST",
      url: "/api/executions",
      headers,
      payload: { language: "python", code: "print(x)", document },
    });
    assert.equal(valid.statusCode, 202);
    await f.execution.wait(valid.json().id);
    const stored = f.execution.get(valid.json().id)!;
    assert.deepEqual(stored.document, document);
    assert.equal(stored.code, "print(x)");
    assert.deepEqual(calls, ["print(x)"]);
    for (const selection of [
      { from: from - 1, to },
      { from, to: source.length + 1 },
      { from: to, to: from },
    ]) {
      const invalid = await f.app.inject({
        method: "POST",
        url: "/api/executions",
        headers,
        payload: { language: "python", code: "print(x)", document: { ...document, selection } },
      });
      assert.equal(invalid.statusCode, 409);
    }
    const wrong = await f.app.inject({
      method: "POST",
      url: "/api/executions",
      headers,
      payload: { language: "python", code: "x = 99", document },
    });
    assert.equal(wrong.statusCode, 409);
    assert.equal(calls.length, 1);
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("untitled documents survive reconnects, execute with exact identity, and save without overwriting files", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-untitled-"));
  const f = await createApp({
    project: root,
    stateDir: join(root, ".carl"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  const headers = { "x-carl-client": "workbench" };
  try {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/documents/untitled",
      headers,
      payload: { language: "python" },
    });
    assert.equal(response.statusCode, 201);
    const initial = response.json();
    assert.equal(initial.untitled, true);
    assert.deepEqual(f.documents.list(), []);
    const doc = f.documents.edit(initial.path, "print(42)", initial.version);
    assert.equal(f.documents.open(doc.path).content, "print(42)");
    const snapshot = (await f.app.inject({ url: "/api/snapshot" })).json();
    assert.equal(snapshot.documents[0].path, doc.path);
    const reference = { path: doc.path, version: doc.version };
    const submitted = await f.app.inject({
      method: "POST",
      url: "/api/executions",
      headers,
      payload: { language: "python", code: doc.content, document: reference },
    });
    assert.equal(submitted.statusCode, 202);
    await f.execution.wait(submitted.json().id);
    writeFileSync(join(root, "existing.py"), "keep me");
    for (const [target, expectedVersion, status] of [
      ["existing.py", doc.version, 409],
      ["../escape.py", doc.version, 400],
      ["result.py", doc.version - 1, 409],
    ] as const) {
      const rejected = await f.app.inject({
        method: "POST",
        url: "/api/documents/save-as",
        headers,
        payload: { path: doc.path, target, expectedVersion },
      });
      assert.equal(rejected.statusCode, status);
    }
    const saved = await f.app.inject({
      method: "POST",
      url: "/api/documents/save-as",
      headers,
      payload: { path: doc.path, target: "result.py", expectedVersion: doc.version },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(readFileSync(join(root, "result.py"), "utf8"), "print(42)");
    assert.equal(readFileSync(join(root, "existing.py"), "utf8"), "keep me");
    assert.equal(saved.json().untitled, undefined);
    assert.deepEqual(f.execution.get(submitted.json().id)!.document, reference);
    assert.doesNotThrow(() => f.documents.verifyReference(doc.path, doc.version, doc.content));
    const after = (await f.app.inject({ url: "/api/snapshot" })).json();
    assert.equal(
      after.documents.some((item: { path: string }) => item.path === doc.path),
      false,
    );
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Save As copies a named working document without changing its source or execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-save-copy-"));
  writeFileSync(join(root, "analysis.py"), "x = 1\n");
  const f = await createApp({
    project: root,
    stateDir: join(root, ".carl"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  const headers = { "x-carl-client": "workbench" };
  try {
    const source = f.documents.open("analysis.py");
    const edited = f.documents.edit(source.path, "x = 2\n", source.version);
    const response = await f.app.inject({
      method: "POST",
      url: "/api/documents/save-as",
      headers,
      payload: { path: source.path, target: "copy.py", expectedVersion: edited.version },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(readFileSync(join(root, "copy.py"), "utf8"), "x = 2\n");
    assert.equal(readFileSync(join(root, "analysis.py"), "utf8"), "x = 1\n");
    assert.deepEqual(f.documents.open(source.path), JSON.parse(JSON.stringify(edited)));
    assert.doesNotThrow(() =>
      f.documents.verifyReference(source.path, source.version, source.content),
    );
    assert.doesNotThrow(() =>
      f.documents.verifyReference(source.path, edited.version, edited.content),
    );
    for (const [target, expectedVersion] of [
      ["copy.py", edited.version],
      ["stale.py", source.version],
    ] as const) {
      const rejected = await f.app.inject({
        method: "POST",
        url: "/api/documents/save-as",
        headers,
        payload: { path: source.path, target, expectedVersion },
      });
      assert.equal(rejected.statusCode, 409);
    }
    const text = await f.app.inject({
      method: "POST",
      url: "/api/documents/untitled",
      headers,
      payload: { language: "text" },
    });
    assert.equal(text.statusCode, 201);
    assert.match(text.json().path, /\.txt$/);
    const draft = f.documents.edit(text.json().path, "notes", text.json().version);
    assert.equal(f.documents.saveAs(draft.path, "notes.txt", draft.version).content, "notes");
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
