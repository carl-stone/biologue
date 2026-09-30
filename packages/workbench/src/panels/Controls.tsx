import { useState } from "react";
import type { AgentModel, AgentResources, AgentSettings, PermissionMode } from "@carl/protocol";
import { api, useSnapshot, useResource, useWorkbench } from "../state.tsx";
import { useAction, useProjectDraft } from "../ui.tsx";
import { ProviderSettings, McpSettings } from "./ProviderSettings.tsx";

type Preferences = {
  autoCompact: boolean;
  autoRetry: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
};
export function Controls({ onInsert }: { onInsert?: (text: string) => void }) {
  const { agent, runs, conversations } = useSnapshot("agent", "runs", "conversations");
  const { connected, conversation } = useWorkbench("connected", "conversation");
  const [section, setSection] = useState("Model");
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const [favorites, setFavorites] = useProjectDraft<string[]>("favorite-models", []);
  const catalog = useResource<AgentModel[]>("/agent/models?all=true");
  const resources = useResource<AgentResources>(
    section === "Resources" ? "/agent/resources" : null,
  );
  const preferences = useResource<Preferences>(
    section === "Behavior" ? "/agent/preferences" : null,
  );
  const action = useAction();
  const current = conversations.find((item) => item.id === conversation)?.settings ?? agent;
  const active = runs.some(
    (run) => run.conversationId === conversation && run.status === "running",
  );
  const selected = catalog.data?.find(
    (model) => model.provider === current.provider && model.id === current.model,
  );
  const thinking = selected?.thinkingLevels.includes(current.thinking ?? "medium")
    ? (current.thinking ?? "medium")
    : (selected?.thinkingLevels[0] ?? "off");
  const choose = (
    model: AgentModel,
    level: string,
    mode = (current as AgentSettings).mode ?? "ask",
  ) =>
    action.run(() =>
      api(`/conversations/${conversation}/settings`, "PUT", {
        provider: model.provider,
        model: model.id,
        thinking: level,
        mode,
      }),
    );
  const visible = catalog.data?.filter(
    (model) =>
      (all || model.available !== false || model === selected) &&
      `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="model-controls">
      <div className="settings-tabs" role="tablist" aria-label="Agent settings sections">
        {["Model", "Providers", "MCP", "Resources", "Behavior"].map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={section === tab}
            onClick={() => setSection(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      {section === "Providers" ? (
        <ProviderSettings onConnected={catalog.retry} />
      ) : section === "MCP" ? (
        <McpSettings onCommand={onInsert} />
      ) : section === "Resources" ? (
        <div className="settings-section">
          {resources.error && (
            <p role="alert">
              {resources.error} <button onClick={resources.retry}>Retry</button>
            </p>
          )}
          <div className="resource-list">
            {resources.data?.prompts.map((item) => (
              <button
                key={item.name}
                title={item.description}
                onClick={() => onInsert?.(`/${item.name} `)}
              >
                /{item.name}
                <small>{item.description}</small>
              </button>
            ))}
            {resources.data?.skills.map((item) => (
              <button
                key={item.path}
                title={item.path}
                onClick={() => onInsert?.(`/skill:${item.name} `)}
              >
                {item.name}
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          {resources.data?.instructions.map((item) => (
            <details key={item.path}>
              <summary>{item.path.split("/").at(-1)}</summary>
              <pre className="instruction-preview">{item.content}</pre>
            </details>
          ))}
          {resources.data?.diagnostics.map((message, i) => (
            <p key={i} className="small-note">
              {message}
            </p>
          ))}
          <p className="small-note">
            Pi loads trusted project skills and prompts. Installed: pi-ask-user · Biologue science.
            MCP and code mode are built into Pi 0.99.1.
          </p>
        </div>
      ) : section === "Behavior" ? (
        <div className="settings-section">
          {preferences.data && (
            <>
              {(
                [
                  ["autoCompact", "Compact context automatically"],
                  ["autoRetry", "Retry transient provider errors"],
                ] as const
              ).map(([key, label]) => (
                <label className="checkbox-label" key={key}>
                  <input
                    type="checkbox"
                    checked={preferences.data![key]}
                    disabled={action.busy}
                    onChange={(e) =>
                      void action.run(async () => {
                        await api("/agent/preferences", "PUT", {
                          ...preferences.data,
                          [key]: e.target.checked,
                        });
                        preferences.retry();
                      })
                    }
                  />
                  {label}
                </label>
              ))}
              {(
                [
                  ["steeringMode", "Steering messages"],
                  ["followUpMode", "Queued messages"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <select
                    value={preferences.data![key]}
                    onChange={(e) =>
                      void action.run(async () => {
                        await api("/agent/preferences", "PUT", {
                          ...preferences.data,
                          [key]: e.target.value,
                        });
                        preferences.retry();
                      })
                    }
                  >
                    <option value="one-at-a-time">One at a time</option>
                    <option value="all">Together</option>
                  </select>
                </label>
              ))}
            </>
          )}
          {preferences.error && (
            <p role="alert">
              {preferences.error} <button onClick={preferences.retry}>Retry</button>
            </p>
          )}
        </div>
      ) : (
        <>
          <input
            aria-label="Find model"
            placeholder="Find model or provider…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
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
                  {catalog.loading ? "Loading models…" : (current.model ?? "Choose model")}
                </option>
              )}
              {[...new Set(visible?.map((item) => item.provider))].map((provider) => (
                <optgroup
                  key={provider}
                  label={provider === "openai-codex" ? "ChatGPT (Codex)" : provider}
                >
                  {visible
                    ?.filter((model) => model.provider === provider)
                    .sort(
                      (a, b) =>
                        Number(favorites.includes(`${b.provider}/${b.id}`)) -
                          Number(favorites.includes(`${a.provider}/${a.id}`)) ||
                        a.name.localeCompare(b.name),
                    )
                    .map((model) => (
                      <option
                        key={model.id}
                        value={`${provider}/${model.id}`}
                        disabled={model.available === false}
                      >
                        {favorites.includes(`${provider}/${model.id}`) ? "★ " : ""}
                        {model.name || model.id}
                        {model.available === false ? " — sign in" : ""}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="settings-inline">
            <label className="checkbox-label">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              Show all providers
            </label>
            {selected && (
              <button
                className="text-button"
                onClick={() => {
                  const key = `${selected.provider}/${selected.id}`;
                  setFavorites(
                    favorites.includes(key)
                      ? favorites.filter((item) => item !== key)
                      : [...favorites, key],
                  );
                }}
              >
                {favorites.includes(`${selected.provider}/${selected.id}`)
                  ? "★ Favorite"
                  : "☆ Favorite"}
              </button>
            )}
          </div>
          <label>
            Thinking
            <select
              aria-label="Thinking level"
              value={thinking}
              disabled={
                !selected ||
                active ||
                action.busy ||
                !connected ||
                selected.thinkingLevels.length < 2
              }
              onChange={(e) => selected && void choose(selected, e.target.value)}
            >
              {(selected?.thinkingLevels ?? [thinking]).map((level) => (
                <option key={level} value={level}>
                  {level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permissions
            <select
              aria-label="Permission mode"
              value={(current as AgentSettings).mode ?? "ask"}
              disabled={!selected || active || action.busy || !connected}
              onChange={(e) =>
                selected && void choose(selected, thinking, e.target.value as PermissionMode)
              }
            >
              <option value="ask">Ask before edits and execution</option>
              <option value="plan">Plan · read and inspect</option>
              <option value="edit">Allow edits · ask before execution</option>
              <option value="auto">Allow edits and execution</option>
            </select>
          </label>
          {selected?.contextWindow && (
            <p className="small-note">
              {selected.contextWindow.toLocaleString()} context ·{" "}
              {selected.input?.includes("image") ? "Text and images" : "Text"}
              {selected.subscription ? " · Subscription" : ""}
            </p>
          )}
          {active && <p className="small-note">Stop the response to change settings.</p>}
          {catalog.error && (
            <div role="alert">
              {catalog.error} <button onClick={catalog.retry}>Retry</button>
            </div>
          )}
          {!catalog.loading &&
            !catalog.error &&
            !catalog.data?.some((model) => model.available !== false) && (
              <button onClick={() => setSection("Providers")}>Connect a provider</button>
            )}
        </>
      )}
    </div>
  );
}
