import { useState } from "react";
import type { PermissionRequest } from "@carl/protocol";
import { ArrowUpRight, Bot, Check, Eye, Maximize2, ShieldCheck, Square } from "lucide-react";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import { Badge, CopyButton, Dialog, Spinner, languageName, timeLabel, useAction } from "../ui.tsx";

function PermissionCard({ request }: { request: PermissionRequest }) {
  const { connected, notify } = useWorkbench("connected", "notify");
  const snapshot = useSnapshot("runs", "conversations");
  const action = useAction();
  const [expanded, setExpanded] = useState(false);
  const [decision, setDecision] = useState<boolean>();
  const [error, setError] = useState<string>();
  const execute = request.tool === "execute_code";
  const heading = execute
    ? `Run ${languageName(request.language || "python")} code`
    : "Edit document";
  const run = snapshot!.runs.find((item) => item.id === request.runId);
  const title = snapshot!.conversations.find((item) => item.id === run?.conversationId)?.title;
  const resolve = (allow: boolean) =>
    action.run(async () => {
      setDecision(allow);
      setError(undefined);
      try {
        await api(`/permissions/${request.id}`, "POST", { allow });
        notify(
          allow
            ? "Permission granted for this action."
            : "Request declined. Biologue can continue with your feedback.",
        );
      } catch (error) {
        // A global banner would be hidden behind the modal review dialog.
        setError(error instanceof Error ? error.message : String(error));
      }
    });
  const actions = (
    <>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="permission-actions">
        <button disabled={!connected || action.busy} onClick={() => void resolve(false)}>
          {action.busy && decision === false && <Spinner />}Decline
        </button>
        <button
          className="primary"
          disabled={!connected || action.busy}
          onClick={() => void resolve(true)}
        >
          {action.busy && decision ? <Spinner /> : <Check size={14} />}
          {execute ? "Run once" : "Apply edit"}
        </button>
      </div>
    </>
  );
  return (
    <article className="permission-card">
      <h3>{heading}</h3>
      {title && <span className="small-note">{title}</span>}
      <p>{request.description}</p>
      {request.code && (
        <div className="permission-code">
          <div className="code-record-heading">
            <span>{request.tool === "execute_code" ? "Code to execute" : "Proposed contents"}</span>
            <span className="spacer" />
            <button
              className="icon"
              aria-label="Expand proposed code"
              title="Expand proposed code"
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={14} />
            </button>
            <CopyButton text={request.code} />
          </div>
          <pre>{request.code}</pre>
        </div>
      )}
      {actions}
      {expanded && (
        <Dialog title={heading} onClose={() => setExpanded(false)} className="code-review-dialog">
          <p>{request.description}</p>
          <div className="permission-code">
            <div className="code-record-heading">
              <span>Review the exact {execute ? "code" : "edit"}</span>
              <CopyButton text={request.code ?? ""} />
            </div>
            <pre>{request.code}</pre>
          </div>
          {actions}
        </Dialog>
      )}
    </article>
  );
}

export function Controls() {
  const wb = useWorkbench("connected", "showPanel", "setConversation");
  const { connected } = wb;
  const snapshot = useSnapshot("agent", "permissions", "runs", "conversations");
  const action = useAction();
  return (
    <div className={`pane controls ${snapshot.permissions.length ? "has-permissions" : ""}`}>
      <div className="controls-content">
        <div className="control-section agent-heading">
          <span className="eyebrow">Your collaborator</span>
          <h2>
            <Bot size={22} />
            Agent
          </h2>
          <div className="model-status">
            <span className={`status-dot ${snapshot!.agent.enabled ? "online" : ""}`} />
            {snapshot!.agent.enabled ? snapshot!.agent.model : "No model connected"}
          </div>
          {snapshot!.agent.enabled && <p className="small-note">{snapshot!.agent.provider}</p>}
        </div>
        {snapshot!.permissions.length > 0 && (
          <section aria-label="Permission requests" className="permission-section">
            <div className="section-heading">
              <ShieldCheck size={16} />
              <strong>
                {snapshot!.permissions.length}{" "}
                {snapshot!.permissions.length === 1 ? "request" : "requests"} to review
              </strong>
            </div>
            {snapshot!.permissions.map((request) => (
              <PermissionCard key={request.id} request={request} />
            ))}
          </section>
        )}
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
            Review the exact code or proposed edit before allowing it. Code uses your local R or
            Python process.
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
                    wb.setConversation(run.conversationId);
                    wb.showPanel("chat");
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
                  {
                    {
                      running: "Working",
                      completed: "Finished",
                      failed: "Failed",
                      cancelled: "Stopped",
                      abandoned: "Session ended",
                    }[run.status]
                  }
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
