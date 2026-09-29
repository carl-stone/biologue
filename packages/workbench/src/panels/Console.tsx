import { memo, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  ChevronRight,
  Image,
  Square,
  Table2,
  Terminal,
} from "lucide-react";
import type { Execution, ExecutionSummary, Output, DisplayOutput, Page } from "@carl/protocol";
import { api, useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import { stripAnsi } from "../outputs.ts";
import {
  Badge,
  CopyButton,
  Spinner,
  languageName,
  modifier,
  timeLabel,
  useAction,
  useFollowOutput,
  useProjectDraft,
} from "../ui.tsx";

const statuses: Record<Execution["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  abandoned: "Session ended",
  not_executed: "Needs review · not run",
};

function OutputView({ output, execution }: { output: DisplayOutput; execution: ExecutionSummary }) {
  const { revealArtifact } = useWorkbench("revealArtifact");
  const [full, setFull] = useState(false);
  const loaded = useResource<Output>(full ? `/outputs/${output.id}` : null);
  const text =
    loaded.data?.text ||
    (typeof loaded.data?.data?.["text/plain"] === "string"
      ? loaded.data.data["text/plain"]
      : output.preview);
  return (
    <>
      {text && (
        <pre className={output.kind === "error" ? "output-error" : "output-text"}>
          {stripAnsi(text)}
        </pre>
      )}
      {output.truncated && !full && (
        <button className="text-button" onClick={() => setFull(true)}>
          Read full output
        </button>
      )}
      {loaded.error && <p className="output-error">{loaded.error}</p>}
      {output.mimeTypes.includes("image/png") && (
        <button className="output-link" onClick={() => revealArtifact(execution, output, "plots")}>
          <Image size={14} />
          View figure
          <ArrowUpRight size={13} />
        </button>
      )}
      {output.table && (
        <button className="output-link" onClick={() => revealArtifact(execution, output, "data")}>
          <Table2 size={14} />
          View table
          <ArrowUpRight size={13} />
        </button>
      )}
    </>
  );
}

const ExecutionItem = memo(function ExecutionItem({ item }: { item: ExecutionSummary }) {
  const { connected, executionTarget, expandExecution } = useWorkbench(
    "connected",
    "executionTarget",
    "expandExecution",
  );
  const action = useAction();
  const targeted = executionTarget === item.id;
  const [expanded, setExpanded] = useState(targeted && expandExecution);
  useEffect(() => {
    if (targeted && expandExecution) setExpanded(true);
  }, [targeted, expandExecution]);
  const version = useOutputVersion(item.id);
  const [before, setBefore] = useState<string>();
  const page = useResource<Page<DisplayOutput>>(
    `/outputs?executionId=${item.id}${before ? `&before=${before}` : ""}`,
    version,
  );
  const outputs = page.data?.items ?? [];
  const source = useResource<Execution>(expanded ? `/executions/${item.id}` : null);
  const pending = ["running", "queued"].includes(item.status);
  const duration =
    item.startedAt && item.finishedAt
      ? (new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()) / 1000
      : null;
  return (
    <article className={`execution ${targeted ? "targeted" : ""}`} id={`execution-${item.id}`}>
      <div className="execution-label">
        <Badge>
          {item.actor === "human" ? "You" : item.actor === "agent" ? "Biologue" : "System"}
        </Badge>
        {item.purpose === "inspection" && <span>Inspection</span>}
        <span className={`execution-status ${item.status}`}>
          {item.status === "running" && <span className="pulse" />}
          {statuses[item.status]}
        </span>
        <span className="spacer" />
        <time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time>
        {duration !== null && <span>{duration.toFixed(1)}s</span>}
        {pending && (
          <button
            className="text-button"
            disabled={!connected || action.busy}
            onClick={() => void action.run(() => api(`/executions/${item.id}/cancel`, "POST", {}))}
          >
            <Square size={11} />
            {item.status === "running" ? "Interrupt" : "Cancel"}
          </button>
        )}
      </div>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={13} />
          <span>
            {item.document
              ? `${item.document.path} · revision ${item.document.version}`
              : item.codePreview}
          </span>
        </summary>
        <div className="code-record">
          <div className="code-record-heading">
            <span>Exact code executed</span>
            {source.data && <CopyButton text={source.data.code} />}
          </div>
          <pre>{source.data?.code ?? source.error ?? "Loading exact source…"}</pre>
        </div>
        <details className="provenance">
          <summary>Execution details</summary>
          <dl>
            <dt>Execution</dt>
            <dd>{item.id}</dd>
            <dt>SHA-256</dt>
            <dd>{item.codeHash}</dd>
            {item.kernelId && (
              <>
                <dt>Kernel</dt>
                <dd>{item.kernelId}</dd>
              </>
            )}
          </dl>
        </details>
      </details>
      {page.error && <p className="output-error">{page.error}</p>}
      {page.data?.next && (
        <button className="text-button" onClick={() => setBefore(page.data!.next)}>
          Earlier output
        </button>
      )}
      {before && (
        <button className="text-button" onClick={() => setBefore(undefined)}>
          Latest output
        </button>
      )}
      {outputs.map((output) => (
        <OutputView key={output.slotId} output={output} execution={item} />
      ))}
      {item.error && !outputs.some((output) => output.kind === "error") && (
        <pre className="output-error">{item.error}</pre>
      )}
      {item.status === "succeeded" && page.data && !outputs.length && (
        <p className="output-note">Finished with no output.</p>
      )}
    </article>
  );
});

export function Console() {
  const { language, connected, executionTarget, loadExecutions } = useWorkbench(
    "language",
    "connected",
    "executionTarget",
    "loadExecutions",
  );
  const snapshot = useSnapshot("executions", "executionCursor");
  const outputVersion = useOutputVersion(language);
  const [drafts, setDrafts] = useProjectDraft<Record<string, string>>("console", {});
  const code = drafts[language] || "";
  const [inspections, setInspections] = useState(false);
  const action = useAction();
  const all = snapshot!.executions.filter((item) => item.language === language);
  const executions = all.filter(
    (item) => inspections || item.purpose === "analysis" || item.id === executionTarget,
  );
  const pending = all.filter((item) => ["running", "queued"].includes(item.status));
  const latest = executions.at(-1);
  const scroll = useFollowOutput(
    `${executions.length}:${latest?.status}:${outputVersion}`,
    language,
    executions.length > 0,
  );
  useEffect(() => {
    if (executionTarget)
      document.getElementById(`execution-${executionTarget}`)?.scrollIntoView({ block: "nearest" });
  }, [executionTarget, executions.some((item) => item.id === executionTarget)]);
  async function submit() {
    if (!code.trim() || !connected) return;
    const submitted = code;
    await api("/executions", "POST", { language, code: submitted });
    setDrafts((current) => ({
      ...current,
      [language]: current[language] === submitted ? "" : current[language],
    }));
    scroll.toLatest();
  }
  return (
    <div className="pane console">
      <div className="pane-toolbar console-toolbar">
        <span className={`status-dot ${pending.length ? "waiting" : "online"}`} />
        <span>{languageName(language)}</span>
        <span className="small-note">
          {pending.length
            ? `${pending.length} active / queued`
            : executions.length
              ? `${executions.length} ${executions.length === 1 ? "execution" : "executions"}`
              : "Ready when you are"}
        </span>
        <span className="spacer" />
        <label className="check-label">
          <input
            type="checkbox"
            checked={inspections}
            onChange={(event) => setInspections(event.target.checked)}
          />
          Inspections
        </label>
      </div>
      <div
        className="console-scroll"
        ref={scroll.scroll}
        onScroll={scroll.onScroll}
        tabIndex={0}
        role="region"
        aria-label="Execution history"
      >
        {!executions.length && (
          <div className="console-welcome">
            <Terminal size={20} />
            <div>
              <strong>A shared {languageName(language)} session</strong>
              <p>
                Run a script or try an expression. You and Biologue work with the same live objects.
              </p>
              <span className="small-note">
                {modifier}+Enter to execute · Shift+Enter for a new line
              </span>
            </div>
          </div>
        )}
        {snapshot.executionCursor && (
          <button className="text-button" onClick={() => void action.run(loadExecutions)}>
            Earlier executions
          </button>
        )}
        {executions.map((item) => (
          <ExecutionItem key={item.id} item={item} />
        ))}
      </div>
      {scroll.away && (
        <button className="jump-latest" onClick={scroll.toLatest}>
          <ArrowDown size={13} />
          Latest output
        </button>
      )}
      <form
        className="console-input"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(submit);
        }}
      >
        <span aria-hidden="true">›</span>
        <textarea
          aria-label="Console code"
          rows={Math.min(5, code.split("\n").length)}
          value={code}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [language]: event.target.value }))
          }
          placeholder={language === "python" ? "Enter Python code…" : "Enter R code…"}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void action.run(submit);
            }
          }}
        />
        <button
          className="console-submit"
          disabled={!code.trim() || action.busy || !connected}
          aria-label="Run console code"
          title={`Run in ${languageName(language)} (${modifier}+Enter)`}
        >
          {action.busy ? <Spinner /> : <ArrowUpRight size={17} />}
        </button>
      </form>
    </div>
  );
}
