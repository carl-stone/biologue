# Biologue interaction design

The subsequent [five additional review cycles](review-cycles-two.md) examine all
panels again and record further fixes and verification.

September 29, 2026. This follows the five-round UI review. That review established
useful robustness improvements, but its checks did not establish that the
cross-panel workflow was well designed. Approval requests in the settings pane
were a concrete failure: the scientist had to leave the discussion to answer it.

The recommendations below are Biologue-specific judgments informed by the
sources, not claims that those sources prescribe this exact interface.

## Principles and their application

| Basis                                                                                                                                                                                                                                                                                | Problem in Biologue                                                                                                                              | Implemented response                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NN/g: proximity](https://www.nngroup.com/articles/gestalt-proximity/) explains how spatial grouping communicates relationships.                                                                                                                                                     | A proposal's explanation, approval, and outcome appeared in different places.                                                                    | Put requests in their conversation, ordered with messages. Global review notifications open the correct conversation and focus the request.                                                                     |
| [Nielsen's heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) emphasize visible state, user control, recognizable actions, and useful feedback.                                                                                                                 | Approvals disappeared after a decision; a green action could be confused with successful execution. Running code also switched the active panel. | Retain a compact decision record. Label approval separately from results. Keep keyboard focus in the editor and show a nearby status/output link.                                                               |
| [Microsoft Research's human–AI guidelines](https://www.microsoft.com/en-us/research/articles/guidelines-for-human-ai-interaction-eighteen-best-practices-for-human-centered-ai-design/) cover contextual relevance, dismissal, correction, action consequences, and global controls. | The scientist could accept or decline, but feedback required a separate, ambiguously queued message.                                             | Add Request changes on the proposal. The declined action and scientist's feedback are recorded together, and that feedback reaches the agent. Persistent model/access controls live in Agent settings.          |
| [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) recommends prioritizing common decisions and clearly exposing additional detail.                                                                                                            | Full code in a settings rail competed with configuration; completed decisions would clutter the transcript if left expanded.                     | Pending proposals show their purpose, affected file/session, exact contents, and actions. Past decisions collapse; exact historical content is retrieved when opened.                                           |
| [Google PAIR: mental models](https://pair.withgoogle.com/chapter/mental-models/) recommends making capabilities and consequences understandable through the user's task.                                                                                                             | “Run,” “apply,” and “send context” could conceal different consequences.                                                                         | Identify the shared language session and document revision, compare existing/proposed contents for edits, explain that Apply changes the working document, and label messages queued behind a pending decision. |

These principles do not require a chat-only product. Scientists still need to
write code, examine data, compare figures, and retain research notes. The design
keeps those surfaces directly available, with source links connecting results to
recorded work. Conversation owns the negotiation; documents and artifacts remain
shared objects that either participant can work with.

## Review by surface

- Conversation: proposal → decision/correction → recorded work stays in context.
  A new request does not move focus away from typing or pull the reader to the
  bottom. An explicit Review request action reveals it.
- Editor: running selected code preserves selection and focus. Queued, running,
  finished, and failed work has visible status and an explicit route to output.
  Save and execution still refer to the same versioned working document.
- Figures and tables: retain the previous pass's stable selection, filtering,
  retry, and exact-source links. A successful computation does not validate its
  scientific interpretation.
- Research context: retain freeform observations, assumptions, interpretations,
  and corrections. Context belongs to the scientific work, not a model-settings
  form.
- Agent settings: model configuration, access policy, and recent runs are
  persistent controls. A waiting run links to its conversation's request.
- Whole window: keep the warm neutral surfaces and compact bottom navigation.
  Space and emphasis follow the current task; adding borders or green accents
  cannot repair a misplaced interaction.
  Show review notifications when attention is elsewhere, and reduce them when the
  request is already being reviewed. Keep Latest messages outside the transcript
  so it cannot cover approval controls. Expanded proposals use the same readable
  width as messages.

## Implementation boundaries

Permission decisions were already durable server records. Their summaries now
reach the UI; exact code and previous document contents remain available through
an on-demand endpoint, avoiding large code payloads in every snapshot. The
snapshot includes the most recent 100 decisions. This is recent decision history,
not a complete conversation archive.

Approval, rejection, requested changes, and cancellation have distinct records.
Approval is stored before work is allowed. Feedback from Request changes returns
to the model as the declined tool result. It is not silently submitted as a new
execution or substituted into the approved code. Agent edits still require the
reviewed document revision; human and agent execution still use ExecutionService.

## Acceptance checks

- A request for another investigation cannot appear in the current transcript.
  The global notification opens that request's conversation.
- Approval needs no trip to settings; repeated clicks cannot grant a second run.
- Reload retains the decision. Full historical proposals load only on expansion.
- Requested changes preserve the scientist's text through resizing and failed
  submissions, and do not execute the rejected code.
- File review shows both original and proposed contents with the affected revision.
- New requests preserve reading position and composer focus.
- Running from a narrow editor retains editor focus and selection; output is an
  explicit navigation choice.

## Verification

- `npm test`: 85 tests passed, including durable decisions, feedback delivery,
  rejection without execution, and keeping exact contents out of summary payloads.
- `npm run test:ui`: 31 tests passed, including accessibility checks and real Python
  execution. The new interaction cases exercise conversation routing, decision
  history after reload, requested changes, failure recovery, and preserved focus.
- `npm run test:integration`: shared Python objects, captured plots/errors,
  interruption, and reconnect passed.
- `npm run build` and `npm run lint` passed.

The visual sweep covers all eight panels, empty and populated states, offline and
failure recovery, and seven window sizes from 390 to 1440 pixels wide. It exposed
a clipped Queue message button at 1024 pixels, overlapping Latest messages and
approval controls, and inconsistent proposal widths in expanded conversations.
Those findings were corrected and rechecked.
All 73 captured states passed the overflow/clipping checks without browser
exceptions. Follow-up interaction checks cover the final layout fixes and initial
conversation loading; reopening reveals the pending request while incoming work
preserves an existing reading position.

The [conversation review](../../designs/zed-inspired/collaboration-workbench.png)
shows the implemented interface with scripted agent states. The
[Python workspace](../../designs/zed-inspired/implemented-workbench.png) shows
real computation on synthetic data. This is a Chromium review; native Tauri,
screen-reader usability, R runtime parity, and scientific reasoning were not
evaluated. No model calls were made.

Published heuristics and scripted checks guide this design review. They do not
establish that scientists will find every interaction intuitive. That distinction
was missing from the previous review's conclusion.
