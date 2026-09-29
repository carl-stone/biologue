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

Keep scientific observations, interpretations, assumptions, and corrections
distinguishable. A successful computation does not validate its interpretation.
Use the scientist's context to change behavior, and ask questions when their
answers matter to the next scientific decision.

Run checks appropriate to the changed behavior. Core checks are `npm run build`
and `npm test`; kernel changes also need `npm run test:integration`, and workbench
changes need `npm run test:ui`. Scientific quality requires domain review and
cannot be established by the scripted provider tests.
