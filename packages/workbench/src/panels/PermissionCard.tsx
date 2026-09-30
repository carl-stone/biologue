import { useEffect, useRef, useState } from "react";
import { Check, Maximize2, MessageSquare, ShieldCheck } from "lucide-react";
import type {
  PermissionRequest,
  PermissionDecision,
  PermissionDecisionSummary,
} from "@biologue/protocol";
import { api, useResource, useSnapshot, useWorkbench } from "../state.tsx";
import { CopyButton, Dialog, Spinner, languageName, useAction, useProjectDraft } from "../ui.tsx";

type Request = PermissionRequest | PermissionDecisionSummary;
const heading = (request: Request) =>
  request.tool === "execute_code"
    ? `Run ${languageName(request.language || "python")} code`
    : request.tool === "edit_document"
      ? request.document
        ? `Edit ${request.document.path}`
        : "Edit document"
      : `Run ${request.tool}`;

function ExactProposal({ request, expand }: { request: PermissionRequest; expand?: () => void }) {
  const external = !["execute_code", "edit_document"].includes(request.tool);
  return (
    <div className="proposal-contents">
      {request.before !== undefined && (
        <div className="permission-code">
          <div className="code-record-heading">
            Original contents · revision {request.document?.version}
          </div>
          <pre>{request.before || "(Empty document)"}</pre>
        </div>
      )}
      <div className="permission-code">
        <div className="code-record-heading">
          <span>
            {external
              ? "Arguments"
              : request.tool === "execute_code"
                ? "Code"
                : "Proposed contents"}
          </span>
          <span className="spacer" />
          {expand && (
            <button
              className="icon"
              aria-label={external ? "Expand tool request" : "Expand proposed code"}
              title={external ? "Expand tool request" : "Expand proposed code"}
              onClick={expand}
            >
              <Maximize2 size={14} />
            </button>
          )}
          <CopyButton text={request.code ?? ""} />
        </div>
        <pre>{request.code || (external ? "(No arguments)" : "(Empty document)")}</pre>
      </div>
    </div>
  );
}

function PastProposal({ id }: { id: string }) {
  const result = useResource<PermissionDecision>(`/permissions/${id}`);
  if (result.error)
    return (
      <div className="inline-error" role="alert">
        <p>{result.error}</p>
        <button onClick={result.retry}>Retry loading proposal</button>
      </div>
    );
  if (!result.data)
    return (
      <p role="status">
        <Spinner /> Loading proposal…
      </p>
    );
  return <ExactProposal request={result.data} />;
}

function Decision({ request }: { request: PermissionDecisionSummary }) {
  const [open, setOpen] = useState(false);
  const label =
    request.decision === "allow"
      ? "Approved"
      : request.decision === "cancelled"
        ? "Cancelled"
        : request.feedback
          ? "Changes requested"
          : "Declined";
  return (
    <details
      className="permission-decision"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{label}</span> · {heading(request)}
      </summary>
      <p>{request.description}</p>
      {request.feedback && (
        <blockquote>
          <strong>Your feedback</strong>
          <p>{request.feedback}</p>
        </blockquote>
      )}
      {open && <PastProposal id={request.id} />}
    </details>
  );
}

function PendingProposal({ request }: { request: PermissionRequest }) {
  const { connected, drafts } = useWorkbench("connected", "drafts");
  const { documents } = useSnapshot("documents");
  const current = documents.find((document) => document.path === request.document?.path);
  const draft = request.document && drafts[request.document.path];
  const changed =
    !!request.document &&
    ((!!current && current.version !== request.document.version) ||
      (!!draft && draft.content !== current?.content));
  const action = useAction();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useProjectDraft(`permission-feedback:${request.id}`, "");
  const [changing, setChanging] = useState(!!feedback);
  const [decision, setDecision] = useState<boolean>();
  const [error, setError] = useState<string>();
  const execute = request.tool === "execute_code";
  function resolve(allow: boolean, feedback?: string) {
    if (allow && changed) return;
    return action.run(async () => {
      setDecision(allow);
      setError(undefined);
      try {
        await api(`/permissions/${request.id}`, "POST", {
          allow,
          ...(feedback ? { feedback } : {}),
        });
        setFeedback("");
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    });
  }
  const actions = (
    <>
      {changed && (
        <p className="proposal-changed" role="status">
          The document changed after this proposal. Request changes so Biologue can review it again.
        </p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {changing ? (
        <form
          className="permission-feedback"
          onSubmit={(event) => {
            event.preventDefault();
            if (feedback.trim()) void resolve(false, feedback.trim());
          }}
        >
          <label htmlFor={`feedback-${request.id}`}>What should Biologue change?</label>
          <textarea
            id={`feedback-${request.id}`}
            autoFocus
            maxLength={5000}
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <p className="small-note">Declines this action and sends your feedback to Biologue.</p>
          <div className="permission-actions">
            <button type="button" disabled={action.busy} onClick={() => setChanging(false)}>
              Back
            </button>
            <button className="primary" disabled={!connected || action.busy || !feedback.trim()}>
              {action.busy && <Spinner />}Send changes
            </button>
          </div>
        </form>
      ) : (
        <div className="permission-actions">
          <button
            className="text-button request-changes"
            disabled={!connected || action.busy}
            onClick={() => setChanging(true)}
          >
            <MessageSquare size={13} />
            Request changes
          </button>
          <span className="spacer" />
          <button disabled={!connected || action.busy} onClick={() => void resolve(false)}>
            {action.busy && decision === false && <Spinner />}Decline
          </button>
          <button
            className="primary"
            disabled={!connected || action.busy || changed}
            onClick={() => void resolve(true)}
          >
            {action.busy && decision ? <Spinner /> : <Check size={14} />}
            {execute ? "Run once" : request.tool === "edit_document" ? "Apply edit" : "Allow once"}
          </button>
        </div>
      )}
    </>
  );
  return (
    <article className="permission-card" aria-label={heading(request)}>
      <div className="permission-heading">
        <ShieldCheck size={14} />
        <span>Needs your approval</span>
      </div>
      <h3>{heading(request)}</h3>
      {request.document && (
        <p className="proposal-target">
          <code>{request.document.path}</code> · revision {request.document.version}
        </p>
      )}
      <p>{request.description}</p>
      {execute && (
        <p className="small-note">
          Uses your shared {languageName(request.language || "python")} session.
        </p>
      )}
      <ExactProposal request={request} expand={() => setExpanded(true)} />
      {!expanded && actions}
      {expanded && (
        <Dialog
          title={heading(request)}
          onClose={() => setExpanded(false)}
          className="code-review-dialog"
        >
          <p>{request.description}</p>
          <ExactProposal request={request} />
          {actions}
        </Dialog>
      )}
      <span className="permission-end" aria-hidden="true" />
    </article>
  );
}

/** The same conversation item remains after the decision, with detail on demand. */
export function PermissionCard({ request }: { request: Request }) {
  const element = useRef<HTMLDivElement>(null);
  const resolved = "decision" in request;
  const wasPending = useRef(!resolved);
  useEffect(() => {
    if (resolved && wasPending.current && document.activeElement === document.body)
      element.current?.focus({ preventScroll: true });
    wasPending.current = !resolved;
  }, [resolved]);
  return (
    <div
      id={`permission-${request.id}`}
      className="conversation-request"
      tabIndex={-1}
      ref={element}
    >
      {"decision" in request ? (
        <Decision request={request} />
      ) : (
        <PendingProposal request={request} />
      )}
    </div>
  );
}
