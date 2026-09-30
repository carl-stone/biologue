import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

const origin = "https://science.example.ts.net";
const host = "science.example.ts.net";

async function fixture(t: TestContext, externalOrigin?: string) {
  const project = mkdtempSync(join(tmpdir(), "biologue-access-"));
  const f = await createApp({
    project,
    stateDir: join(project, ".biologue"),
    repository: process.cwd(),
    externalOrigin,
    kernel: { execute: async () => {}, interrupt: async () => {} },
  });
  t.after(async () => {
    await f.app.close();
    rmSync(project, { recursive: true, force: true });
  });
  return f.app;
}

test("browser access remains local unless an external origin is explicitly configured", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.inject("/api/health")).statusCode, 200);
  for (const headers of [{ host }, { origin }, { "x-forwarded-host": host, origin }])
    assert.equal((await app.inject({ url: "/api/health", headers })).statusCode, 403);
});

test("a private proxy origin allows the workbench without trusting other hosts or browser origins", async (t) => {
  const app = await fixture(t, origin);
  const headers = { host, origin, "x-biologue-client": "workbench" };
  const allowed = await app.inject({ url: "/api/snapshot", headers });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], origin);
  const created = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers,
    payload: { title: "Remote investigation" },
  });
  assert.equal(created.statusCode, 200);
  for (const badHeaders of [
    { ...headers, origin: "https://foreign.example" },
    { ...headers, origin: "http://science.example.ts.net" },
    { ...headers, host: "other.example.ts.net" },
    { ...headers, host: `${host}:8443` },
    { ...headers, host: "foreign.example", "x-forwarded-host": host },
    { host, origin },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          headers: badHeaders,
          payload: { title: "Must not be created" },
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (await app.inject("/api/snapshot")).json().conversations.length,
    allowed.json().conversations.length + 1,
  );
});

test("external browser configuration requires an exact HTTPS origin", async () => {
  for (const externalOrigin of [
    "http://science.example.ts.net",
    "https://science.example.ts.net/path",
    "https://user:password@science.example.ts.net",
    "https://science.example.ts.net?query",
  ])
    await assert.rejects(
      createApp({ project: ".", stateDir: ".", repository: ".", externalOrigin }),
      /HTTPS origin/,
    );
});
