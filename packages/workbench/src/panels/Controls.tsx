import type { PermissionRequest } from "@carl/protocol";
import { ArrowUpRight, Bot, Check, Eye, ShieldCheck, Square } from "lucide-react";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import { Badge, CopyButton, Spinner, languageName, timeLabel, useAction } from "../ui.tsx";

function PermissionCard({ request }: { request: PermissionRequest }) {
  const { connected, notify } = useWorkbench("connected", "notify");
  const snapshot = useSnapshot("runs", "conversations");
  const action = useAction();
  const run = snapshot!.runs.find((item) => item.id === request.runId);
  const title = snapshot!.conversations.find((item) => item.id === run?.conversationId)?.title;
  const resolve = (allow: boolean) =>
    action.run(async () => {
      await api(`/permissions/${request.id}`, "POST", { allow });
      notify(
        allow
          ? "Permission granted for this action."
          : "Request declined. Biologue can continue with your feedback.",
      );
    });
  return (
    <article className="permission-card">
      <span className="eyebrow">Your review needed</span>
      <h3>
        {request.tool === "execute_code"
          ? `Run ${languageName(request.language || "python")} code`
          : "Edit document"}
      </h3>
      {title && (
        <span className="small-note">
          {title} · context v{run?.contextVersion}
        </span>
      )}
      <p>{request.description}</p>
      {request.code && (
        <div className="permission-code">
          <div className="code-record-heading">
            <span>{request.tool === "execute_code" ? "Code to execute" : "Proposed contents"}</span>
            <CopyButton text={request.code} />
          </div>
          <pre>{request.code}</pre>
        </div>
      )}
      <div className="permission-actions">
        <button disabled={!connected || action.busy} onClick={() => void resolve(false)}>
          Decline
        </button>
        <button
          className="primary"
          disabled={!connected || action.busy}
          onClick={() => void resolve(true)}
        >
          {action.busy ? <Spinner /> : <Check size={14} />}Allow once
        </button>
      </div>
    </article>
  );
}

export function Controls() {
  const wb = useWorkbench("connected", "showPanel", "setConversation");
  const { connected } = wb;
  const snapshot = useSnapshot("agent", "permissions", "runs", "conversations");
  const action = useAction();
  return (
    <div className="pane controls">
      <div className="control-section agent-heading">
        <span className="eyebrow">Scientific collaborator</span>
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
          <h3>Connect your collaborator</h3>
          <p>
            You can already edit, run code, and inspect your data. Connect a model to think through
            the science with Biologue.
          </p>
          <details>
            <summary>Model setup</summary>
            <p>
              When starting Biologue, set <code>CARL_PROVIDER</code> to <code>anthropic</code> or{" "}
              <code>openrouter</code>, choose <code>CARL_MODEL</code>, and add the provider’s API
              key to the server environment.
            </p>
            <p>Restart Biologue after changing these settings.</p>
          </details>
        </div>
      )}
      <div className="control-section">
        <h3>
          <ShieldCheck size={16} />
          Tool access
        </h3>
        <div className="access-row">
          <span>
            <Eye size={14} />
            Read & inspect
          </span>
          <Badge>Available</Badge>
        </div>
        <div className="access-row">
          <span>Run code & edit buffers</span>
          <Badge>Ask first</Badge>
        </div>
        <p>
          Review the exact code or proposed edit before allowing it. Code uses your local R or
          Python process.
        </p>
      </div>
      <div className="control-section">
        <h3>Recent runs</h3>
        {!snapshot!.runs.length && <p>No runs yet. Start with a question in your conversation.</p>}
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
                  {snapshot!.conversations.find((item) => item.id === run.conversationId)?.title ||
                    "Investigation"}
                  <ArrowUpRight size={12} />
                </span>
                <small>
                  {timeLabel(run.startedAt)} · Context v{run.contextVersion}
                </small>
              </button>
              <Badge>{run.status}</Badge>
              {run.status === "running" && (
                <button
                  className="icon"
                  aria-label="Stop run"
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
      <div className="control-section small-note">
        One collaborator, one shared workspace. Delegation and installable skills are planned.
      </div>
    </div>
  );
}
