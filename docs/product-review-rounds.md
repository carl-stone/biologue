# Hands-on product review

September 29, 2026. Goal: at least five distinct rounds of browser interaction,
product critique, fixes, and rechecking. The product should give scientific
conversation, human analysis, and shared results comparable importance.

This review uses an isolated project and real Python execution. Deterministic
conversation fixtures exercise collaboration, permissions, and failure states;
they do not assess a model's scientific judgment. Browser actions and screenshots
are recorded locally in `test-results/product-review`.

See the [implemented collaboration view](../designs/zed-inspired/collaboration-workbench.png)
and [live Python workspace](../designs/zed-inspired/implemented-workbench.png).

## Round 1 — Arrival and orientation

Opened the workbench, read help, created a named investigation, authored and saved
research context, drafted a question, opened model setup, and resized to a laptop
window. Checked what the initial hierarchy says about the product and whether
each empty state offers a useful next action.

Findings:

- The conversation received 359 pixels while the editor received 739. This
  emphasized coding even when the next task was discussing the experiment.
- The empty conversation kept asking for a research note after notes were saved.
- The unconfigured model correctly kept the question editable and explained why
  sending was unavailable. Creating a conversation and saving notes worked.

Changes: balanced default conversation/editor widths, selected Conversation in
new layouts, and stopped repeating the research-note invitation after notes exist.
Existing saved arrangements are retained.

## Round 2 — Discussion and shared work

Read a substantial answer containing code and a table, entered a seven-line
correction, inspected the run panel, and followed recorded computation.

Findings:

- The composer stayed 62 pixels tall for 146 pixels of text, hiding most of the
  correction while the surrounding workspace had ample space.
- Responses and fenced code lacked copy actions.
- The discussion had no route to the run's recorded code or artifacts.

Changes: the composer grows with its content up to a bounded height; responses
and code blocks have copy actions; a compact, expandable Workspace activity
section links a run's discussion to its exact execution and captured artifacts.
Artifact requests are lazy and do not execute scientific code.

## Round 3 — Hands-on analysis

Ran Python against the shared kernel, inspected objects, previewed a data frame,
opened find/replace, switched files after editing, attempted undo, created a
script, executed a selection and a line, saved, resized, and tested name collisions.

Findings and changes:

- Switching files lost undo history. A bounded, in-memory editor history now
  retains undo/redo and cursor position across file switches and pane remounts.
  It restores only when its text matches the working document.
- Default CodeMirror key bindings took precedence over Biologue's run commands.
  Run shortcuts now have explicit priority and are checked through the browser.
- Added file creation with overwrite protection and project-path validation.
- Added selected-code and current-line execution. The server validates the exact
  range against the recorded document revision; all runs still use
  ExecutionService. The menu and help expose the shortcuts.
- Added a cursor-position indicator and styled find/replace consistently.

Real Python checks confirmed that executing a selection does not run surrounding
statements. Server tests reject mismatched ranges, external paths, and attempts
to overwrite existing or unsaved work.

## Round 4 — Results as shared artifacts

Generated multiple real Python figures, browsed backward, generated another
figure, inspected and previewed data, and deliberately failed image requests.

Findings and changes:

- A new figure displaced the older figure being reviewed. Selection now follows
  a stable display slot; new output follows automatically only at the latest view.
- Failed PNG requests showed a broken image with no action. Added explicit image
  failure and retry while retaining the selected record; retry never runs code.
- Historical figure requests could temporarily show an unrelated latest figure.
  Requested-artifact loading and failure states now identify that request.
- Pagination's return-to-latest action was hidden if an earlier page was empty
  or unavailable. History navigation now remains available independently.
- Added filtering of the captured table preview and export of visible rows to
  CSV. Quoting preserves embedded delimiters and newlines; row counts and the
  preview limit remain explicit.
- A final resize check found that layout reconstruction also reset figure
  selection. Figure browsing and table filters now survive panel remounts;
  regression tests cover this alongside new-output arrival.

## Round 5 — Adversarial interaction and recovery

Entered a long correction while reading earlier messages; resized with a dialog
open; dismissed search in an expanded editor; forced a file-load failure; edited
offline and reloaded; then performed 120 seeded random interactions (seed 20260929) across navigation, focus, arrangement, resizing, language switching,
help, research guidance, run menus, and file selection.

Findings and changes:

- The latest-message shortcut overlapped a growing composer. It is now anchored
  to the transcript, independently of composer height.
- Responsive layout reconstruction closed modals and discarded their input.
  Breakpoint changes now wait until the modal closes, then retain the active pane.
- Escape dismissed editor search and expanded mode together. Workspace keyboard
  handling now respects events already handled by the focused control.
- An unreadable file displayed an endless opening state under a global error.
  The editor now shows a local failure and retry action.
- Hiding arrangement tabs could leave keyboard focus on hidden content. Focus
  now returns to a visible layout/navigation control.
- Tightened object-row spacing so the right pane shows more useful state.

The random pass retained chat and console drafts with no browser errors or
horizontal page overflow. Undo/redo, modal text, and explicit recovery paths were
also rechecked directly.

## Verification

The follow-up visual sweep captured 73 states across seven window sizes, in
addition to 36 screenshots from the five hands-on rounds. The final sweep found
no browser exceptions, horizontal page overflow, or clipped controls. Intentional
scrolling within code and tables is allowed.

Six new browser regression tests cover chat copying and recorded-work links;
editor history and run shortcuts; modal/keyboard continuity; file recovery;
filtered table export; and figure selection, history, and recovery. Existing
tests now also exercise the growing composer while reading earlier messages and
real selected-code execution from a newly created file. Two server tests check
file creation and exact source-range validation.

Final checks passed:

- `npm run build` and `npm run lint`.
- `npm test`: 84 tests.
- `npm run test:ui -- --output=test-results/rounds-ui`: 28 tests, including
  automated accessibility checks and the real Python workbench flow.
- `npm run test:integration`: shared Python state, captured plots/errors,
  interruption, and reconnect.

The first integration launch exceeded its Jupyter startup deadline while build
and browser work were running concurrently. After reducing that load, the rerun
passed without code changes.

This is a Chromium browser review with real Python computation and scripted
agent/permission states. It does not establish scientific reasoning quality,
native Tauri behavior, R editor/runtime parity, or screen-reader usability.
Those require their own testing. No model calls were made for this review.
