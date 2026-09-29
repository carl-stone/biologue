import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  ChevronRight,
  Image,
  Play,
  Square,
  Table2,
  MoreHorizontal,
} from "lucide-react";
import type { Execution, ExecutionSummary, Output, DisplayOutput, Page } from "@carl/protocol";
import { api, useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import { stripAnsi } from "../outputs.ts";
import {
  CopyButton,
  Spinner,
  languageName,
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
  completion_unknown: "Completion unknown",
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
      {output.truncated && (!full || loaded.loading || loaded.error) && (
        <button
          className="text-button"
          disabled={loaded.loading}
          onClick={() => (full ? loaded.retry() : setFull(true))}
        >
          {loaded.loading ? (
            <>
              <Spinner /> Loading output…
            </>
          ) : loaded.error ? (
            "Retry full output"
          ) : (
            "Read full output"
          )}
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
  const { documents } = useSnapshot("documents");
  const currentDocument = documents.find((doc) => doc.path === item.document?.path);
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
  const source = useResource<Execution>(`/executions/${item.id}`);
  const pending = ["running", "queued"].includes(item.status);
  const duration =
    item.startedAt && item.finishedAt
      ? (new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()) / 1000
      : null;
  return (
    <article className={`execution ${targeted ? "targeted" : ""}`} id={`execution-${item.id}`}>
      {(item.actor !== "human" || pending || item.status !== "succeeded") && (
        <div className="execution-label">
          {item.actor !== "human" && (
            <span>
              {item.actor === "agent" ? "Biologue" : "Workspace"}
              {item.purpose === "inspection" ? " · object check" : ""}
            </span>
          )}
          {item.status !== "succeeded" && (
            <span className={`execution-status ${item.status}`}>
              {pending && <Spinner />}
              {statuses[item.status]}
            </span>
          )}
          {pending && (
            <button
              className="text-button"
              disabled={!connected || action.busy}
              onClick={() =>
                void action.run(() => api(`/executions/${item.id}/cancel`, "POST", {}))
              }
            >
              <Square size={11} />
              {item.status === "running" ? "Interrupt" : "Cancel"}
            </button>
          )}
        </div>
      )}
      <pre className="console-code">
        {(source.data?.code ?? item.codePreview ?? "").split("\n").map((line, index) => (
          <span className="console-code-line" key={index}>
            <span className="console-prompt" aria-hidden="true">
              {index ? "" : item.language === "r" ? ">" : ">>>"}
            </span>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {source.error && (
        <div className="inline-error" role="status">
          <p>{source.error}</p>
          <button onClick={source.retry}>Retry loading code</button>
        </div>
      )}
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={13} />
          <span>{item.document ? item.document.path.split("/").pop() : "Code details"}</span>
          {item.document &&
            currentDocument &&
            currentDocument.version !== item.document.version && (
              <span className="older-code">Earlier code</span>
            )}
        </summary>
        <div className="code-record-heading">
          <span>Recorded code</span>
          {source.data && <CopyButton text={source.data.code} />}
        </div>
        <details className="provenance">
          <summary>Execution details</summary>
          <dl>
            <dt>Submitted</dt>
            <dd>{new Date(item.createdAt).toLocaleString()}</dd>
            {duration !== null && (
              <>
                <dt>Duration</dt>
                <dd>{duration.toFixed(1)}s</dd>
              </>
            )}
            {item.document && (
              <>
                <dt>Source</dt>
                <dd>
                  {item.document.path} · revision {item.document.version}
                  {item.document.selection ? " · selection" : ""}
                </dd>
              </>
            )}
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
      {page.error && (
        <div className="inline-error" role="status">
          <p>{page.error}</p>
          <button onClick={page.retry}>Retry loading output</button>
        </div>
      )}
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
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDraft = useRef("");
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    setHistoryIndex(-1);
    historyDraft.current = "";
  }, [language]);
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
  const transcript = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!scroll.away) scroll.toLatest();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroll.away]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (options.current && !options.current.contains(event.target as Node))
        options.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    if (executionTarget)
      document.getElementById(`execution-${executionTarget}`)?.scrollIntoView({ block: "nearest" });
  }, [executionTarget, executions.some((item) => item.id === executionTarget)]);
  const history = all
    .filter((item) => item.actor === "human" && item.purpose === "analysis" && !item.document)
    .slice()
    .reverse();
  async function recall(direction: number) {
    const next = Math.max(-1, Math.min(history.length - 1, historyIndex + direction));
    if (next === historyIndex) return;
    if (historyIndex === -1) historyDraft.current = code;
    const text =
      next === -1
        ? historyDraft.current
        : (await api<Execution>(`/executions/${history[next].id}`)).code;
    if (languageRef.current !== language) return;
    setHistoryIndex(next);
    setDrafts((current) => ({ ...current, [language]: text }));
  }
  async function submit() {
    if (!code.trim() || !connected) return;
    const submitted = code;
    await api("/executions", "POST", { language, code: submitted });
    setDrafts((current) => ({
      ...current,
      [language]: current[language] === submitted ? "" : current[language],
    }));
    setHistoryIndex(-1);
    scroll.toLatest();
  }
  return (
    <div className="pane console">
      <div className="pane-toolbar console-toolbar">
        <span className={`status-dot ${pending.length ? "waiting" : connected ? "online" : ""}`} />
        <span>{languageName(language)} console</span>
        {pending.length > 0 && <span className="small-note">Running code…</span>}
        <span className="spacer" />
        <details
          className="console-options"
          ref={options}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label="Console options" title="Console options">
            <MoreHorizontal size={16} />
          </summary>
          <div className="console-options-menu">
            <label className="check-label">
              <input
                type="checkbox"
                checked={inspections}
                onChange={(event) => setInspections(event.target.checked)}
              />
              Include object checks
            </label>
            <p>
              Show the code Biologue and the Environment panel use to inspect variables and tables.
            </p>
          </div>
        </details>
      </div>
      <div
        className="console-scroll"
        ref={scroll.scroll}
        onScroll={scroll.onScroll}
        tabIndex={0}
        role="region"
        aria-label="Execution history"
      >
        <div className="console-transcript" ref={transcript}>
          {snapshot.executionCursor && (
            <button className="text-button" onClick={() => void action.run(loadExecutions)}>
              Earlier executions
            </button>
          )}
          {executions.map((item) => (
            <ExecutionItem key={item.id} item={item} />
          ))}
          <form
            className="console-input"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(submit);
            }}
          >
            <span aria-hidden="true">{language === "r" ? ">" : ">>>"}</span>
            <textarea
              aria-label="Console code"
              rows={Math.min(5, code.split("\n").length)}
              value={code}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [language]: event.target.value }))
              }
              placeholder=""
              title="Enter to run · Shift+Enter for a new line · ↑↓ command history"
              onKeyDown={(event) => {
                if (
                  event.key === "ArrowUp" &&
                  event.currentTarget.selectionStart === 0 &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  void action.run(() => recall(1));
                } else if (
                  event.key === "ArrowDown" &&
                  event.currentTarget.selectionEnd === code.length &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  void action.run(() => recall(-1));
                } else if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void action.run(submit);
                }
              }}
            />
            <button
              className="console-submit"
              disabled={!code.trim() || action.busy || !connected}
              aria-label="Run console code"
              title={`Run in ${languageName(language)} (Enter)`}
            >
              {action.busy ? <Spinner /> : <Play size={13} fill="currentColor" />}
              <span>Run</span>
            </button>
          </form>
        </div>
      </div>
      {scroll.away && (
        <button className="jump-latest" onClick={scroll.toLatest}>
          <ArrowDown size={13} />
          Latest output
        </button>
      )}
    </div>
  );
}
