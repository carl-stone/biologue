import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Execution, Output } from "@biologue/protocol";
import { Store } from "../src/store.ts";
import { Events } from "../src/events.ts";
import { OutputService } from "../src/outputs.ts";
import { artifactText, executionText, inspectionResult } from "../src/tool-results.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biologue-tool-results-"));
  const store = new Store(join(root, "state.sqlite"));
  const outputs = new OutputService(store, new Events(), join(root, "artifacts"));
  const record: Execution = {
    id: randomUUID(),
    language: "python",
    actor: "agent",
    purpose: "analysis",
    code: "print(42)",
    codeHash: "internal-hash",
    codePreview: "print(42)",
    status: "succeeded",
    createdAt: new Date().toISOString(),
    kernelId: "internal-kernel",
    sessionId: "internal-session",
  };
  return {
    record,
    outputs,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("successful results carry output once; large output and source pages remain retrievable", () => {
  const f = fixture();
  try {
    f.outputs.append(f.record, { kind: "stream", text: "4" });
    f.outputs.append(f.record, { kind: "stream", text: "2\n" });
    assert.equal(executionText(f.record, f.outputs), `Execution ${f.record.id} succeeded.\n\n42\n`);
    for (let i = 0; i < 20; i++)
      f.outputs.append(f.record, { kind: "stream", text: `${i}:` + "x".repeat(3000) });
    f.record.code = "# source\n".repeat(2000);
    const tail = executionText(f.record, f.outputs);
    assert.ok(tail.length < 8000);
    assert.match(tail, /Earlier outputs: read_execution outputOffset=0/);
    for (const ref of f.outputs.references(f.record.id, f.outputs.count(f.record.id) - 8, 8)) {
      assert.ok(tail.includes(ref.id));
      const full = artifactText(f.outputs.get(ref.id)!, 0);
      assert.ok(full.length > 3000, "A truncated preview must leave complete output available");
    }
    const first = executionText(f.record, f.outputs, { codeOffset: 0, outputOffset: 0 });
    assert.match(first, /More code: read_execution codeOffset=6000/);
    assert.match(first, /More outputs: read_execution outputOffset=8/);
    assert.ok(first.length < 15_000);
    const codePage = executionText(f.record, f.outputs, { codeOffset: 6000, outputOffset: 0 });
    assert.ok(codePage.includes(f.record.code.slice(6000, 12_000)));
    assert.doesNotMatch(codePage, /Output |Earlier outputs|More outputs/);
    const outputPage = executionText(f.record, f.outputs, { codeOffset: 0, outputOffset: 8 });
    assert.doesNotMatch(outputPage, /# source/);
    assert.match(outputPage, /More outputs: read_execution outputOffset=16/);
  } finally {
    f.close();
  }
});

test("inspection previews remain bounded and expose continuation hints", () => {
  const f = fixture();
  try {
    f.record.purpose = "inspection";
    f.record.inspection = "environment";
    f.outputs.append(f.record, {
      kind: "stream",
      text: JSON.stringify(
        Array.from({ length: 120 }, (_, i) => ({ name: `A${i}`, type: "int", preview: `${i}` })),
      ),
    });
    f.outputs.complete(f.record);
    const result = inspectionResult(f.record, f.outputs);
    const text = result.content[0].text;
    assert.equal(text.match(/^"A\d+"/gm)?.length, 100);
    assert.match(text, /More: inspect_environment offset=100/);
    assert.deepEqual(result.details, { executionId: f.record.id });
    assert.doesNotMatch(text, /biologueObservation|mimeTypes|totalOutputs/);
    const selected = inspectionResult(f.record, f.outputs, ["A119"]);

    assert.match(selected.content[0].text, /"A119" \(int\): 119/);
    assert.doesNotMatch(selected.content[0].text, /Showing|truncated/);
  } finally {
    f.close();
  }
});

test("artifact text selects one representation and pages it without data loss", () => {
  const output: Output = {
    id: randomUUID(),
    executionId: randomUUID(),
    sequence: 0,
    kind: "display",
    data: {
      "text/plain": "Duplicate description",
      "text/html": "<b>Duplicate description</b>",
      "application/json": { value: 42 },
    },
  };
  assert.equal(artifactText(output, 0), '{"value":42}');
  delete output.data!["application/json"];
  assert.equal(artifactText(output, 0), "Duplicate description");
  output.text = "a".repeat(16_000) + "b".repeat(4000);
  assert.equal(
    artifactText(output, 0),
    `${"a".repeat(16_000)}\n[More: read_artifact offset=16000.]`,
  );
  assert.equal(artifactText(output, 16_000), "b".repeat(4000));
  assert.throws(() => artifactText(output, 20_001), /Offset exceeds/);
  delete output.text;
  output.data = { "application/vnd.example+json": { value: 42 } };
  assert.match(artifactText(output, 0), /application\/vnd.example\+json\n\{"value":42\}/);
});

test("skipped bindings remain visible and kernel pages keep their offset", () => {
  const f = fixture();
  try {
    f.record.purpose = "inspection";
    f.record.inspection = "environment";
    f.outputs.append(f.record, {
      kind: "stream",
      text: JSON.stringify({
        rows: [
          { name: "lazy", type: "active binding", preview: "<not evaluated>" },
          { name: "A", type: "int", preview: "42" },
        ],
        next: 102,
      }),
    });
    f.outputs.complete(f.record);
    const result = inspectionResult(f.record, f.outputs, undefined, 100);
    assert.deepEqual(result.details, { executionId: f.record.id });
    assert.match(result.content[0].text, /lazy.*not evaluated/);
    assert.match(result.content[0].text, /offset=102/);
  } finally {
    f.close();
  }
});
