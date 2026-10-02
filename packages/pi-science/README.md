# Biologue science for Pi

This workspace package supplies `review-analysis` and `handoff` prompt templates,
and exports `createScientificExtension` for Pi Durable hosts. It retains observations,
interpretations, assumptions and corrections through compaction and injects the
scientist's current research context.

The host supplies the research context, context observer, registry, durable harness,
and model-request guard. Scientific compaction pins its exact source and notes,
then submits a summary request to a native conversation owned by the compaction
task. Pi Durable owns that request's checkpoints, retries, cancellation, response,
and usage. The hook returns its completed text for native compaction placement;
failure stops the run without falling back to a generic summary. Raw evidence and
the summary request remain in durable history. The browser aggregates parent and
child usage for display without duplicating native accounting.

Biologue's tools are native Pi Durable registrations. Shared scientific execution
and inspection remain in `ExecutionService`; browser approvals and questions are
application services. Pi's standalone MCP and code-mode packages supply protocol
clients and the tool orchestration sandbox without a Coding Agent session or
extension runner. Resource loading, model credentials, and preferences use Pi's
public utilities.

The prompts can also be installed in a regular Pi session with
`pi install /absolute/path/to/packages/pi-science`. Installing prompts alone does
not provide Biologue's workspace tools or browser UI.
