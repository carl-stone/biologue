/**
 * Run the executable Pi boundary regression suite through the real AgentSession SDK.
 * Scripted providers and disposable projects: no paid model calls or live kernels.
 * The original pre-migration findings remain in docs/pi-boundary-audit.md.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    fileURLToPath(new URL("../../packages/server/test/supervisor.test.ts", import.meta.url)),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
