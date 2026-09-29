# Workbench UI review

September 29, 2026. Reviewed the browser workbench with real Python results and
scripted conversation, approval, conflict, and connection states. No model calls.

## Changes

- Retained the sidebar and light neutral palette; added panel gutters, quieter
  tabs, consistent spacing, and comfortable reading widths in expanded panels.
- Widened the default conversation pane. Below 900 pixels, the sidebar switches
  between full-height panels. Existing desktop layouts are retained; old narrow
  split layouts are replaced. Local drafts survive layout changes.
- Replaced ambiguous action labels with “Run,” “Expand panel,” “Run once,” and
  “Apply edit.” Removed expand controls when a panel already fills the workspace.
- Made approval actions visible in short panels and added a larger exact-code
  review dialog with the same permission controls and visible failure recovery.
- Clarified model setup, run statuses, and code that was proposed but never run.
- Distinguished loading, failed retrieval, and empty results. Retry reloads the
  stored result without executing scientific code. Targeted agent inspections
  no longer make the full object inventory appear to be refreshing.

## Visual coverage

The review captures 68 screenshots across 1440×960, 1024×768, 760×650, 640×760,
and 390×844 windows. Coverage includes all eight panels; real plots, tables, and
objects; populated Markdown conversations; expanded panels; code review, help,
and new-conversation dialogs; empty projects; offline state; execution errors;
document and context conflicts; result loading and retry; and object pagination.

The automated browser suite additionally checks keyboard navigation, modal focus
return, drafts, conflict handling, approval decisions, artifact provenance, and
accessibility with axe. The native Tauri window and screen readers were not tested.

## Reproduce

Run commands in `codex-universal`, from `/workspace/carl-harness`, after
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
