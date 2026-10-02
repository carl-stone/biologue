import { resolve } from "node:path";
import { chmodSync } from "node:fs";
import { createApp } from "./app.ts";

const repository = resolve(process.env.BIOLOGUE_ROOT || process.cwd());
const project = resolve(process.env.BIOLOGUE_PROJECT || resolve(repository, "examples/sandbox"));
const { app } = await createApp({
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
    await app.close();
    process.exit(0);
  });
