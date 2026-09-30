import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { PiAdapter } from "../src/pi.ts";
import { scriptedModel } from "./helpers/pi-fixture.ts";

const headers = { "x-carl-client": "workbench" };
test("harness API persists conversation settings, rejects unavailable models and redacts MCP credentials", async () => {
  const project = mkdtempSync(join(tmpdir(), "biologue-harness-"));
  const stateDir = join(project, ".carl");
  const model = await scriptedModel();
  const pi = new PiAdapter({ project, stateDir, ...model.options });
  const f = await createApp({
    project,
    stateDir,
    pi,
    repository: process.cwd(),
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  try {
    const conversation = f.context.createConversation("Separate settings");
    const settings = {
      provider: model.options.provider,
      model: model.options.modelId,
      thinking: "off",
      mode: "plan",
    };
    const changed = await f.app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/settings`,
      headers,
      payload: settings,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(changed.json().settings, settings);
    assert.equal(
      pi.status().thinking,
      "medium",
      "Changing one conversation leaves project defaults alone",
    );
    const invalid = await f.app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/settings`,
      headers,
      payload: { ...settings, model: "missing" },
    });
    assert.equal(invalid.statusCode, 400);
    const config = {
      url: "https://example.test/mcp",
      headers: { Authorization: "secret-token" },
      oauth: { clientId: "client", clientSecret: "client-secret" },
    };
    const saved = await f.app.inject({
      method: "PUT",
      url: "/api/agent/mcp/example",
      headers,
      payload: config,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const listed = await f.app.inject({ url: "/api/agent/mcp" });
    assert.doesNotMatch(listed.body, /secret-token|client-secret/);
    const masked = listed.json()[0].config;
    assert.equal(masked.headers.Authorization, "[configured]");
    const disabled = await f.app.inject({
      method: "PUT",
      url: "/api/agent/mcp/example",
      headers,
      payload: { ...masked, enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.deepEqual(pi.mcpServers()[0].config, { ...config, enabled: false });
    const removed = await f.app.inject({
      method: "PUT",
      url: "/api/agent/mcp/example",
      headers: { ...headers, "content-type": "application/json" },
      payload: "null",
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(pi.mcpServers().length, 0);
    const resources = (await f.app.inject({ url: "/api/agent/resources" })).json();
    assert.ok(resources.prompts.some((item: { name: string }) => item.name === "review-analysis"));
  } finally {
    await f.app.close();
    rmSync(project, { recursive: true, force: true });
  }
});
