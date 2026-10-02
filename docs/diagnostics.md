# Developer and agent diagnostics

Every running project writes structured events to
`<stateDir>/diagnostics.sqlite`. Logging starts during application startup and
continues without an open browser. This database is telemetry: it does not own
agent state, schedule tasks, or participate in recovery. Pi Durable remains the
authority for agent history and tasks; execution records and artifacts remain
the authority for code and kernel results.

## Recorded events

| Area                      | Recorded information                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application and process   | Startup, readiness, shutdown, startup/shutdown failures, fatal exceptions and unhandled rejections; Node/application/Pi versions, process ID, optional build revision                                         |
| Agent and Durable         | Run start/recovery/cancellation/outcome, native live-task transitions and ownership, input submission and queue state, retries, compaction, native entry references, integration failures and Durable reports |
| Model                     | Request start/end, model/provider, estimated input size, context version, duration, stop reason and reported usage; request errors                                                                            |
| Tools                     | Name, task/call identifiers, argument **keys**, replay policy, elapsed time, result size/types, execution references, exceptions and returned errors; nested code-mode calls link to their parent call        |
| Kernels                   | Queue/running/dispatch/outcome, exact source hash and document identity, kernel identity, output count, interruption and reconciliation, output/persistence failures, kernel/transport status changes         |
| Permissions and questions | Requests, decisions, waiting duration where available, stable question identifiers; cancellation and denial remain observable                                                                                 |
| Project and services      | Document versions and disk conflicts, context versions and conversation settings, projection/watcher failures, MCP connections/protocol/discovery failures and provider login outcomes                        |
| HTTP                      | Mutation outcomes, failed requests and reads slower than two seconds; route templates, request identifiers, status and duration; thrown errors retain stacks                                                  |

Streaming text, thinking deltas, image bytes, request bodies and routine successful
reads are not copied to telemetry. Agent prompts, tool arguments/results, code
and artifacts are read from their existing stores when investigating. Errors can
contain excerpts; common credentials, authorization headers, credential fields
and sensitive URL parameters are redacted. Error stacks and metadata are bounded.
Diagnostic bundles apply the same redaction and provide links to canonical source
and artifacts rather than embedding their payloads.

Events have a monotonic `id`, `schemaVersion`, UTC `timestamp`, diagnostic
`sessionId`, `component`, event name and severity. Correlation fields include
`runId`, application and native conversation IDs, `taskId`, `toolCallId`,
`executionId` and HTTP `requestId`. Native task IDs are shared with Durable's
records. A recovered call can have multiple attempt events; use their diagnostic
session and timestamps to distinguish attempts. A task leaving the live graph
is recorded as `task.left_graph`, which alone does not assert success.

## Read and export

The local project API provides:

| Endpoint                                  | Purpose                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /api/diagnostics/status`             | Store availability, failed-write count, current session and retention settings                 |
| `GET /api/diagnostics/events`             | Filtered, paginated chronological events                                                       |
| `GET /api/diagnostics/issues`             | Recurring actionable failure groups and their latest evidence                                  |
| `GET /api/diagnostics/live`               | Native Durable inspection: scheduling, live tasks, blocking reasons and submission identifiers |
| `GET /api/diagnostics/bundle?runId=...`   | Run events, execution/output references and current native inspection                          |
| `GET /api/diagnostics/bundle?eventId=...` | Evidence for an individual diagnostic event or failure group                                   |

Event filters include `runId`, `conversationId`, `nativeConversationId`, `taskId`,
`toolCallId`, `executionId`, `requestId`, `sessionId`, `component`, `event`,
`fingerprint`, `level` and `since`. Pages accept `after` (exclusive event ID) and
`limit` (1–1000). Bundles are bounded too; follow the `events.next` and
`nativeEvents.next` cursors using the event endpoint and the corresponding filters.
Source/output URLs resolve relative to the bundle endpoint, preserving project
scoping under `/projects/<id>/api`.

Read logs while Biologue is stopped, without starting a harness or kernel:

```bash
npm run diagnostics -- issues --state-dir /path/to/project/.biologue
npm run diagnostics -- events --state-dir /path/to/project/.biologue --run RUN_ID
npm run diagnostics -- events --state-dir /path/to/project/.biologue --level error --after 100
```

The CLI emits JSON. Use `npm run --silent diagnostics -- ...` when piping output
to another program. It opens SQLite read-only and works while the application is
running as well. It defaults to `BIOLOGUE_STATE_DIR`, or the configured/default
project's `.biologue` directory. Issue reads are project-wide; run, conversation
and component filters apply to event reads.

The agent has a read-only `read_diagnostics` tool for events, issue candidates and
native live status. Event reads default to its current run. Its output is compact
and paginated; the API retains full bounded stacks and metadata for developers.
Reading diagnostics does not execute R/Python code or start another runtime.

## Automated triage

`actionable` means an issue **candidate**, not an established application bug.
Agent code errors may indicate a bad tool choice or failed experiment; provider
and MCP errors may reflect outages or configuration. Human code errors, declined
approvals and normal cancellation do not become candidates. Their events still
exist. Correlate multiple components reporting the same incident before filing
an issue.

Each group has a stable `fingerprint`, first/last occurrence time, affected-run
count, `occurrences`, `signals` and `latestEventId`. Fingerprints normalize changing
IDs, paths and numbers. Several reports of the same execution/call/request count
as one occurrence within a group; `signals` preserves the number of logged reports.
Counts describe retained evidence, not lifetime totals.

A consumer can:

1. Poll issues with its saved `after` cursor. Follow `next` through the current
   pages, then save `watermark` when the response has no next page. This also
   advances through periods containing no new issues.
2. Deduplicate candidates by fingerprint and collect the bundle for
   `sample.id`. Follow execution/entry references for exact evidence. Fetch
   `/diagnostics/live` when work appears stalled; native inspection distinguishes
   waiting tasks from missing definitions.
3. Determine whether the cause belongs to the application, agent behavior,
   project code or an external service. Reproduce it, create a regression test
   where appropriate, and prepare a fix on a branch.
4. Validate the change and monitor the same fingerprint after rollout.

Collection and the triage feed are implemented. There is no scheduled issue
publisher, automatic code modifier or deployment worker. Those consumers can
use this interface without adding another agent/task journal.

## Retention and reliability

The defaults are 90 days and 250,000 events per project. Set
`BIOLOGUE_DIAGNOSTIC_RETENTION_DAYS` (1–3650) and
`BIOLOGUE_DIAGNOSTIC_MAX_EVENTS` (1,000–10,000,000) before starting the server to
change them. Pruning occurs at startup, shutdown and every 500 writes; the count
can exceed the configured cap by up to 499 events between passes. Canonical
history, execution source and artifacts are unaffected.

Pages include `oldestAvailableId`, `watermark` and `cursorGap`. A consumer with an
expired cursor must acknowledge the retention gap rather than assuming complete
coverage. Back up the entire project state directory; SQLite WAL files are part
of a live database.

Diagnostic writes use a separate SQLite connection and database with WAL and
`synchronous=FULL`. Failed logging never converts successful work into a failure.
The collector reports its first storage failure to stderr and exposes failed
write counts and its latest error through the status endpoint. Fatal-error
monitoring preserves Node's termination behavior. Forced termination, a power
failure or a failure to write the diagnostic store can leave an unfinished span
without a terminal event; inspect native recovery and execution records.

`BIOLOGUE_BUILD_REVISION` labels startup events with the revision chosen by the
launcher or release process. Set it to the deployed commit when comparing failures
before and after a fix. Timing events measure wall time, including approval waits
for tool calls; kernel dispatch events separately report queue/setup wait. Run
usage is conversation-wide; model response events provide individual-attempt
usage. Auxiliary conversation-title requests carry `kind: "title"`, a separate
request identifier and usage; they do not count toward the Durable conversation's
usage. Costs remain provider/SDK estimates.
