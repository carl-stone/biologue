# Development

Biologue is the working title. Internal identifiers and configuration retain the
original Carl naming for compatibility; use the `CARL_*` settings documented below.

Use Node 22.19+ (`.nvmrc` selects Node 22), the locked Python environment from
`uv sync`, and Rust 1.88 for the Tauri shell. `npm ci`, `uv.lock`, and `Cargo.lock`
pin the dependencies used by their respective runtimes.

For this workspace, prefix commands with:

```bash
docker exec -i -w /workspace/carl-harness codex-universal bash -lc '<command>'
```

Select Node 22 inside that shell with `source /root/.nvm/nvm.sh && nvm use 22`.
Edit source and use Git on the host.

The supplied Docker network does not publish application ports to the host.
Use your development environment's port forwarding to access port 5173, or run
the checkout on your own desktop. The verification commands below run entirely
inside the container.

For private access from another computer, see [Tailscale setup](remote-access.md).
`npm run serve` starts the built workbench and managed Jupyter runtime. Its optional
`CARL_EXTERNAL_ORIGIN` admits one HTTPS browser origin, and `CARL_SOCKET` selects a
Unix socket instead of the default loopback TCP listener.

## Verification

```bash
npm run build
npm run lint
npm test
npm run test:integration
npx playwright install chromium
npm run test:ui
cargo check --manifest-path src-tauri/Cargo.toml
```

The unit tests exercise shared queuing, cancellation, permission decisions,
document conflicts, research-context revisions, and display events. Pi tests use
real AgentSession instances with a scripted model provider; they check tool routing and
permission enforcement without sending data to an external model.

The integration test starts a temporary authenticated Jupyter server and a real
ipykernel. It checks live state shared between human and agent execution, plots,
errors, interruption, and reconnection. Set `CARL_TEST_R=1` to also exercise an
installed Ark kernel. The browser test creates a temporary project and uses its
own application, Jupyter, and Vite ports. It leaves screenshots in `test-results`.

These tests establish software behavior. They do not evaluate the scientific
quality of model responses. [First-session review cases](first-session.md) are
the starting point for that separate evaluation.

## R / Ark

R must already be installed. Install a compatible binary from the official
[Ark releases](https://github.com/posit-dev/ark/releases), then run:

```bash
/path/to/ark --install
.venv/bin/jupyter kernelspec list
Rscript -e 'install.packages("jsonlite", repos="https://cloud.r-project.org")'
```

The default R kernel name is `ark`; override it with `CARL_R_KERNEL` when needed.
The Python default is `python3`, configurable with `CARL_PYTHON_KERNEL`.
The R adapter uses ordinary Jupyter execution and `jsonlite` for inspection and
table previews. Positron-specific comms and language services are not implemented.
Select **R session** in the workbench to use it. Missing kernels produce an
execution error; they never fall back silently to another language.

## Services and configuration

| Setting                       | Default                    | Purpose                                             |
| ----------------------------- | -------------------------- | --------------------------------------------------- |
| `CARL_PROJECT`                | `examples/sandbox`         | Existing project directory                          |
| `CARL_STATE_DIR`              | `<project>/.carl`          | Pi sessions, SQLite state, and captured outputs     |
| `CARL_ROOT`                   | Launch working directory   | Repository resources and built frontend             |
| `CARL_PORT`                   | `4317`                     | Node API and built workbench                        |
| `CARL_UI_PORT`                | `5173`                     | Vite development frontend                           |
| `CARL_JUPYTER_PORT`           | `8889`                     | Managed local Jupyter server                        |
| `JUPYTER_URL`                 | Managed runtime            | Connect to an existing local Jupyter server instead |
| `JUPYTER_TOKEN`               | Random for managed runtime | Jupyter authentication; never sent to the browser   |
| `CARL_PROVIDER`, `CARL_MODEL` | Unset                      | Explicit Pi provider/model selection                |

For an existing Jupyter server, supply its matching `JUPYTER_TOKEN` and configure
its root directory to the project directory. This slice assumes a local Jupyter
server with the same filesystem as Node. Kernel session paths include the project
identity, so separate projects do not intentionally reuse a session.

`npm run build && npm start` serves the built workbench at port 4317 and expects
Jupyter to be running already. The Tauri development command uses port 5173;
the built shell connects to Node at port 4317. Both use the same frontend and API.

## State and recovery

The SQLite store uses WAL mode. Document revisions and research-context revisions
are retained. Agent prompts include the selected context version. Pi session
files retain the canonical model transcript and tool results; SQLite holds run
inputs, domain records, and durable input receipts. Display messages are projected
from Pi history and pending receipts.
An application restart marks unfinished runs/executions as abandoned. Existing
Jupyter sessions can be reattached while Jupyter remains alive. Restarting the
managed launcher also restarts its Jupyter process; persisted history does not
restore Python or R objects.

The editor is an optimistic replica of the server's versioned working document.
It synchronizes automatically after a short typing pause, serializes requests per
file, and retains edits made during a request. Pending edits survive offline
reloads. Run, Save, and sending a chat message wait for the relevant edits to be
acknowledged. Concurrent changes require review; neither side silently wins.

The document service watches opened directories. Clean documents follow disk
changes; dirty documents retain their content and expose the disk version for
review. Reconciliation checks both the working revision and reviewed disk hash.
Opening a document also recovers a save that renamed the file before recording
its saved revision. There is no automatic textual merge.

Execution metadata and immutable source have separate SQLite tables. OutputService
owns raw output events, generation-scoped display slots, and typed inspection results.
Large payloads live under `artifacts/blobs/`, addressed by SHA-256. Existing embedded
execution outputs migrate on startup, retaining their IDs, source, and provenance;
verified legacy artifact copies are removed after the new payload is durable.
Snapshots contain bounded execution summaries; output references are paginated,
and payload/source reads are explicit. React panels subscribe to their consumed
state fields, so token streaming does not update the editor or output queries.

Shutdown stops submissions, cancels queued human and agent work, and waits for
active work before closing kernel connections and SQLite. A kernel that does not
respond within ten seconds is recorded as abandoned; later callbacks cannot write
to closed storage, and the code is never replayed automatically. The development
launcher stops the application before stopping its managed Jupyter process.

Individual cancellation waits at most two seconds for completion. A timeout is
recorded as `completion_unknown` and persists a language-session quarantine.
Further work requires an idle, connected kernel and a fresh kernel-info response;
reconciliation also has a two-second deadline. Readiness does not change the
original unknown outcome. No computation is replayed during recovery.

The workbench keeps message drafts per conversation, console drafts per language,
and unsaved research context in project-scoped local storage. Research notes are
shared with new agent runs only after **Save context**. In the editor, **Share
buffer** creates a server revision; **Save** also writes to the project file.
Running a `.py` or `.R` file selects its matching session, independently of the
session previously selected in the header.

Use the left rail or `Alt+1` through `Alt+8` to open a panel. `Alt+F` focuses the
active panel; Escape restores the workspace. `Ctrl/Cmd+Enter` runs the entire
editor file, runs console input, or sends a message according to focus.
`Ctrl/Cmd+S` saves the focused file or research notes. The help dialog explains
these shortcuts. Panel arrangements are retained separately for wide, compact,
and narrow windows. Figure downloads and clipboard actions are verified in the
browser; native webview behavior still needs a desktop smoke test.

Execution records are a provenance foundation, not a complete environment replay
system. Package versions inside an arbitrary attached kernel, external files read
by code, randomness, and external service responses are not automatically captured.

## Pi SDK configuration and compatibility

Biologue pins `pi-coding-agent`, `pi-agent-core`, and `pi-ai` to 0.99.1. Agent-core is
used for message types; session construction and lifecycle use the higher-level
SDK. The composer settings select a model, supported thinking level and permission mode per conversation. Project defaults also use `CARL_PROVIDER` and `CARL_MODEL`, or Pi settings'
`defaultProvider` and `defaultModel`. Explicit adapter options take precedence over
saved Pi settings, which take precedence over environment variables. Pi's ModelRuntime handles
provider credentials/catalogs, using the configured state directory's
`pi/auth.json` and `pi/models.json` when supplied. Never commit credential files.
Pi settings live in `pi/settings.json` under that state directory, with project
`.pi/settings.json` supported by the SDK. Cache warming is forced off in Biologue.

Use `npm run login:codex` to sign Biologue into ChatGPT through Pi's device-code
flow. It uses `CARL_PROJECT` and `CARL_STATE_DIR` to select the same credential
store as the server; it does not change the configured model. Complete the login
on OpenAI's page instead of pasting credentials into chat. The SDK owns login,
credential locking, persistence, and token refresh. Give Biologue its own login
instead of copying rotating tokens from an active Codex session. See
[OpenAI's headless sign-in guidance](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

Place a scientific skill in `.pi/skills/<name>/SKILL.md` with Pi's standard name
and description frontmatter. Biologue loads skill descriptions and lets the model
read selected skill resources. Resources lists skills, prompts and project instructions;
slash commands expand through Pi. The bundled `@biologue/pi-science` workspace
package exports the scientific context/compaction extension and analysis prompts.
`pi-ask-user` 0.15.1 is installed and uses the browser's Pi dialog bridge.

Native Pi MCP, code mode and tool search are explicitly loaded. Configure MCP in
Agent settings → MCP; configuration lives in the project's state directory under
`pi/mcp.json`. Pi's MCP OAuth implementation uses its standard global
`~/.pi/agent/mcp-auth.json` credential store. `/mcp` checks connections and
`/mcp login <name>` starts sign-in, including pasted loopback callback URLs when
the browser runs elsewhere. Code mode only orchestrates tools: it has no Node,
filesystem or network access, and auxiliary model calls are disabled. Scientific
execution and inspection still use ExecutionService. MCP tools lacking a read-only
annotation use the same approval system as workspace actions. Native shell and
file-writing tools remain excluded. Arbitrary installed executable extensions are
not auto-loaded; each extension needs a host integration review.

Conversation settings offer Ask, Plan (read/inspect), Allow edits and Allow all
modes. Provider sign-in is available through Pi's own OAuth/API-key challenges in
the Providers section. Credential values are never returned in challenge payloads.
Attachments preserve file snapshots and source revisions separately from display
text. Branches copy conversation history, not project files or live kernel state.

Back up the entire state directory, including Pi session files and artifacts.
Existing SQLite transcripts are imported automatically and retained as migration
evidence. A session file that disappears after persistence produces an error;
restore it before continuing that conversation.

When upgrading Pi, run the AgentSession regression suite, especially message
metadata persistence, prompt preflight cancellation, retry/compaction settlement,
steering delivery, and skill discovery. The historical audit's command now runs
that suite:

```bash
npx tsx scripts/audits/pi-boundary.ts
```

In the supplied environment, run this inside `codex-universal`, as with all other
checks. The live kernel integration also routes scripted model tool calls through
AgentSession and the same ExecutionService used by the human UI.
