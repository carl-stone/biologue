import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { scriptedModel } from "./helpers/pi-fixture.ts";
import { PiAdapter } from "../src/pi.ts";

const headers = { "x-biologue-client": "workbench" };
test("folder switching isolates buffers, conversations and API routes, and survives reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-projects-"));
  for (const name of ["one", "two"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "analysis.py"), name);
  }
  const options = {
    project: join(root, "one"),
    stateDir: join(root, "one/.biologue"),
    projects: true,
    jupyterRoot: root,
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  };
  let f = await createApp(options);
  try {
    f.documents.edit("analysis.py", "unsaved first project", 1);
    const opened = await f.app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { path: join(root, "two") },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const id = opened.json().id;
    const url = `/projects/${id}/api`;
    const second = (await f.app.inject({ url: `${url}/snapshot` })).json();
    assert.equal(second.project, join(root, "two"));
    assert.equal(
      second.documents.find((doc: { path: string }) => doc.path === "analysis.py")?.content,
      undefined,
    );
    const doc = (await f.app.inject({ url: `${url}/documents?path=analysis.py` })).json();
    assert.equal(doc.content, "two");
    const changed = await f.app.inject({
      method: "PUT",
      url: `${url}/documents`,
      headers,
      payload: {
        path: "analysis.py",
        content: "unsaved second project",
        expectedVersion: doc.version,
      },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(f.documents.open("analysis.py").content, "unsaved first project");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { path: "/" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: `${url}/context`,
          headers: { origin: "https://hostile.example", ...headers },
          payload: { text: "no", expectedVersion: 0 },
        })
      ).statusCode,
      403,
    );
    await f.app.close();
    f = await createApp(options);
    assert.equal(
      (await f.app.inject({ url: `${url}/documents?path=analysis.py` })).json().content,
      "unsaved second project",
    );
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment refreshes once after code, coalesces requests, and never creates agent observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "biologue-environment-"));
  const f = await createApp({
    project: root,
    stateDir: join(root, ".biologue"),
    repository: process.cwd(),
    kernel: {
      execute: async () => {
        await new Promise((done) => setTimeout(done, 30));
      },
      interrupt: async () => {},
    },
  });
  try {
    const refresh = () =>
      f.app.inject({
        method: "POST",
        url: "/api/environment",
        headers,
        payload: { language: "python" },
      });
    const requests = await Promise.all([refresh(), refresh(), refresh()]);
    assert.equal(new Set(requests.map((res) => res.json().id)).size, 1);
    await f.execution.wait(requests[0].json().id);
    const work = f.execution.submit({ language: "python", actor: "human", code: "x = 1" });
    await f.execution.wait(work.id);
    await new Promise((done) => setTimeout(done, 250));
    const records = f.execution.repository.list(100).items;
    const inspections = records.filter((item) => item.inspection === "environment");
    assert.equal(inspections.length, 2);
    assert.ok(
      inspections.every((item) => item.actor === "system" && !item.runId && !item.conversationId),
    );
    await refresh();
    assert.equal(f.execution.repository.list(100).items.length, 3);
  } finally {
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model catalog and supported thinking levels come from Pi and selected settings persist", async () => {
  const model = await scriptedModel();
  const pi = new PiAdapter({ project: tmpdir(), stateDir: tmpdir(), ...model.options });
  const catalog = await pi.models();
  const selected = catalog.find((item) => item.id === "scientist-test")!;
  assert.ok(selected);
  await pi.configure(selected.provider, selected.id, selected.thinkingLevels[0]);
  assert.equal(pi.status().thinking, selected.thinkingLevels[0]);
  assert.equal(model.options.settingsManager.getDefaultModel(), selected.id);
  await assert.rejects(pi.configure(selected.provider, "missing", "low"), /not available/);
});
