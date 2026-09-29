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
