import { resolve } from "node:path";
import { chmodSync } from "node:fs";
import { createApp } from "./app.ts";
import { observeProcessFailures } from "./diagnostics.ts";

const repository = resolve(process.env.BIOLOGUE_ROOT || process.cwd());
const project = resolve(process.env.BIOLOGUE_PROJECT || resolve(repository, "examples/sandbox"));
const { app, diagnostics } = await createApp({
  repository,
  projects: true,
  jupyterRoot: process.env.JUPYTER_ROOT,
  project,
  stateDir: resolve(process.env.BIOLOGUE_STATE_DIR || resolve(project, ".biologue")),
  jupyterUrl: process.env.JUPYTER_URL,
  jupyterToken: process.env.JUPYTER_TOKEN,
  externalOrigin: process.env.BIOLOGUE_EXTERNAL_ORIGIN,
  logger: true,
});
// Observe fatal failures without changing Node's default termination behavior.
observeProcessFailures(diagnostics);
if (process.env.BIOLOGUE_SOCKET) {
  const path = resolve(process.env.BIOLOGUE_SOCKET);
  await app.listen({ path });
  chmodSync(path, 0o600);
} else await app.listen({ host: "127.0.0.1", port: Number(process.env.BIOLOGUE_PORT || 4317) });
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    diagnostics.record({ component: "process", event: "process.signal", data: { signal } });
    await app.close();
    process.exit(0);
  });
