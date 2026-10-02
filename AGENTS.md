# Development rules

For projects under `/root/workspace`, edit files and use Git on the host, but run
install, build, test, lint, and app commands in `codex-universal`. Map
`/root/workspace/...` to `/workspace/...` and use:

```bash
docker exec -i -w <container-project-path> codex-universal bash -lc '<command>'
```

The application requires Node 22.19+. In the supplied container, use
`source /root/.nvm/nvm.sh && nvm use 22` before Node commands.

Keep all human and agent kernel execution in `ExecutionService`, including object
inspection. Preserve exact code and source identity in execution records. Do not
add a separate agent shell or hidden language runtime.

Keep the default agent a clean coding assistant built directly on Pi Durable.
Put domain-specific behavior in project instructions and skills rather than
hardcoded agent policy or custom summary machinery.

For automated maintenance, read [the maintenance charter](docs/agent-maintenance.md).
It defines protected behavior, implementation anchors, and validation requirements.
Agents may substantially refactor implementation while preserving those boundaries.

Run checks appropriate to the changed behavior. Core checks are `npm run build`
and `npm test`; kernel changes also need `npm run test:integration`, and workbench
changes need `npm run test:ui`.
