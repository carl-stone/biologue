import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

test("permission feedback reaches the agent and decision history survives reload without copying code into snapshots", async () => {
  const project = mkdtempSync(join(tmpdir(), "biologue-decisions-"));
  const options = {
    project,
    stateDir: join(project, ".carl"),
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  };
  let f = await createApp(options);
  const headers = { "x-carl-client": "workbench" };
  const input = {
    runId: "run",
    conversationId: "conversation",
    tool: "edit_document",
    description: "Update the analysis.",
    document: { path: "analysis.py", version: 1 },
    before: "x = 1",
    code: "x = 2",
  };
  try {
    const pending = f.permissions.request(input);
    const rejected = assert.rejects(pending, /Scientist requested changes: Keep the donor pairing/);
    const request = f.permissions.list()[0];
    const feedback = "Keep the donor pairing";
    const response = await f.app.inject({
      method: "POST",
      url: `/api/permissions/${request.id}`,
      headers,
      payload: { allow: false, feedback },
    });
    assert.equal(response.statusCode, 200);
    await rejected;
    const history = (await f.app.inject({ method: "GET", url: "/api/snapshot" })).json()
      .permissionHistory;
    assert.equal(history[0].decision, "deny");
    assert.equal(history[0].feedback, feedback);
    assert.equal(history[0].code, undefined);
    assert.equal(history[0].before, undefined);
    assert.equal(history[0].conversationId, input.conversationId);
    const detail = (
      await f.app.inject({ method: "GET", url: `/api/permissions/${request.id}` })
    ).json();
    assert.equal(detail.code, input.code);
    assert.equal(detail.before, input.before);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/permissions/${request.id}`,
          headers,
          payload: { allow: true },
        })
      ).statusCode,
      409,
    );
    const allowed = f.permissions.request(input);
    const next = f.permissions.list()[0];
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/permissions/${next.id}`,
          headers,
          payload: { allow: true, feedback },
        })
      ).statusCode,
      400,
    );
    assert.equal(f.permissions.list().length, 1);
    f.permissions.decide(next.id, true);
    await allowed;
    const cancelled = f.permissions.request(input);
    const stopped = assert.rejects(cancelled, /cancelled/);
    f.permissions.cancelRun(input.runId);
    await stopped;
    await f.app.close();
    f = await createApp(options);
    const restored = (await f.app.inject({ method: "GET", url: "/api/snapshot" })).json();
    assert.deepEqual(
      restored.permissionHistory.map((item: any) => item.decision),
      ["deny", "allow", "cancelled"],
    );
    assert.equal(restored.permissions.length, 0);
    assert.equal(
      (await f.app.inject({ method: "GET", url: `/api/permissions/${request.id}` })).json()
        .feedback,
      feedback,
    );
  } finally {
    await f.app.close();
    rmSync(project, { recursive: true, force: true });
  }
});
