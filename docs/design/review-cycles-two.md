# Five additional workbench review cycles

September 29, 2026. Follow-up to the [interaction-principles review](interaction-principles.md).
Each cycle used the browser, examined the design consequences, made focused
changes, and revisited the affected interaction. The established neutral styling
and balance between conversation, editing, and shared results remain the basis.

## 1. Arrival, orientation, and research context

Opened the real workspace, saved research notes, created another investigation,
switched between conversations, read help, opened model setup, and resized to a
laptop window. The empty states and bottom navigation remained legible; notes
stayed available when starting a new investigation.

The research-context wording did not make its scope sufficiently clear. The new
conversation dialog could suggest a copied set of notes. Both surfaces now say
that conversations share the project's research context. This explains a real
consequence of editing notes without adding a new control or another form.

Rechecked the saved notes and updated copy in the browser. Settings remains a
destination for model/access information; scientific context remains separate.

## 2. Proposal review while the document changes

Reviewed a proposed edit, changed the script manually, expanded the review,
entered feedback, resized with the dialog open, and returned to the inline card.

The server already refused outdated revisions, but the UI still offered approval
and labeled the proposal's old text as current. It now identifies original
contents, explains when the document has changed, and disables approval while
retaining Decline and Request changes. The check includes local edits still
waiting to synchronize. Server revision checks remain authoritative.

Visual inspection also found code boxes extending beyond the review card.
Their grid column now stays within the card and long code scrolls internally.
The Review request cue now tracks the bottom of the request, so it remains
available when the decision controls are below the visible transcript.

Rechecked inline and expanded review, long lines, retained feedback at 760 pixels,
and absence of permission submissions when approval is unavailable.
See the [changed-document review](../../designs/zed-inspired/proposal-changed.png).

## 3. Editing, execution, and shared sessions

Ran the synthetic Python script, opened its exact recorded source, made additional
console executions, inspected objects, previewed the table, edited the script,
and returned to earlier output. Also created `review_values <- c(2, 4, 8)`, ran
`mean(review_values)` through the shared R session, and inspected `review_values`.

The editor's Finished label could sit beside changed code without identifying
that the result belonged to an earlier revision. Its output link now includes
the recorded revision when local edits or a newer document revision exist.
Opening it still reveals the original code. Editing and running keep the expected
focus behavior; switching languages clearly identifies the session being viewed.

Rechecked the revised label, historical code, Python table contents, and basic R
execution/inspection. No new runtime or execution path was introduced.

## 4. Results, provenance, and recovery

Followed a filtered table back to its inspection record, expanded a real Python
figure, and forced failures retrieving a console output list, full output, and
recorded source. Figures and tables already provided local recovery. The console
could instead leave a retrieval error with no retry action.

Added local retries for all three console retrieval failures and loading feedback
for full output. Retrying fetches stored records; it does not run scientific code.
The existing preview remains visible while requesting full output.

The expanded figure view enlarged a 590-by-340 PNG to fill a roughly 1420-by-784
area, visibly blurring labels. Images now scale down as needed while preserving
their natural resolution when the pane is larger.

Rechecked successful retrieval after failure, exact code, absence of execution
requests during recovery, table source navigation, and the corrected figure view.
See the [figure at its natural resolution](../../designs/zed-inspired/figure-natural-size.png).

## 5. Keyboard control, arrangement, and varied navigation

Started with the editor focused, used panel shortcuts, left drafts in chat and
console, and visited all eight panels. Alt+1 highlighted Conversation but left
typing focus in the editor. Panel shortcuts now move focus into the destination;
read-only panes focus their existing named tab panels. A regression test caught
duplicate landmarks in the first implementation; the corrected version reuses
Dockview's accessibility structure.

After reloading the changed application, rechecked actual typing destinations.
Ran 120 seeded navigation/help/shortcut/resize interactions (seed 29092027),
covering widths of 390, 820, 1100, 1440, and 1600 pixels. Chat and console drafts
survived. Then dragged research context into the editor group and reset the
arrangement; the notes and drafts remained intact. No application exceptions or
horizontal page overflow occurred in that pass.

The persistent browser driver needed bundling before it could inject its test
fixtures correctly. That tooling failure was separate from the application;
fixture bootstrap errors were excluded from the application findings.

## Verification and limits

Four regression cases cover outdated proposals (including unsynchronized edits),
console retrieval recovery without execution, earlier-revision output labels,
and keyboard focus/draft continuity. Existing coverage checks approval routing,
dialogs, history, conflicts, artifact browsing, editor commands, and accessibility.

The hand-operated browser pass captured 35 screenshots. The subsequent 73-state
sweep found no application exceptions, horizontal page overflow, or clipped
controls. Internal scrolling of code and tables is intentional.

`npm test` passed all 85 server tests. All 35 browser cases passed across the full
run and focused rechecks: the full run passed 34, and the keyboard case passed
after correcting its panel focus target. Compact-layout and automated
accessibility cases were also rechecked. `npm run build` and `npm run lint` passed.

Review screenshots are retained locally in `test-results/review-two`; the broader
visual sweep is in `test-results/review-two-sweep`. Conversation and permission
states are scripted; Python and the basic R examples use the real shared kernels.
This review does not establish scientific reasoning quality, complete R/Python
feature parity, native Tauri behavior, or screen-reader usability. No model calls
were made.
