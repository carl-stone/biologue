# Verification after the architecture refactor and runtime context checks

Verified in `codex-universal` on September 28, 2026, using Node 22.22.2 and Pi 0.87.1:

| Check                                                 | Result                                      |
| ----------------------------------------------------- | ------------------------------------------- |
| TypeScript check and production frontend/server build | Passed                                      |
| Core service and AgentSession tests                   | 74 passed                                   |
| Live Jupyter integration with `CARL_TEST_R=1`         | Passed with Python and Ark/R                |
| Chromium workbench and UI regressions                 | 16 passed, including automated axe checks   |
| Tauri `cargo check`                                   | Passed September 26; Rust code unchanged    |
| npm dependency audit                                  | No vulnerabilities reported at installation |

The live integration drives scripted model tool calls through the real
AgentSession, permissions, and ExecutionService, and verifies that human and
agent submissions use the same kernel within each language, and that R and Python use different kernels. They
also cover outputs, Python exceptions and interruption, R plots and data-frame
inspection, reconnecting to a surviving Python session, and a display update produced by a later execution. The latter verifies that the displayed artifact and retrieved artifact have the same immutable ID and bytes.

Runtime-context integration exercises human changes during agent approval waits
in both Python and R. It verifies that a warning prevents dispatch, fresh inspection
allows a retry, and a Python kernel restart with the same kernel ID invalidates
earlier observations.

The architecture regressions additionally cover:

- Agent startup rollback, permission-decision write failures, independent cleanup
  after disposal/publication failures, and cancellation despite failed run writes.
- Conversation pagination, stable cursors during arrivals, incremental indexing
  without historical rescans, index reconstruction from Pi, and branch invalidation
  without resurrecting consumed inputs. Snapshots never open dormant transcripts.
- Late HTTP pages during conversation switches and reconnects, newer live delivery
  status winning over stale pages, and retryable history-loading failures.

- A revert typed during an outstanding document request, SSE acknowledgement with
  a lost HTTP response, offline recovery, stale remote edits, and no-op updates.
- External disk conflicts, reviewed-hash reconciliation, and recovery after a file
  rename but before its saved revision was committed.
- Bounded output events, source/payload separation, paged output references, and
  migration of existing records without changing their artifact IDs.
- Display-slot updates within and across executions, with kernel-scoped identities
  and immutable historical artifacts.
- Subscriber exceptions, persistence failures at execution start/completion,
  shutdown of human and agent work, and late callbacks from an unresponsive kernel.
- Source analysis for R/Python reads, writes, possible aliases, incomplete syntax,
  and opaque calls; relevant changes after queue waits; failed and interrupted
  computations remaining potential change evidence; unrelated writes passing.
- Conversation-specific observations, bounded inspection coverage, historical
  artifacts retaining their original checkpoint, and explicit acknowledgment
  limited to the shown evidence, exact code, conversation, and kernel generation.
- Document changes during approval waits, warnings reaching AgentSession without
  executing code, refresh and acknowledgment retries, and detailed warning evidence
  staying out of bounded UI history and event payloads.
- Compact tool content without execution-record envelopes, grouped warning evidence,
  bounded file/output/artifact pages with usable continuations, single-representation
  artifact reads, and image attachments omitted from text continuation pages.
- Observation receipts still reaching the checker through Pi's `details`, with
  historical checkpoints retained and unseen truncated objects never credited.

The browser workflow covers running the example file, reusing its objects from
the console, viewing a table, saving scientific context, retaining an unsaved
document buffer through reload, saving that buffer to disk with the keyboard,
copying a table, filtering objects, and downloading a PNG. Screenshots from
this test are in `test-results/workspace-empty.png` and
`test-results/workspace.png`.

The UI regression suite also covers compact and narrow layouts, panel focus and
keyboard navigation, separate conversation drafts, draft retention while
disconnected, file-language routing, concurrent document/context conflicts,
edits made during a pending save, duplicate submission guards, permission grants
and denials, error recovery, history scroll position, matching older figures
to their exact source, selected-conversation pagination with reading-position retention,
retrying failed page loads, and queued corrections remaining visible after cancellation
without duplicate messages when delivery completes. These state tests use an explicitly scripted event stream
and API fixture; the main workspace workflow uses the real server and Python
kernel.

Automated axe checks scan the initial workspace, research context, agent, data,
and help dialog against WCAG 2 A/AA and 2.1 AA rules. They do not substitute for
screen-reader or native webview testing. Browser layout inspection also covers
1440×960, 1000×740, 900×650, and 640×760 windows.

The AgentSession tests use the production PiAdapter and `createAgentSession`,
with an injected scripted provider and no external model calls. They cover:

- Exact-code approval, source revisions, streaming, denial, and interruption of
  the shared execution service.
- Reopening Pi session files, legacy SQLite migration, display-only corrections,
  interrupted tool batches, and preserving input before Pi's first disk flush.
- Corrected research notes reaching a later request; queued corrections surviving
  provider errors, cancellation, and restart; distinct IDs for repeated text.
- SDK transient-error recovery, runs longer than twelve tool turns, and correct
  failure status for unrecovered truncation and aborts.
- Native skill discovery, bounded reads of unsaved buffers, kernel errors reaching
  the model as tool errors, and captured PNGs reaching image-capable models.
- Scientific retention instructions on ordinary and split-turn compaction,
  original history remaining accessible, fresh notes after compaction, visible
  compaction failure without a generic fallback, and preflight cancellation.

These assertions verify delivery and integration mechanics. They do not establish
that a live model elicits knowledge well, preserves every scientific distinction
in a summary, or chooses a sound analysis. Those require the domain review cases
in [first-session.md](first-session.md).

The earlier native check compiles the Tauri shell's Rust code and validates its resources;
it does not launch a graphical window or produce an installer. A live provider
smoke test, native GUI test, and scientist-led evaluation remain outstanding.
