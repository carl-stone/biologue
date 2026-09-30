# Harness capabilities

Research checked 2026-09-30 against product documentation and the installed Pi 0.99.1 SDK.

| Source                                                 | Useful patterns for Biologue                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [Codex](https://learn.chatgpt.com/docs/prompting)      | Distinct steer/queue actions, attachments, editable pending inputs, task organization.                            |
| [Claude Code](https://code.claude.com/docs/en/desktop) | Model and permission modes beside the composer, file references, project instructions, skills, change review.     |
| [T3 Code](https://github.com/pingdotgg/t3code)         | Provider capabilities surfaced honestly, searchable tasks, keyboard access, review before source-control actions. |
| [Goose](https://block.github.io/goose/)                | Provider choice, MCP extensions, reusable skills and recipes.                                                     |
| [OpenCode](https://opencode.ai/docs/tui/)              | Command palette/slash commands, context compaction, export, session navigation.                                   |

## Reuse boundaries

Pi already supplies model/auth catalogs, supported thinking levels, persistent session trees, steering/follow-up queues, context estimates, usage, compaction, retries, resource discovery and prompt expansion. Use its APIs; do not build another agent loop.

Pi packages supply extensions, skills, prompts and terminal themes. They do not supply React/Dockview controls. Biologue needs a small browser bridge for Pi's select/input/confirm dialogs, plus presentation and durable workspace metadata.

| Package                                                                                                                  | Decision                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-ask-user](https://github.com/edlsh/pi-ask-user) 0.15.1                                                               | Reuse the existing question tool through Pi's standard dialog API. Compatible with our SDK; has an RPC fallback.                                         |
| Native Pi MCP, code mode and tool search                                                                                 | Enabled using SDK extension factories. Nested calls retain the existing permission and scientific execution paths. No additional MCP adapter dependency. |
| [pi-mcp-client](https://github.com/mavam/pi-mcp-client) / [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Reviewed; superseded here by the native MCP support added in Pi 0.99.                                                                                    |
| [pi-harness-runtime](https://github.com/ManotLuijiu/pi-harness-runtime)                                                  | An autonomous harness with its own orchestration is not needed on top of AgentSession/Supervisor.                                                        |
| [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui)                                                                    | Reference implementation, not an embeddable replacement for the shared scientific workspace.                                                             |
| Local Biologue science package                                                                                           | Own scientific retention, project-context injection and reusable analysis prompts; keep transport, credentials and kernel implementation in the host.    |

All R/Python execution and object inspection continue through ExecutionService. Conversation branching does not rewind live kernels or files. Full Git/worktree isolation, arbitrary subprocess tools, unattended schedules and terminal-only UI packages are separate product capabilities, not switches to enable blindly in this shared-session IDE.

## Implemented browser surfaces

Per-conversation model, thinking and permissions; complete Pi catalog with connected-provider filtering and favorites; provider OAuth/API-key challenges; MCP configuration and native commands; prompt/skill discovery; steer/follow-up queues; attachments; context/usage and manual compaction; automatic retry/compaction settings; extension questions; search, archive, pin, Markdown export and conversation branching; keyboard command palette.

Only explicitly integrated extensions load executable code. Arbitrary Pi terminal interfaces do not become browser controls. MCP stdio commands are server transports, not an agent shell. MCP tools without a read-only annotation require approval in Ask mode. Code mode has no filesystem/network APIs or auxiliary model calls; scientific computations must call execute_code.
