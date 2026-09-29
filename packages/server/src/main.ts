import { resolve } from "node:path";
import { chmodSync } from "node:fs";
import { createApp } from "./app.ts";

const repository = resolve(process.env.CARL_ROOT || process.cwd());
const project = resolve(process.env.CARL_PROJECT || resolve(repository, "examples/sandbox"));
const { app } = await createApp({
  repository,
  project,
  stateDir: resolve(process.env.CARL_STATE_DIR || resolve(project, ".carl")),
  jupyterUrl: process.env.JUPYTER_URL,
  jupyterToken: process.env.JUPYTER_TOKEN,
  externalOrigin: process.env.CARL_EXTERNAL_ORIGIN,
  logger: true,
});
if (process.env.CARL_SOCKET) {
  const path = resolve(process.env.CARL_SOCKET);
  await app.listen({ path });
  chmodSync(path, 0o600);
} else await app.listen({ host: "127.0.0.1", port: Number(process.env.CARL_PORT || 4317) });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
