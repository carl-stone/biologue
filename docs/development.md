# Development

Use Node 22.19+ (`.nvmrc` selects Node 22), Python 3.11+ with
[uv](https://docs.astral.sh/uv/), and Rust from `rust-toolchain.toml` for the Tauri
shell. Install dependencies with `npm ci` and `uv sync`.
[README.md](../README.md) covers launching the workbench;
[ARCHITECTURE.md](../ARCHITECTURE.md) defines ownership and planned capabilities.

## Supplied workspace

Edit files and use Git on the host. Run install, build, test, lint, and application
commands inside `codex-universal`, mapping `/root/workspace/<checkout>` to
`/workspace/<checkout>`. For this checkout:

```bash
docker exec -i -w /workspace/carl-harness codex-universal bash -lc \
  'source /root/.nvm/nvm.sh && nvm use 22 && npm run build'
```

Use the same wrapper for the commands below. Container ports are not published to
the host; use the environment's port forwarding for port 5173 or the
[private browser setup](remote-access.md).

## Code map

| Area                                    | Start here                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench and panels                    | [App.tsx](../packages/workbench/src/App.tsx), [panels](../packages/workbench/src/panels/)                                                                                                                              |
| Application API and project lifecycle   | [app.ts](../packages/server/src/app.ts), [projects.ts](../packages/server/src/projects.ts)                                                                                                                             |
| Agent sessions, tools, and permissions  | [pi.ts](../packages/server/src/pi.ts), [supervisor.ts](../packages/server/src/supervisor.ts), [workspace-tools.ts](../packages/server/src/workspace-tools.ts), [permissions.ts](../packages/server/src/permissions.ts) |
| Shared scientific execution and outputs | [execution.ts](../packages/server/src/execution.ts), [kernels.ts](../packages/server/src/kernels.ts), [outputs.ts](../packages/server/src/outputs.ts)                                                                  |
| Frontend/backend types                  | [protocol](../packages/protocol/src/index.ts)                                                                                                                                                                          |
| Scientific behavior and compaction      | [collaborator prompt](../prompts/collaborator.md), [Pi science extension](../packages/pi-science/index.ts)                                                                                                             |
| Launching and checks                    | [dev launcher](../scripts/dev.mjs), [server tests](../packages/server/test/), [browser tests](../tests/)                                                                                                               |

## Checks

Run the core checks for code changes:

```bash
npm run build
npm test
npm run lint
```

For kernel changes, run `npm run test:integration`. It starts a temporary
authenticated Jupyter server and a real Python kernel. Set `BIOLOGUE_TEST_R=1`
to include an installed Ark/R kernel.

For workbench changes:

```bash
npx playwright install chromium
npm run test:ui
```

Playwright starts its own application, Jupyter, and Vite ports with a temporary
project. Screenshots and traces go in ignored `test-results/`; retain them when
investigating a failure rather than committing them as review history.

Pi regression tests use the real Pi Durable harness with scripted providers and
make no external model calls. When upgrading Pi, run the full core suite; a
focused recovery and lifecycle check is:

```bash
npx tsx --test packages/server/test/supervisor.test.ts packages/server/test/durable-recovery.test.ts
```

These checks establish software behavior. Scientist-led review must separately
assess whether context changes the next action, corrections change dependent
reasoning, claims remain supported, and questions justify the attention they cost.

## R / Ark

R must already be installed. Install a compatible binary from the official
[Ark releases](https://github.com/posit-dev/ark/releases), then run:

```bash
/path/to/ark --install
.venv/bin/jupyter kernelspec list
Rscript -e 'install.packages("jsonlite", repos="https://cloud.r-project.org")'
```

The R adapter uses ordinary Jupyter execution and `jsonlite` for object inspection
and table previews. Missing kernels produce an error rather than changing the
requested language. Positron-specific comms and language services are planned.

## Configuration

Environment variables are read by the server and launcher; `.env` files are not
loaded automatically.

| Setting                               | Default                                            | Purpose                                              |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `BIOLOGUE_PROJECT`                    | `examples/sandbox`                                 | Initial project directory                            |
| `BIOLOGUE_STATE_DIR`                  | `<project>/.biologue`                              | Initial project's Pi sessions, SQLite, and artifacts |
| `BIOLOGUE_ROOT`                       | Launch working directory                           | Repository resources and built frontend              |
| `BIOLOGUE_PORT`                       | `4317`                                             | Node API and built workbench                         |
| `BIOLOGUE_UI_PORT`                    | `5173`                                             | Vite development frontend                            |
| `BIOLOGUE_JUPYTER_PORT`               | `8889`                                             | Managed Jupyter server                               |
| `JUPYTER_URL`                         | Managed runtime                                    | Existing local Jupyter server                        |
| `JUPYTER_TOKEN`                       | Random for managed runtime                         | Jupyter authentication                               |
| `JUPYTER_ROOT`                        | `/` for managed runtime; initial project otherwise | Jupyter filesystem root                              |
| `BIOLOGUE_R_KERNEL`                   | `ark`                                              | R kernel name                                        |
| `BIOLOGUE_PYTHON_KERNEL`              | `python3`                                          | Python kernel name                                   |
| `BIOLOGUE_PROVIDER`, `BIOLOGUE_MODEL` | Unset                                              | Fallback Pi provider/model                           |
| `BIOLOGUE_EXTERNAL_ORIGIN`            | Unset                                              | One exact HTTPS browser origin for private access    |
| `BIOLOGUE_SOCKET`                     | Unset                                              | Unix socket listener with `npm run serve`            |

An existing Jupyter server must share the server's filesystem. Supply its matching
`JUPYTER_TOKEN`, and set `JUPYTER_ROOT` to its root directory. `npm start` serves built assets but expects
Jupyter to be running; `npm run serve` manages Jupyter unless `JUPYTER_URL` is set.

## Pi and model providers

Select a model, thinking level, and permission mode per conversation in Agent
settings. Provider credentials can be configured under Providers. For server-side
API-key setup, set `BIOLOGUE_PROVIDER`, `BIOLOGUE_MODEL`, and the provider's key
variable, such as `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`, before starting.
Keys stay on the server.

Pi settings are in `<stateDir>/pi/settings.json`, with project `.pi/settings.json`
also supported. Saved `defaultProvider` and `defaultModel` take precedence over
the environment fallback; conversation settings override the defaults. Credentials
live in `<stateDir>/pi/auth.json`, and custom models in `pi/models.json`. Projects
opened through the picker share the initial workspace's provider credentials.

For a ChatGPT/Codex subscription, run `npm run login:codex` with the same
`BIOLOGUE_PROJECT` and `BIOLOGUE_STATE_DIR` as the server. Complete the displayed
OpenAI device-code flow, then select the `openai-codex` provider and a model.
Use Biologue's own sign-in so rotating tokens are managed independently.

Put project skills in `.pi/skills/<name>/SKILL.md` using Pi's name/description
frontmatter. Resources exposes skills, prompts, and project instructions; slash
commands expand through Pi. The [science package](../packages/pi-science/README.md)
supplies the research-context and compaction integration.

Configure native Pi MCP in **Agent settings → MCP**; project configuration lives
in `<stateDir>/pi/mcp.json`. `/mcp` shows connection status; authentication
challenges offer a sign-in link in the workbench. Pi's MCP OAuth provider stores
credentials per server and URL in `<stateDir>/pi/mcp-auth/`; its loopback callback
listener opens only when sign-in is needed. Tools register directly with Pi
Durable, using Pi's standalone MCP clients and code-mode sandbox. Code mode
orchestrates tools without direct filesystem, network, shell, or auxiliary model
access. Executable extensions require an explicit host integration.

## State and recovery

Back up the entire project state directory. Application records live in
`biologue.sqlite`; canonical conversation history, accepted inputs, run metadata,
submissions, task checkpoints, and usage live in `pi/durable.sqlite`. Chat rows
and run records in the application database are rebuildable display caches.
Include WAL files and artifact payloads
in a live backup, or stop the app before copying. Branches inherit a selected
history prefix while retaining the project's shared files and live kernels.
Pi Durable is pinned to 1.0.0, whose API is experimental; upgrades require
review of stored task definitions and the recovery suite. Only one application
process may own a project harness at a time. Its ownership record is reclaimed
when the owning process is dead on the same host.

Documents synchronize to the server's versioned working buffers; saving writes
them to project files. Execution captures exact source independently of later
edits. All human, agent, and inspection code goes through ExecutionService.

Active durable runs resume after their scientific extensions and tools are
restored for every recovering conversation. Failed setup blocks provider dispatch
and waits for that same recovery barrier before aborting native work. The original
input is admitted before startup corrections; correction admissions follow receipt
order and retain request identity across restarts. Queue clearing shares the
admission lock. Manual compaction admission and its run
identity commit together, and restoring an unsent correction is idempotent even
if the display index fails. Native code-mode tool tasks own their entire plan,
including nested calls; there is no separate nested-task scheduler or replay journal.
Tool discovery activates native registrations through Durable controls. Code-mode
saved values live in a rewindable native document and follow the selected branch
prefix. Scientific summaries run in native child conversations owned by compaction
tasks, with Durable generation, retry, recovery, cancellation, and usage accounting.
The app aggregates parent and child usage for display without duplicating it.
Interrupted scientific executions are marked abandoned.
Interrupted tools, including calls that were waiting for
approval, settle as unknown effects and are never replayed automatically. A surviving Jupyter session can be reattached; restarting
the managed launcher restarts Jupyter and clears live objects. Cancellation with
an uncertain outcome gates further dispatch until the kernel is reconciled.
Recorded source and outputs do not capture a complete reproducible environment.

## Desktop shell

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
`npm run desktop` launches the development shell and the same local services.
After Rust or Tauri configuration changes, run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

A built shell currently needs the Node server and Jupyter started separately;
bundled sidecars and installers are planned. Native webview behavior needs a
manual desktop smoke test.
