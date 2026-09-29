# Browser feedback — September 29, 2026

This pass implements the scientist's 15 annotated comments. It retains the neutral
workbench and conversation/code/results balance, replacing unnecessary forms and
status text with familiar direct actions.

## Changes

| Comments | Result                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | New immediately opens a conversation. Its first message supplies an initial name; Pi supplies a short topic title after the first completed response and after four additional messages. Rename fixes the chosen name, including when an automatic suggestion is already in flight. Existing manually named conversations keep their names. |
| 2        | Research notes describe how they inform Biologue without calling responses “runs.” Chat errors and Stop use ordinary response language.                                                                                                                                                                                                     |
| 3        | Removed the routine connection-success banner. Connection failures still explain which actions are temporarily unavailable.                                                                                                                                                                                                                 |
| 4, 11    | Removed editor revision numbers and the ambiguous Finished link. The console retains exact source; “Earlier code” identifies output from an older document, with revision IDs inside details.                                                                                                                                               |
| 5        | Bottom navigation now moves keyboard focus into the named panel. Tooltips say “Show and focus,” and keyboard shortcuts use the same action.                                                                                                                                                                                                 |
| 6        | Unsaved dots appear in the file tab and Save button. Sync/offline feedback sits beside Save.                                                                                                                                                                                                                                                |
| 7        | New file immediately opens an untitled working document. Naming happens at Save. Untitled text uses the existing shared document service, survives reloads, and can be executed before saving.                                                                                                                                              |
| 8        | The console echoes submitted code and output with language prompts. Its input follows the transcript. Enter executes, Shift+Enter inserts a line, and Up/Down recalls console commands. Exact source, timing and provenance remain accessible.                                                                                              |
| 9        | Console options contain “Include object checks,” with an explanation of the variable/table inspection code this reveals.                                                                                                                                                                                                                    |
| 10       | Removed execution totals from the console toolbar.                                                                                                                                                                                                                                                                                          |
| 12       | The editor has Save, Undo, Redo, Find/replace, Run line/selection, Run all, and interrupt controls. Ctrl/Cmd+Enter runs the selection or current line; Ctrl/Cmd+Shift+Enter runs the whole file. Line execution advances the cursor.                                                                                                        |
| 13       | Default layouts keep Plots inactive until a figure exists. The first figure reveals a results split at wide widths without taking typing focus. Empty Plots has no promotional message or redundant editor button.                                                                                                                          |
| 14       | Model and access settings are attached to the conversation composer. The separate agent-settings pane and duplicate recent-response list are removed; saved layouts migrate the obsolete pane.                                                                                                                                              |
| 15       | File tabs replace the project-file dropdown. Tabs support arrow navigation, closing, unsaved indicators, and an Open file picker. Closing a tab retains unsaved work.                                                                                                                                                                       |

The editor conventions follow Posit's [source and console pane
reference](https://docs.posit.co/ide/user/ide/guide/ui/ui-panes.html) and
[code execution shortcuts](https://docs.posit.co/ide/user/ide/guide/code/execution.html).
Console input/history follows the [RStudio console
reference](https://support.posit.co/hc/en-us/articles/200404846-Working-in-the-Console-in-the-RStudio-IDE).
RStudio's documentation describes a default output pane containing Plots; it does
not establish that the pane always disappears when empty. Biologue's deferred
results split is a product decision based on this feedback.

## Architectural continuity

Untitled documents are stored in the same versioned document service as named
working files. Save creates a project file exclusively, retires the untitled
identity, and preserves its immutable revisions and execution references. It
cannot overwrite an existing file. Other clients' unsent edits remain recoverable
as a new untitled document if Save happens elsewhere. Agent file discovery includes
untitled work; there is no separate agent buffer or execution path.

Automatic titles are UI metadata. A bounded Pi ModelRuntime request sees recent
conversation text, never modifies the scientific transcript, and never uses tools.
Failures retain the initial name. Manual renames win over pending suggestions.
Title requests stop updating storage when the workspace closes.

## Review evidence

Actual browser captures, not generated mockups:

- [R line execution and shared objects](../../designs/feedback/working-r.png)
- [Settings beside the conversation](../../designs/feedback/conversation-settings.png)
- [File tabs and commands at a narrow width](../../designs/feedback/narrow-editor.png)

The first browser pass identified invalid close-button semantics inside the tab
list. Tabs now expose Delete-to-close and retain a pointer close affordance.
A persistence test caught a Save/event race producing duplicate tabs; tab updates
and restored tab lists now deduplicate paths.

The hands-on R pass created an untitled script, executed two lines using the editor
shortcut, checked cursor advancement, and inspected the shared result. Python
end-to-end coverage executes a script, views its figure, inspects/reuses objects,
saves research notes, reloads drafts, and executes a selected code range. Captures
also cover the user's 2111 × 1268 viewport and a 760-pixel layout.

A real GPT-6-Luna request titled a synthetic donor-pairing conversation “Checking
Donor Sample Balance Across Conditions.” Conversation/permission browser fixtures
are synthetic; this is an interaction review, not a scientific quality evaluation.

## Validation

- Build and formatting checks passed.
- All 92 server cases passed across the full suite and focused supervisor recheck.
  The recheck corrected an unintended change to file-list pagination order and
  verified that agents can discover and read untitled documents.
- All 40 browser cases passed across the full suite and focused rechecks. The
  rechecks cover the Save/reload tab race and recovery of unsent edits when another
  client names the same document. Automated accessibility checks passed.
- The real Jupyter integration test passed for shared R/Python execution, inspection,
  artifacts, interruption, and the Pi tool boundary.
- A separate browser check restored the existing version-3 layout: research context
  and the focused conversation were retained, the obsolete settings pane was
  removed, and the empty plots split was retired. No page exceptions occurred.

The native Tauri shell and actual screen-reader navigation were not tested in this
pass. Browsing at different widths and automated accessibility checks do not
establish those behaviors.
