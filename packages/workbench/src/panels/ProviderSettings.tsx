import { useEffect, useState } from "react";
import type { AgentProvider, AuthFlow } from "@biologue/protocol";
import { api, useResource, useWorkbench } from "../state.tsx";
import { useAction, Spinner } from "../ui.tsx";

export function ProviderSettings({ onConnected }: { onConnected: () => void }) {
  const providers = useResource<AgentProvider[]>("/agent/providers");
  const [filter, setFilter] = useState("");
  const [flow, setFlow] = useState<AuthFlow>();
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    let closed = false;
    void api<AuthFlow | null>("/agent/auth")
      .then((current) => {
        if (!closed && current) setFlow(current);
      })
      .catch(() => {});
    return () => {
      closed = true;
    };
  }, []);
  const action = useAction();
  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<AuthFlow>(`/agent/auth/${flow.id}`);
        if (stopped) return;
        setFlow(next);
        if (next.status === "complete") {
          providers.retry();
          onConnected();
        }
        if (next.status === "pending") timer = setTimeout(poll, 800);
      } catch {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow?.id, flow?.status]);
  useEffect(() => setAnswer(""), [flow?.prompt?.id]);
  return (
    <div className="settings-section">
      <input
        aria-label="Find provider"
        placeholder="Find provider…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {providers.error && (
        <p role="alert">
          {providers.error} <button onClick={providers.retry}>Retry</button>
        </p>
      )}
      {flow && (
        <div className="auth-flow" aria-live="polite">
          <strong>{flow.provider}</strong>
          {flow.message && <p>{flow.message}</p>}
          {flow.status === "complete" && <p>Connected.</p>}
          {flow.url && /^https?:/.test(flow.url) && (
            <a href={flow.url} target="_blank" rel="noreferrer">
              Open sign-in page ↗
            </a>
          )}
          {flow.code && (
            <p>
              Code: <code>{flow.code}</code>
            </p>
          )}
          {flow.prompt && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  await api(`/agent/auth/${flow.id}/answer`, "POST", {
                    promptId: flow.prompt!.id,
                    value: answer,
                  });
                  setAnswer("");
                  setFlow({ ...flow, prompt: undefined });
                });
              }}
            >
              <label>
                {flow.prompt.message}
                {flow.prompt.options ? (
                  <select value={answer} onChange={(e) => setAnswer(e.target.value)}>
                    <option value="">Choose…</option>
                    {flow.prompt.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={flow.prompt.type === "secret" ? "password" : "text"}
                    autoComplete="off"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder={flow.prompt.placeholder}
                  />
                )}
              </label>
              <button disabled={!answer || action.busy}>Continue</button>
            </form>
          )}
          {flow.status === "pending" && (
            <button
              onClick={() =>
                void action.run(async () => {
                  await api(`/agent/auth/${flow.id}/cancel`, "POST", {});
                  setFlow(undefined);
                })
              }
            >
              Cancel sign-in
            </button>
          )}
          {flow.status !== "pending" && <button onClick={() => setFlow(undefined)}>Done</button>}
        </div>
      )}
      {providers.loading && <Spinner />}
      <div className="provider-list">
        {providers.data &&
          !providers.data.some((item) =>
            `${item.name} ${item.id}`.toLowerCase().includes(filter.toLowerCase()),
          ) && <p className="small-note">No providers match this search.</p>}
        {providers.data
          ?.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(filter.toLowerCase()))
          .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
          .map((provider) => (
            <div key={provider.id} className="provider-row">
              <span>
                {provider.name}
                {provider.connected && <small>Connected</small>}
              </span>
              <div>
                {provider.methods.map((method) => (
                  <button
                    key={method.type}
                    disabled={action.busy || flow?.status === "pending"}
                    onClick={() =>
                      void action.run(async () =>
                        setFlow(
                          await api<AuthFlow>("/agent/auth", "POST", {
                            provider: provider.id,
                            type: method.type,
                          }),
                        ),
                      )
                    }
                  >
                    {method.type === "oauth"
                      ? provider.connected
                        ? "Reconnect"
                        : "Sign in"
                      : provider.connected
                        ? "Update key"
                        : "API key"}
                  </button>
                ))}
                {provider.connected && (
                  <button
                    className="text-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api("/agent/providers/logout", "POST", { provider: provider.id });
                        providers.retry();
                        onConnected();
                      })
                    }
                  >
                    Sign out
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function McpSettings({ onCommand }: { onCommand?: (command: string) => void }) {
  const { notify } = useWorkbench("notify");
  const resource = useResource<{ name: string; config: Record<string, unknown> }[]>("/agent/mcp");
  const action = useAction();
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState(
    '{\n  "url": "https://example.com/mcp",\n  "exposure": "codemode"\n}',
  );
  return (
    <div className="settings-section">
      <p className="small-note">
        Changes apply to the next response. Use <code>${"{ENV_VAR}"}</code> for credentials.
      </p>
      <button onClick={() => onCommand?.("/mcp")}>Check connections</button>
      {resource.error && (
        <p role="alert">
          {resource.error} <button onClick={resource.retry}>Retry</button>
        </p>
      )}
      {resource.data?.map((server) => (
        <div className="provider-row" key={server.name}>
          <button
            className="text-button"
            onClick={() => {
              setName(server.name);
              setConfig(JSON.stringify(server.config, null, 2));
            }}
          >
            {server.name}
          </button>
          <span className="spacer" />
          {"url" in server.config && (
            <button onClick={() => onCommand?.(`/mcp login ${server.name}`)}>Sign in</button>
          )}
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/agent/mcp/${encodeURIComponent(server.name)}`, "PUT", {
                  ...server.config,
                  enabled: server.config.enabled === false,
                });
                resource.retry();
              })
            }
          >
            {server.config.enabled === false ? "Enable" : "Disable"}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/agent/mcp/${encodeURIComponent(server.name)}`, "PUT", null);
                resource.retry();
                if (name === server.name) setName("");
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            setError("");
            try {
              await api(`/agent/mcp/${encodeURIComponent(name)}`, "PUT", JSON.parse(config));
              resource.retry();
              notify("MCP server saved.");
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          });
        }}
      >
        <label>
          Server name
          <input
            aria-label="MCP server name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern={"[a-zA-Z0-9_\\-]+"}
            required
          />
        </label>
        <label>
          Configuration
          <textarea
            className="config-editor"
            aria-label="MCP configuration"
            rows={8}
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            spellCheck={false}
            aria-invalid={!!error}
          />
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button disabled={!name || action.busy}>Save server</button>
      </form>
    </div>
  );
}
