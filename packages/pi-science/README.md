# Biologue science for Pi

This workspace package supplies `review-analysis` and `handoff` prompt templates,
and exports `createScientificExtension` for Pi Durable hosts. It retains observations,
interpretations, assumptions and corrections through compaction and injects the
scientist's current research context.

The host supplies the research context, context observer, model runtime, durable
harness, and retry policy. Scientific summaries pin their source and notes in
task memos, record successful and failed attempts with their usage atomically,
and decline visibly on failure. Raw evidence remains in durable history.
Biologue binds these policies to its shared execution service and browser UI;
Pi Durable owns the model loop and task scheduling.

The prompts can also be installed in a regular Pi session with
`pi install /absolute/path/to/packages/pi-science`. The extension factory requires
a host to supply the bindings; installing the prompts alone does not provide
Biologue's workspace tools or browser UI.
