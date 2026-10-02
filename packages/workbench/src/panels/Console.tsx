import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Image,
  Play,
  Square,
  Table2,
  MoreHorizontal,
  Eraser,
} from "lucide-react";
import type { Execution, ExecutionSummary, Output, DisplayOutput, Page } from "@biologue/protocol";
import { api, useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import { stripAnsi } from "../outputs.ts";
import { Spinner, languageName, useAction, useFollowOutput, useProjectDraft } from "../ui.tsx";

const statuses: Record<Execution["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  abandoned: "Session ended",
  completion_unknown: "Completion unknown",
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
  const { connected, executionTarget } = useWorkbench("connected", "executionTarget");
  const action = useAction();
  const targeted = executionTarget === item.id;
  const version = useOutputVersion(item.id);
  const [before, setBefore] = useState<string>();
  const page = useResource<Page<DisplayOutput>>(
    `/outputs?executionId=${item.id}${before ? `&before=${before}` : ""}`,
    version,
  );
  const outputs = page.data?.items ?? [];
  const source = useResource<Execution>(`/executions/${item.id}`);
  const pending = ["running", "queued"].includes(item.status);
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
  const { language, connected, executionTarget, panelRequest, loadExecutions } = useWorkbench(
    "language",
    "connected",
    "executionTarget",
    "panelRequest",
    "loadExecutions",
  );
  const snapshot = useSnapshot("executions", "executionCursor");
  const outputVersion = useOutputVersion(language);
  const [drafts, setDrafts] = useProjectDraft<Record<string, string>>("console", {});
  const code = drafts[language] || "";
  const [inspections, setInspections] = useState(false);
  const [cleared, setCleared] = useState<string[]>([]);
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
    (item) =>
      !cleared.includes(item.id) &&
      (inspections || item.purpose === "analysis" || item.id === executionTarget),
  );
  const pending = all.filter((item) => ["running", "queued"].includes(item.status));
  const targetVisible = executions.some((item) => item.id === executionTarget);
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
    const observer = new ResizeObserver(scroll.onResize);
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
    if (executionTarget) {
      setCleared((items) =>
        items.includes(executionTarget) ? items.filter((id) => id !== executionTarget) : items,
      );
    }
  }, [executionTarget, panelRequest]);
  useEffect(() => {
    if (executionTarget && targetVisible) {
      // Wait for the requested panel and any restored execution to enter the layout.
      const frame = requestAnimationFrame(() => {
        scroll.pause();
        document.getElementById(`execution-${executionTarget}`)?.scrollIntoView({ block: "start" });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [executionTarget, panelRequest, targetVisible]);
  const history = all
    .filter((item) => item.actor === "human" && item.purpose === "analysis")
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
  function clearConsole() {
    setCleared((current) => [
      ...new Set([
        ...current,
        ...all
          .filter((item) => !["running", "queued"].includes(item.status))
          .map((item) => item.id),
      ]),
    ]);
  }
  return (
    <div
      className="pane console"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          clearConsole();
        }
      }}
    >
      <div className="pane-toolbar console-toolbar">
        <span className={`status-dot ${pending.length ? "waiting" : connected ? "online" : ""}`} />
        <span>{languageName(language)} console</span>
        {pending.length > 0 && <span className="small-note">Running code…</span>}
        <span className="spacer" />
        <button
          className="icon"
          aria-label="Clear console"
          title="Clear console (Ctrl/Cmd+L)"
          onClick={clearConsole}
        >
          <Eraser size={15} />
        </button>
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
            {all.some((item) => cleared.includes(item.id)) && (
              <button className="text-button" onClick={() => setCleared([])}>
                Show cleared output
              </button>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={inspections}
                onChange={(event) => setInspections(event.target.checked)}
              />
              Include object checks
            </label>
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
