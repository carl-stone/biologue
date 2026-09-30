# Biologue

A scientific workbench where a scientist and agents share project files, live
R/Python sessions, and recorded evidence. The application uses React, Node, Pi,
and Jupyter, with a Tauri desktop shell.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the intended product and marks planned
capabilities. The [development guide](docs/development.md) covers code navigation,
configuration, and checks. For access from another computer, see
[private browser access](docs/remote-access.md).

## Run locally

Requires Node 22.19+ and [uv](https://docs.astral.sh/uv/):

```bash
npm ci
uv sync
npm run dev
```

Open **http://127.0.0.1:5173**. The launcher starts Jupyter, the Node application,
and the workbench. Editing, Python execution, and result inspection work without
model credentials. The default project is `examples/sandbox`, with synthetic data.
R requires the [Ark setup](docs/development.md#r--ark).

In the supplied Docker workspace, edit files and use Git on the host; run the
commands above inside `codex-universal`, following the
[workspace instructions](docs/development.md#supplied-workspace).

For chat, open **Agent settings → Providers**, configure provider credentials,
and select a model. The development guide also covers
[server configuration and Codex sign-in](docs/development.md#pi-and-model-providers).

Set `BIOLOGUE_PROJECT=/absolute/path` before starting to choose another existing
project, or use the workbench's project picker. Each project has separate
conversations, notes, documents, execution records, and kernels. State defaults
to `<project>/.biologue`; back up that entire directory to retain transcripts and
captured artifacts. Restarting Jupyter clears live objects; stored history does
not restore them.

To serve the built workbench with managed Jupyter:

```bash
npm run build
npm run serve
```

Open **http://127.0.0.1:4317**. The API listens locally by default. Private remote
access requires the configuration in the browser-access guide.

## Develop

```bash
npm run build
npm test
npm run lint
```

Kernel changes also need `npm run test:integration`; workbench changes need
`npm run test:ui`. See the development guide for prerequisites and focused checks.
Scientific quality requires evaluation with scientists.

For the native shell, see [desktop development](docs/development.md#desktop-shell).
Development rules are in [AGENTS.md](AGENTS.md).

Code is licensed under [MIT](LICENSE). Dependency licenses remain their own.
