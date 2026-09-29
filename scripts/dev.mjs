import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { get } from "node:http";

const root = process.cwd();
const production = process.argv.includes("--production");
if (process.env.CARL_SOCKET && !production) {
  console.error("CARL_SOCKET requires npm run serve.");
  process.exit(1);
}
if (
  production &&
  (!existsSync(resolve(root, "packages/server/dist/server.mjs")) ||
    !existsSync(resolve(root, "packages/workbench/dist/index.html")))
) {
  console.error("Run npm run build before npm run serve.");
  process.exit(1);
}
const project = resolve(process.env.CARL_PROJECT || "examples/sandbox");
const token = process.env.JUPYTER_TOKEN || randomBytes(32).toString("hex");
const jupyterPort = process.env.CARL_JUPYTER_PORT || "8889";
const uiPort = process.env.CARL_UI_PORT || "5173";
const jupyterUrl = process.env.JUPYTER_URL || `http://127.0.0.1:${jupyterPort}/`;
const env = {
  ...process.env,
  CARL_ROOT: root,
  CARL_PROJECT: project,
  JUPYTER_TOKEN: token,
  JUPYTER_URL: jupyterUrl,
};
const children = [];
let application;
let stopping = false;
function applicationReady() {
  return new Promise((done) => {
    const request = get(
      {
        host: "127.0.0.1",
        port: process.env.CARL_PORT || 4317,
        socketPath: process.env.CARL_SOCKET,
        path: "/api/health",
        timeout: 1000,
      },
      (response) => {
        response.resume();
        done(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => done(false));
  });
}
async function terminate(child, timeoutMs) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    let timer;
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  void (async () => {
    // ExecutionService gets ten seconds to interrupt and record work while Jupyter
    // is still available. Only then tear down the runtime and frontend processes.
    await terminate(application, 12_000);
    await Promise.all(
      children.filter((child) => child !== application).map((child) => terminate(child, 1500)),
    );
    process.exit(code);
  })();
}
function start(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
  return child;
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
if (!process.env.JUPYTER_URL) {
  const python = resolve(
    process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
  );
  if (!existsSync(python)) {
    console.error("Run uv sync first to install the scientific runtime.");
    process.exit(1);
  }
  // Token is passed through the environment, not command-line arguments or logs.
  start(python, [
    "-m",
    "jupyter_server",
    "--no-browser",
    "--ServerApp.ip=127.0.0.1",
    `--ServerApp.port=${jupyterPort}`,
    "--ServerApp.port_retries=0",
    "--ServerApp.allow_root=True",
    `--ServerApp.root_dir=${project}`,
    "--ServerApp.log_level=ERROR",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(`${jupyterUrl}api/status`, {
        headers: { Authorization: `token ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready) {
    console.error("Jupyter did not become ready.");
    stop(1);
  }
}
if (!stopping) {
  application = start(
    process.execPath,
    production
      ? ["packages/server/dist/server.mjs"]
      : ["--import", "tsx", "packages/server/src/main.ts"],
  );
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      if (await applicationReady()) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) {
    console.error("The application server did not become ready.");
    stop(1);
  }
}
if (!stopping && !production) {
  start(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--config",
    "packages/workbench/vite.config.ts",
    "--host",
    "127.0.0.1",
  ]);
  console.log(`Biologue workspace: http://127.0.0.1:${uiPort}`);
}
if (!stopping && production)
  console.log(
    `Biologue workspace: ${process.env.CARL_EXTERNAL_ORIGIN || process.env.CARL_SOCKET || `http://127.0.0.1:${process.env.CARL_PORT || 4317}`}`,
  );
