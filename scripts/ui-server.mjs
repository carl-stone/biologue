import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const project = mkdtempSync(join(tmpdir(), "biologue-ui-"));
cpSync("examples/sandbox/analysis.py", join(project, "analysis.py"));
const child = spawn(process.execPath, ["scripts/dev.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    BIOLOGUE_PROJECT: project,
    BIOLOGUE_STATE_DIR: join(project, ".biologue"),
    BIOLOGUE_PORT: "4318",
    BIOLOGUE_UI_PORT: "5174",
    BIOLOGUE_JUPYTER_PORT: "8890",
    BIOLOGUE_PROVIDER: "",
    BIOLOGUE_MODEL: "",
    JUPYTER_URL: "",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  rmSync(project, { recursive: true, force: true });
  process.exit(code || 0);
});
