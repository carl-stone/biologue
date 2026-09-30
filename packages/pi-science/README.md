# Biologue science for Pi

This workspace package supplies `review-analysis` and `handoff` prompt templates,
and exports `createScientificExtension` for SDK hosts. It retains observations,
interpretations, assumptions and corrections through compaction and injects the
scientist's current research context.

The host supplies the research context, message attribution, context observer,
model stream and retry settings. Biologue binds these to its durable conversation
records and shared execution service. This is an SDK integration, not a second
agent loop or kernel.

The prompts can also be installed in a regular Pi session with
`pi install /absolute/path/to/packages/pi-science`. The extension factory requires
a host to supply the bindings; installing the prompts alone does not provide
Biologue's workspace tools or browser UI.
