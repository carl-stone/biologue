# Workbench UI review

September 29, 2026. Reviewed the browser workbench with real Python results and
scripted conversation, approval, conflict, and connection states. No model calls.

The subsequent [five-round hands-on product review](product-review-rounds.md)
adds exploratory and adversarial workflows, before/after findings, and regression
coverage for the changes below.
The [interaction-principles review](design/interaction-principles.md) subsequently
moves approvals and requested changes into their conversation, retains decision
history, and keeps execution from taking focus away from the editor.

## Changes

- Followed [Zed's interface](https://zed.dev/) and
  [visual customization](https://zed.dev/docs/visual-customization) as references:
  continuous light surfaces, compact tabs, IBM Plex Sans typography, and fine pane
  dividers. Removed the dark header, icon rail, rounded pane frames, and gutters.
  The generated concept was a direction, not a pixel specification.
- Moved labeled panel navigation, session selection, and layout controls to the
  bottom edge. Below 900 pixels, all eight panel choices remain visible in two
  rows and switch between full-height panels. Existing layouts and local drafts
  are retained.
- Removed the duplicate top tab strips during normal work, recovering 32 pixels
  per pane. Arrange in the bottom bar temporarily reveals tabs for dragging and
  regrouping; Done arranging or Escape hides them. Resizing dividers remains
  available throughout. Restored layouts always start with tabs hidden, and
  small windows omit the redundant panel heading.
- Simplified conversations into a readable transcript; labeled New, Send, and
  Stop actions. Kept research notes freeform with guidance distinguishing
  observations, interpretations, assumptions, and corrections. The Save footer
  remains visible while longer notes and guidance scroll above it.
- Aligned Save and Run with the document, softened Python and R syntax colors,
  and retained exact-code review, source links, object inspection, and output
  recovery. Only existing capabilities have controls; the concept's illustrative
  project search and attachment actions were not introduced.
- Replaced ambiguous action labels with “Run,” “Expand panel,” “Run once,” and
  “Apply edit.” Removed expand controls when a panel already fills the workspace.
- Made approval actions visible in short panels and added a larger exact-code
  review dialog with the same permission controls and visible failure recovery.
- Clarified model setup, run statuses, and code that was proposed but never run.
- Distinguished loading, failed retrieval, and empty results. Retry reloads the
  stored result without executing scientific code. Targeted agent inspections
  no longer make the full object inventory appear to be refreshing.
- Balanced the default conversation and editor widths. Added a growing composer,
  response/code copying, and expandable links from discussion to recorded code
  and artifacts. Conversation is the initial active panel.
- Added protected file creation, selection/current-line execution, a cursor
  indicator, and retained editor undo history across file and layout changes.
- Kept figure selection stable while new results arrive and layouts change;
  added image recovery and filtered table-preview export. Reduced object-row
  spacing without hiding inspection state or source links.
- Preserved dialogs while resizing and scoped Escape to the focused interaction.
  File-load failures now offer recovery within the editor.

## Visual coverage

The review captures 73 screenshots across 1440×960, 1220×768, 1024×768, 900×768,
760×650, 640×760, and 390×844 windows. Coverage includes arrangement mode;
all eight panels; real plots, tables, and objects; populated Markdown
conversations; expanded panels; code review, help,
and new-conversation dialogs; empty projects; offline state; execution errors;
document and context conflicts; result loading and retry; and object pagination.

The automated browser suite additionally checks keyboard navigation, modal focus
return, dragging and restoring arrangements, drafts, conflict handling, approval
decisions, artifact provenance, and accessibility with axe. The native Tauri
window and screen readers were not tested.

## Reproduce

Run commands in `codex-universal`, from `/workspace/biologue`, after
`source /root/.nvm/nvm.sh && nvm use 22`.

Start the isolated review server in one terminal:

```sh
node scripts/ui-server.mjs
```

Then capture the review in another:

```sh
npx esbuild scripts/audits/ui-review.ts --bundle --platform=node --format=esm --packages=external --outfile=test-results/ui-review.mjs
UI_REVIEW_DIR=test-results/ui-review node test-results/ui-review.mjs
```

Screenshots and `findings.json` appear in that directory. Findings include browser
exceptions, page overflow, and clipped controls; intentional code/table scrolling
is allowed. The script uses synthetic states plus the real Python kernel in a
temporary project. Stop the review server before running `npm run test:ui`.
Playwright clears `test-results`, so capture the visual review after running tests.
