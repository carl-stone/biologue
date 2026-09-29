import { ArrowUpRight, Settings2, Eye, ShieldCheck, Square } from "lucide-react";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import { Badge, timeLabel, useAction } from "../ui.tsx";

export function Controls() {
  const wb = useWorkbench("connected", "showPanel", "setConversation", "revealPermission");
  const { connected } = wb;
  const snapshot = useSnapshot("agent", "permissions", "runs", "conversations");
  const action = useAction();
  return (
    <div className="pane controls">
      <div className="controls-content">
        <div className="control-section agent-heading">
          <h2>
            <Settings2 size={20} />
            Agent settings
          </h2>
          <div className="model-status">
            <span className={`status-dot ${snapshot!.agent.enabled ? "online" : ""}`} />
            {snapshot!.agent.enabled ? snapshot!.agent.model : "No model connected"}
          </div>
          {snapshot!.agent.enabled && <p className="small-note">{snapshot!.agent.provider}</p>}
        </div>
        {!snapshot!.agent.enabled && (
          <div className="control-section model-setup">
            <h3>Set up a model</h3>
            <p>
              A model is needed for conversation. Your editor, console, and data tools are ready to
              use.
            </p>
            <details>
              <summary>Model setup</summary>
              <p>
                Model setup happens in Biologue’s server configuration, using Pi credentials or a
                provider API key. Restart Biologue after configuring it. This panel shows the
                connection status.
              </p>
              <p>
                Custom server setup can select a model with <code>CARL_PROVIDER</code> and{" "}
                <code>CARL_MODEL</code>.
              </p>
            </details>
          </div>
        )}
        <div className="control-section">
          <h3>
            <ShieldCheck size={16} />
            Workspace access
          </h3>
          <div className="access-row">
            <span>
              <Eye size={14} />
              Read & inspect
            </span>
            <Badge>Available</Badge>
          </div>
          <div className="access-row">
            <span>Run code & edit files</span>
            <Badge>Ask first</Badge>
          </div>
          <p>
            Requests appear in the conversation. Each approval applies to one action in your shared
            workspace.
          </p>
        </div>
        <div className="control-section">
          <h3>Recent runs</h3>
          {!snapshot!.runs.length && (
            <p>No runs yet. Start with a question in your conversation.</p>
          )}
          {snapshot!.runs
            .slice(-8)
            .reverse()
            .map((run) => (
              <div className="run-row" key={run.id}>
                <button
                  className="run-conversation"
                  onClick={() => {
                    const request = snapshot.permissions.find((item) => item.runId === run.id);
                    if (request) wb.revealPermission(request);
                    else {
                      wb.setConversation(run.conversationId);
                      wb.showPanel("chat");
                    }
                  }}
                >
                  <span>
                    {snapshot!.conversations.find((item) => item.id === run.conversationId)
                      ?.title || "Investigation"}
                    <ArrowUpRight size={12} />
                  </span>
                  <small>
                    {timeLabel(run.startedAt)} · Context v{run.contextVersion}
                  </small>
                </button>
                <Badge>
                  {snapshot.permissions.some((item) => item.runId === run.id)
                    ? "Waiting for you"
                    : {
                        running: "Working",
                        completed: "Finished",
                        failed: "Failed",
                        cancelled: "Stopped",
                        abandoned: "Session ended",
                      }[run.status]}
                </Badge>
                {run.status === "running" && (
                  <button
                    className="icon"
                    aria-label="Stop run"
                    title="Stop this run"
                    disabled={!connected || action.busy}
                    onClick={() =>
                      void action.run(() => api(`/agent/runs/${run.id}/cancel`, "POST", {}))
                    }
                  >
                    <Square size={13} />
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
