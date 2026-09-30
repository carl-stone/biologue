import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/pi.ts";

test("saved Pi model selection persists over environment defaults; explicit options still win", async () => {
  const project = mkdtempSync(join(tmpdir(), "biologue-pi-settings-"));
  const stateDir = join(project, ".biologue");
  const agentDir = join(stateDir, "pi");
  const previousProvider = process.env.BIOLOGUE_PROVIDER;
  const previousModel = process.env.BIOLOGUE_MODEL;
  let settings: SettingsManager | undefined;
  try {
    delete process.env.BIOLOGUE_PROVIDER;
    delete process.env.BIOLOGUE_MODEL;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" }),
    );
    settings = SettingsManager.create(project, agentDir);
    const options = { project, stateDir, settingsManager: settings };
    assert.deepEqual(new PiAdapter(options).status(), {
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "medium",
    });
    process.env.BIOLOGUE_PROVIDER = "env-provider";
    process.env.BIOLOGUE_MODEL = "env-model";
    assert.deepEqual(new PiAdapter(options).status(), {
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "medium",
    });
    assert.deepEqual(
      new PiAdapter({
        ...options,
        provider: "explicit-provider",
        modelId: "explicit-model",
      }).status(),
      { enabled: true, provider: "explicit-provider", model: "explicit-model", thinking: "medium" },
    );
  } finally {
    if (previousProvider === undefined) delete process.env.BIOLOGUE_PROVIDER;
    else process.env.BIOLOGUE_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.BIOLOGUE_MODEL;
    else process.env.BIOLOGUE_MODEL = previousModel;
    await settings?.flush();
    rmSync(project, { recursive: true, force: true });
  }
});
