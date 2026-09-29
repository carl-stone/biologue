import { Eye, ShieldCheck } from "lucide-react";
import { useSnapshot } from "../state.tsx";
import { Badge } from "../ui.tsx";

export function Controls() {
  const snapshot = useSnapshot("agent");
  return (
    <div className="pane controls">
      <div className="controls-content">
        <div className="control-section agent-heading">
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
      </div>
    </div>
  );
}
