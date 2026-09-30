# Workspace cleanup — September 30, 2026

Implemented the second set of 17 browser comments:

- Removed execution disclosures, hashes, IDs, revision labels, and echoed editor/agent scripts from Console. Direct console input still appears as command history. Exact source and identity remain in ExecutionService records.
- Enter sends messages; Shift+Enter inserts a line. IME composition does not send.
- Model and thinking selectors use Pi's authenticated model catalog and supported levels, including Max where available. Settings persist; a running response must finish or stop before changing models.
- Removed chat onboarding copy, research shortcuts, repeated research headings, permanent Saved text, generic file-tab icons, and the Environment illustration.
- Environment refreshes automatically after code executes. Refreshes use ExecutionService, coalesce repeated requests, and carry the system actor without agent observation receipts.
- Data opens named tables directly and refreshes a selected live table after code changes without taking keyboard focus. Historical artifacts remain fixed.
- Actual panel groups have tabs. Single panels only expose a small drag grip while arranging.
- Help contains a short arrangement instruction and keyboard shortcuts.
- The project button opens a folder browser. Each folder has separate documents, conversations, notes, executions, settings, and kernels. Project URLs isolate simultaneous browser tabs. Unsaved buffers persist when switching folders.

Verification covers server persistence and request boundaries, real R/Python kernels, project working directories and variable isolation, browser keyboard behavior, model selection, table filtering/export, folder switching, and wide/narrow layouts. Scientific interpretation is not assessed by these UI and execution checks.

Release checks: build and formatting passed; 95 server tests and 45 browser tests passed across the full runs and targeted rechecks. Real-kernel integration verified R/Python behavior and project isolation. The deployed browser exposed all nine Codex models returned by Pi and reported no page errors. Deployment preserved document contents and versions, conversations, notes, executions, and agent runs; restarting the managed runtime cleared live variables.
