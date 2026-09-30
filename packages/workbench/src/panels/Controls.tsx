import type { AgentModel } from "@carl/protocol";
import { api, useSnapshot, useResource, useWorkbench } from "../state.tsx";
import { useAction } from "../ui.tsx";

export function Controls() {
  const { agent, runs } = useSnapshot("agent", "runs");
  const { connected } = useWorkbench("connected");
  const catalog = useResource<AgentModel[]>("/agent/models");
  const action = useAction();
  const active = runs.some((run) =>
    ["running", "queued", "awaiting_permission"].includes(run.status),
  );
  const selected = catalog.data?.find(
    (model) => model.provider === agent.provider && model.id === agent.model,
  );
  const thinking = selected?.thinkingLevels.includes(agent.thinking ?? "medium")
    ? (agent.thinking ?? "medium")
    : (selected?.thinkingLevels[0] ?? "off");
  const choose = (model: AgentModel, level: string) =>
    action.run(() =>
      api("/agent/settings", "PUT", {
        provider: model.provider,
        model: model.id,
        thinking: level,
      }),
    );
  return (
    <div className="model-controls">
      <label>
        Model
        <select
          aria-label="Model"
          value={selected ? `${selected.provider}/${selected.id}` : ""}
          disabled={!connected || active || action.busy || !catalog.data?.length}
          onChange={(event) => {
            const model = catalog.data!.find(
              (item) => `${item.provider}/${item.id}` === event.target.value,
            )!;
            void choose(
              model,
              model.thinkingLevels.includes(thinking) ? thinking : model.thinkingLevels[0],
            );
          }}
        >
          {!selected && (
            <option value="">
              {catalog.loading ? "Loading models…" : (agent.model ?? "Choose model")}
            </option>
          )}
          {[...new Set(catalog.data?.map((item) => item.provider))].map((provider) => (
            <optgroup key={provider} label={provider === "openai-codex" ? "ChatGPT" : provider}>
              {catalog.data
                ?.filter((model) => model.provider === provider)
                .map((model) => (
                  <option key={model.id} value={`${provider}/${model.id}`}>
                    {model.name || model.id}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Thinking
        <select
          aria-label="Thinking level"
          value={thinking}
          disabled={
            !selected || active || action.busy || !connected || selected.thinkingLevels.length < 2
          }
          onChange={(event) => selected && void choose(selected, event.target.value)}
        >
          {(selected?.thinkingLevels ?? [thinking]).map((level) => (
            <option key={level} value={level}>
              {level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1)}
            </option>
          ))}
        </select>
      </label>
      {active && <p className="small-note">Stop the response to change models.</p>}
      {catalog.error && (
        <div role="alert">
          {catalog.error} <button onClick={catalog.retry}>Retry</button>
        </div>
      )}
      {!catalog.loading && !catalog.error && !catalog.data?.length && (
        <p>No authenticated models available.</p>
      )}
      <p className="small-note">Code execution and file edits require approval.</p>
    </div>
  );
}
