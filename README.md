# Biologue

An open-source science harness that learns how a scientist understands
their work and uses that understanding to help them investigate it.

Status: an initial working application, using Tauri, React/TypeScript, Dockview,
Node, Pi, and Jupyter. **Biologue is the working title**, combining biology and
dialogue. The scientific behavior is a design hypothesis that still needs
evaluation with scientists.

The project was previously called Carl. For compatibility, the repository path,
`@carl/*` package names, `CARL_*` settings, and `.carl` state directory retain their
original names. Existing conversations, drafts, layouts, and Pi sign-in settings
continue to use the same storage.

To open the workbench from another computer over Tailscale, see
[private browser access](docs/remote-access.md). Computation and project state
remain on the server.

## Run it

Requires Node 22.19+ and [uv](https://docs.astral.sh/uv/). On a normal local checkout:

```bash
npm ci
uv sync
npm run dev
```

Open **http://127.0.0.1:5173**. The development launcher starts an authenticated
Jupyter server, the application server, and the workbench. No model credentials
are needed to edit files, run Python, or inspect results. The included data is
explicitly synthetic.

In the supplied `/root/workspace` environment, edit files and use Git on the host,
and run all install, build, test, and application commands in `codex-universal`:

```bash
docker exec -i -w /workspace/carl-harness codex-universal bash -lc \
  'source /root/.nvm/nvm.sh && nvm use 22 && npm ci && uv sync && npm run dev'
```

Use `CARL_PROJECT=/absolute/path` to open another existing project. The default is
`examples/sandbox`. Pi conversation files, SQLite state, and captured artifacts live in that project's
`.carl` directory; `CARL_STATE_DIR` can override it.

To enable chat, set `CARL_PROVIDER` (for example, `anthropic` or `openrouter`), `CARL_MODEL`
(a model ID from the installed Pi provider catalog), and the corresponding
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in the application server's environment
before starting it. Keys stay on the server. These environment settings do not
load a `.env` file automatically. Provider authentication and model availability
are checked by Pi when a run starts; an error is shown if configuration is invalid.
Alternatively, save `defaultProvider` and `defaultModel` in `<stateDir>/pi/settings.json`.
Explicit server environment settings take precedence. ChatGPT/Codex subscription
authentication uses Pi's `openai-codex` provider and `<stateDir>/pi/auth.json`;
credentials stay in ignored local state. No live provider call is part of the test suite.

For the native shell, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
and run `npm run desktop` instead of `npm run dev`. The development shell starts
the same services. A built desktop binary currently needs the Node application
server and Jupyter started separately; bundled sidecars and installers are future
work. See [development notes](docs/development.md) for R/Ark and verification.

## What works in this slice

- Dockable conversation, editor, console, environment, plot, table, context, and
  agent panels. A navigation rail, focus mode, and saved layouts for wide and
  compact windows keep every panel reachable.
- A shared execution queue per language. Human and agent requests use the same
  persistent session; R and Python have separate sessions.
- Exact code, SHA-256, actor, document revision where applicable, kernel/session
  IDs, status, and captured outputs for every execution. Inspection also goes
  through this queue. Interrupted work is recorded; unfinished work is marked
  abandoned on application restart and never replayed automatically.
- One versioned working document shared by the editor and agent. Edits synchronize
  automatically, with local recovery while offline. **Run file** captures an
  acknowledged revision; **Save** writes it to disk. Clean documents follow
  external file edits; unsaved conflicts can be reviewed and reconciled in the editor.
- Separate execution summaries, immutable source records, and an output service.
  Artifact payloads are stored once by content hash. Display updates point to the
  exact immutable artifact retrieved by both the UI and agent.
- Versioned research context, conversation history, and agent-run records. Each
  agent run captures the context version and prompt it received.
- Research notes, message drafts per conversation, and console drafts per language
  survive reloads. Pending saves retain edits made while the request is in flight.
- Searchable object snapshots, automatic table preview navigation, expandable
  figures, PNG downloads in the browser, and links to exact execution sources.
- Markdown conversations, keyboard shortcuts, connection and permission status,
  and accessible focus indicators. Workspace help lists the shortcuts.
- Pi AgentSession streaming, durable conversation history, steering, cancellation,
  retries, skill discovery, and automatic compaction with scientific retention
  instructions. Queued corrections survive cancellation and restart. Existing
  conversations migrate to Pi session files automatically.
- Constrained workspace tools, bounded document reads, and retrieval of recorded
  figures and execution evidence. The scientist reviews the exact proposed code or replacement buffer before an agent
  can execute or edit it. Read and inspection tools are available directly.

The application is a local, single-user prototype. Kernel code has the operating
system permissions of its R/Python process; it is not sandboxed. The Node API is
local-only by default and rejects foreign browser origins. Private proxy access
requires an explicitly configured HTTPS origin. Do not expose it publicly.

Chat loads the selected conversation in pages of 50 messages, with earlier
history available on demand. Pi owns the canonical transcript; a rebuildable
SQLite display index supports pagination and incremental live updates.

The initial snapshot contains the most recent 100 execution summaries. Earlier
records and outputs are paginated; exact source and large output bodies are
retrieved on demand. Plot rendering supports PNG and kernel-scoped display updates.
Tables show at most 100 rows. HTML output is not rendered.

Before agent code runs, a static context check compares its likely inputs and
overwrite targets with activity since that conversation's observations. Relevant
changes return a “not executed” warning; the agent can inspect again or acknowledge
the specific evidence and retry. The check uses recorded R/Python code rather
than deep copies of objects, and reports uncertainty. It does not guarantee that
all inputs are unchanged. See [runtime context checks](docs/architecture.md#runtime-context-checks).

Attachments, a skill installation/management UI, subagent delegation, session-tree
UI, advanced Ark comms/LSP, environment locking, remote compute management, and desktop sidecar
packaging are still to be implemented. Source records capture what ran; they do
not yet capture everything needed for full computational reproducibility.

## The premise

The scientist brings knowledge that may never appear in a paper or dataset: what
an assay actually tells them, which result they distrust, what failed last time,
how a sample was handled, and why an apparently obvious explanation is suspect.
Biologue should be good at drawing that knowledge out, keeping its context intact,
and letting it change what happens next.

The central product question is whether this collaboration produces better
scientific decisions at a reasonable cost in the scientist's attention.

## The behavior to build

- Start with the phenomenon, observation, or decision the scientist cares about.
  Use the context already available before asking for more.
- Ask a focused question when its answer could change an interpretation or next
  action. Make that connection clear. Accept "I don't know" as useful information.
- Keep observations, scientist reports, interpretations, literature claims, and
  working assumptions distinguishable. Preserve the source and scope of each.
- Remember corrections and failed approaches. A correction should change the
  affected reasoning and future behavior, with the earlier version still visible.
- Keep plausible explanations open. Surface evidence against the favored one,
  including when it is the scientist's favorite. Expertise deserves attention;
  claims still need evidence.
- Carry out useful work with the context available. Clarify consequential
  scientific choices without making routine execution a succession of questions.
- Return to the scientific question after a computation. State what the result
  supports, what it leaves unresolved, and what might distinguish the remaining
  explanations.

## The first thing to prove

Take one real, unresolved question from one scientist. Let them work through it
with Biologue across two sessions. In the second session, Biologue should use a piece of
context it learned in the first, with the right scope, and change its reasoning
when the scientist corrects it.

The proposed first artifact is an editable investigation record alongside the
conversation: the question, observations and sources, candidate explanations,
unresolved assumptions, decisions and their rationale, and work already done.
It can begin incomplete. The scientist should not have to fill out a form before
getting help.

The implementation follows the [architecture you supplied](docs/architecture.md).
A real scientific case should determine the next domain integration and how to
evaluate the collaboration.

## Starting material

- [Collaborator prompt](prompts/collaborator.md): a portable behavioral prototype.
- [First-session example and review cases](docs/first-session.md): fictional
  interactions that make the proposed behavior concrete.

These are starting points for discussion and evaluation, not validated evidence
of scientific capability.

## Reference point

Anthropic describes Claude Science as a workbench with scientific tool
integrations, auditable artifacts, and access to compute. That establishes useful
baseline functionality; its announcement alone cannot tell us how well it elicits
scientists' knowledge. Biologue's proposed focus is to make that behavior explicit
and evaluate it directly.

Source: [Claude Science announcement, June 30, 2026](https://www.anthropic.com/news/claude-science-ai-workbench).

Code in this repository is licensed under [MIT](LICENSE). Dependency licenses
remain their own.
