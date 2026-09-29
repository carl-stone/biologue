import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Download,
  Image,
  Maximize2,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import type {
  ExecutionSummary,
  Execution,
  DisplayOutput,
  OutputReference,
  Page,
  InspectionResult,
  TableResult,
} from "@carl/protocol";
import { api, base, useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import { Badge, CopyButton, Empty, Spinner, languageName, timeLabel, useAction } from "../ui.tsx";

function SourceDetails({ execution }: { execution: ExecutionSummary }) {
  const { revealExecution } = useWorkbench("revealExecution");
  return (
    <div className="artifact-footer">
      <span>
        {execution.document?.path ||
          (execution.purpose === "inspection" ? "Object inspection" : "Console")}{" "}
        ·{" "}
        {execution.actor === "agent" ? "Biologue" : execution.actor === "human" ? "You" : "System"}{" "}
        · {timeLabel(execution.createdAt)}
      </span>
      <button className="text-button" onClick={() => revealExecution(execution)}>
        View source <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

export function Plots() {
  const { language, showPanel, artifactTarget } = useWorkbench(
    "language",
    "showPanel",
    "artifactTarget",
  );
  const snapshot = useSnapshot("executions");
  const version = useOutputVersion(language);
  const [before, setBefore] = useState<string>();
  useEffect(() => setBefore(undefined), [language]);
  const page = useResource<Page<DisplayOutput>>(
    `/outputs?language=${language}&kind=plots${before ? `&before=${before}` : ""}`,
    version,
  );
  const targetId =
    artifactTarget?.panel === "plots" && artifactTarget.language === language
      ? artifactTarget.outputId
      : undefined;
  const pinned = useResource<OutputReference>(targetId ? `/outputs/${targetId}/reference` : null);
  const plots: DisplayOutput[] = [...(page.data?.items ?? [])];
  if (pinned.data && !plots.some((plot) => plot.id === pinned.data!.id))
    plots.push({
      ...pinned.data,
      slotId: `historical:${pinned.data.id}`,
      ownerExecutionId: pinned.data.executionId,
    });
  const targetIndex = plots.findIndex((plot) => plot.id === targetId);
  const [selected, setSelected] = useState(0);
  const latest = plots.length - 1;
  useEffect(() => setSelected(Math.max(0, latest)), [latest, language]);
  useEffect(() => {
    if (targetIndex >= 0) setSelected(targetIndex);
  }, [targetIndex, artifactTarget, language]);
  const index = Math.min(selected, latest);
  const plot = plots[index];
  const src = plot ? `${base}/api/outputs/${plot.id}/png` : "";
  const known = snapshot.executions.find((item) => item.id === plot?.executionId);
  const source = useResource<Execution>(plot && !known ? `/executions/${plot.executionId}` : null);
  const execution = known ?? source.data;
  return (
    <div className="pane plots">
      {plot ? (
        <>
          <div className="pane-toolbar figure-toolbar">
            <button
              className="icon"
              aria-label="Previous figure"
              title="Previous figure"
              disabled={index <= 0}
              onClick={() => setSelected((value) => value - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="figure-count" aria-live="polite">
              Figure {index + 1} <span>of {plots.length}</span>
            </span>
            <button
              className="icon"
              aria-label="Next figure"
              title="Next figure"
              disabled={index >= latest}
              onClick={() => setSelected((value) => value + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <span className="spacer" />
            <a
              className="icon icon-link"
              aria-label="Download figure"
              title="Download PNG"
              href={src}
              download={`biologue-${language}-figure-${plot.id}.png`}
            >
              <Download size={16} />
            </a>
            <button
              className="icon"
              aria-label="Expand figure"
              title="Expand figure"
              onClick={() => showPanel("plots", true)}
            >
              <Maximize2 size={15} />
            </button>
          </div>
          {page.data?.next && (
            <button className="text-button" onClick={() => setBefore(page.data!.next)}>
              Earlier figures
            </button>
          )}
          {before && (
            <button className="text-button" onClick={() => setBefore(undefined)}>
              Latest figures
            </button>
          )}
          <div className="figure">
            <img
              alt={`Plot from ${execution?.actor ?? "recorded"} execution ${plot.executionId}`}
              src={src}
            />
          </div>
          {execution && <SourceDetails execution={execution} />}
        </>
      ) : page.loading ? (
        <Empty icon={<Spinner />}>
          <strong>Loading figures…</strong>
        </Empty>
      ) : page.error ? (
        <Empty icon={<Image size={28} />}>
          <strong>Couldn’t load figures</strong>
          <p>{page.error}</p>
          <button onClick={page.retry}>Try again</button>
        </Empty>
      ) : (
        <Empty icon={<Image size={30} strokeWidth={1.4} />}>
          <strong>Room for your results</strong>
          <p>
            Figures from your {languageName(language)} session appear here with the code that
            produced them.
          </p>
          <button className="text-button" onClick={() => showPanel("editor")}>
            Open the editor <ArrowUpRight size={14} />
          </button>
        </Empty>
      )}
    </div>
  );
}

type EnvironmentRow = { name: string; type: string; preview: string };
export function Environment() {
  const { language, connected, previewTable } = useWorkbench(
    "language",
    "connected",
    "previewTable",
  );
  const snapshot = useSnapshot("executions");
  const action = useAction();
  const preview = useAction();
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState("");
  useEffect(() => setQuery(""), [language]);
  const records = snapshot.executions.filter((item) => item.language === language);
  const latest = [...records]
    .reverse()
    .find(
      (item) =>
        item.inspection === "environment" &&
        !item.inspectionOptions?.names &&
        item.status === "succeeded",
    );
  const result = useResource<InspectionResult | null>(
    latest ? `/executions/${latest.id}/result` : null,
  );
  const rows: EnvironmentRow[] = result.data?.kind === "environment" ? result.data.rows : [];
  const offset = latest?.inspectionOptions?.offset ?? 0;
  const next = result.data?.kind === "environment" ? result.data.next : undefined;
  const pending =
    action.busy ||
    records.some(
      (item) =>
        item.inspection === "environment" &&
        !item.inspectionOptions?.names &&
        ["running", "queued"].includes(item.status),
    );
  const stale =
    latest &&
    records.some(
      (item) =>
        item.purpose === "analysis" &&
        item.createdAt > latest!.createdAt &&
        !["cancelled", "queued"].includes(item.status),
    );
  const lastInspection = records
    .filter((item) => item.inspection === "environment" && !item.inspectionOptions?.names)
    .at(-1);
  const filtered = rows.filter((row) =>
    `${row.name} ${row.type}`.toLowerCase().includes(query.toLowerCase()),
  );
  const inspect = (offset = 0) => action.run(() => api("/inspect", "POST", { language, offset }));
  return (
    <div className="pane environment">
      <div className="pane-toolbar">
        <span className="section-label">
          {languageName(language)} objects
          {result.data?.kind === "environment" && (
            <span className="count-badge">{rows.length}</span>
          )}
        </span>
        <span className="spacer" />
        <button
          className="text-button"
          disabled={pending || !connected}
          onClick={() => void inspect()}
        >
          <RefreshCw size={14} className={pending ? "spin" : ""} />
          {pending ? "Inspecting…" : "Inspect"}
        </button>
      </div>
      {(offset > 0 || next !== undefined) && (
        <div className="pane-toolbar object-pagination">
          <button
            className="text-button"
            disabled={pending || !connected || offset === 0}
            aria-label="Previous objects"
            onClick={() => void inspect(Math.max(0, offset - 100))}
          >
            <ChevronLeft size={14} />
            <span>Previous</span>
          </button>
          <span className="spacer" />
          <span className="object-range">
            {rows.length
              ? `Objects ${offset + 1}–${offset + rows.length}`
              : "No objects on this page"}
          </span>
          <span className="spacer" />
          <button
            className="text-button"
            disabled={pending || !connected || next === undefined}
            aria-label="Next objects"
            onClick={() => next !== undefined && void inspect(next)}
          >
            <span>Next</span>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      {lastInspection &&
        ["failed", "interrupted", "completion_unknown"].includes(lastInspection.status) && (
          <div className="inline-error" role="status">
            <strong>Inspection could not finish.</strong>
            <p>{lastInspection.error || "See the execution record in Console for details."}</p>
          </div>
        )}
      {latest && (
        <div className={`inspection-state ${stale ? "stale" : ""}`} role="status">
          {pending
            ? "Refreshing snapshot…"
            : stale
              ? "Session changed. Inspect to refresh these objects."
              : `Snapshot at ${timeLabel(latest.createdAt)}`}
        </div>
      )}
      {rows.length > 0 && (
        <div className="search-field">
          <Search size={14} />
          <input
            aria-label="Filter objects"
            placeholder="Filter this page by name or type…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="icon" aria-label="Clear object filter" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {latest && result.loading && !result.data ? (
        <Empty icon={<Spinner />}>
          <strong>Loading objects…</strong>
        </Empty>
      ) : result.error ? (
        <Empty>
          <strong>Couldn’t load objects</strong>
          <p>{result.error}</p>
          <button onClick={result.retry}>Try again</button>
        </Empty>
      ) : rows.length ? (
        <div className="object-list">
          {!filtered.length && (
            <Empty>
              <strong>No matching objects</strong>
              <p>Try a different name or type.</p>
              <button className="text-button" onClick={() => setQuery("")}>
                Clear filter
              </button>
            </Empty>
          )}
          {filtered.map((row) => (
            <div className="object" key={row.name}>
              <div>
                <code>{row.name}</code>
                <Badge>{row.type}</Badge>
              </div>
              <p title={row.preview}>{row.preview}</p>
              {row.type.split("/").some((type) => ["DataFrame", "data.frame"].includes(type)) && (
                <button
                  className="text-button"
                  disabled={!connected || preview.busy}
                  onClick={() =>
                    void preview.run(async () => {
                      setPreviewing(row.name);
                      await previewTable(row.name);
                    })
                  }
                >
                  {preview.busy && previewing === row.name ? <Spinner /> : <Table2 size={13} />}
                  Preview in Data
                  <ArrowUpRight size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={pending ? <Spinner /> : <Boxes size={29} strokeWidth={1.4} />}>
          <strong>
            {pending
              ? "Looking inside the session…"
              : latest
                ? "No objects yet"
                : "Look inside your session"}
          </strong>
          <p>
            {latest
              ? "Run code to create objects, then inspect again."
              : "See the live objects available to you and Biologue. Inspection uses your shared session."}
          </p>
          {!pending && (
            <button disabled={!connected} onClick={() => void inspect()}>
              <RefreshCw size={14} />
              Inspect {languageName(language)} session
            </button>
          )}
        </Empty>
      )}
    </div>
  );
}

const cellText = (cell: unknown) =>
  cell === null ? "null" : typeof cell === "object" ? JSON.stringify(cell) : String(cell);

export function Data() {
  const {
    language,
    tablePreview,
    showPanel,
    revealExecution,
    previewTable,
    connected,
    artifactTarget,
  } = useWorkbench(
    "language",
    "tablePreview",
    "showPanel",
    "revealExecution",
    "previewTable",
    "connected",
    "artifactTarget",
  );
  const snapshot = useSnapshot("executions");
  const action = useAction();
  const requested = tablePreview?.language === language ? tablePreview : null;
  const target =
    artifactTarget?.panel === "data" && artifactTarget.language === language
      ? artifactTarget
      : null;
  const knownRecord = requested
    ? snapshot.executions.find((item) => item.id === requested.executionId)
    : target
      ? snapshot.executions.find((item) => item.id === target.executionId)
      : [...snapshot.executions]
          .reverse()
          .find(
            (item) =>
              item.language === language &&
              item.inspection === "table" &&
              item.status === "succeeded",
          );
  const olderSource = useResource<Execution>(
    target && !knownRecord ? `/executions/${target.executionId}` : null,
  );
  const record = knownRecord ?? olderSource.data;
  const version = useOutputVersion(record?.id ?? language);
  const result = useResource<InspectionResult | null>(
    target
      ? `/outputs/${target.outputId}/table`
      : record?.status === "succeeded"
        ? `/executions/${record.id}/result`
        : null,
    version,
  );
  const table: TableResult | undefined = result.data?.kind === "table" ? result.data : undefined;
  const pending = requested && (!record || ["queued", "running"].includes(record.status));
  const title = requested?.name || "Data preview";
  return (
    <div className="pane data-pane">
      {pending ? (
        <Empty icon={<Spinner />}>
          <strong>Opening {title}…</strong>
          <p>
            {record?.status === "queued"
              ? "Waiting for the shared session."
              : "Reading up to 100 rows from the shared session."}
          </p>
        </Empty>
      ) : (result.loading || olderSource.loading) && !table ? (
        <Empty icon={<Spinner />}>
          <strong>Loading table…</strong>
        </Empty>
      ) : result.error || olderSource.error ? (
        <Empty icon={<Table2 size={28} />}>
          <strong>Couldn’t load this table</strong>
          <p>{result.error || olderSource.error}</p>
          <button onClick={result.error ? result.retry : olderSource.retry}>Try again</button>
        </Empty>
      ) : table && record ? (
        <>
          <div className="pane-toolbar data-toolbar">
            <Table2 size={15} />
            <strong title={title}>{title}</strong>
            <span className="spacer" />
            <CopyButton
              label="Copy table"
              text={[table.columns, ...table.rows]
                .map((row) => row.map(cellText).join("\t"))
                .join("\n")}
            />
            <button
              className="icon"
              aria-label="Expand data"
              title="Expand data"
              onClick={() => showPanel("data", true)}
            >
              <Maximize2 size={15} />
            </button>
          </div>
          <div className="table-meta">
            {table.rows.length} rows · {table.columns.length} columns
            {table.truncated && <Badge>First 100 rows</Badge>}
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}>
            <table>
              <caption className="sr-only">
                {title}. {table.rows.length} rows
                {table.truncated ? ", preview limited to the first 100" : ""}.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="row-number" aria-label="Row number">
                    #
                  </th>
                  {table.columns.map((column, i) => (
                    <th scope="col" key={i}>
                      {String(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    <th scope="row" className="row-number">
                      {i + 1}
                    </th>
                    {row.map((cell, j) => (
                      <td key={j} className={typeof cell === "number" ? "numeric" : undefined}>
                        {cell === null ? <span className="null">null</span> : cellText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!table.rows.length && (
              <div className="empty-table">This table has columns but no rows.</div>
            )}
          </div>
          <SourceDetails execution={record} />
        </>
      ) : requested ? (
        <Empty icon={<Table2 size={28} />}>
          <strong>Couldn’t preview {title}</strong>
          <p>
            {result.error ||
              record?.error ||
              "The execution did not return a table. Inspect the session and try again."}
          </p>
          <div className="button-row">
            <button
              disabled={!connected || action.busy}
              onClick={() => void action.run(() => previewTable(requested.name))}
            >
              Try again
            </button>
            {record && (
              <button className="text-button" onClick={() => revealExecution(record)}>
                View execution
              </button>
            )}
          </div>
        </Empty>
      ) : (
        <Empty icon={<Table2 size={29} strokeWidth={1.4} />}>
          <strong>Take a closer look</strong>
          <p>Inspect your session, then choose a data frame to preview its rows.</p>
          <button onClick={() => showPanel("environment")}>
            Open environment <ArrowUpRight size={14} />
          </button>
        </Empty>
      )}
    </div>
  );
}
