import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
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
} from "@biologue/protocol";
import { api, base, useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import {
  Badge,
  CopyButton,
  Empty,
  Spinner,
  downloadText,
  languageName,
  timeLabel,
  useAction,
} from "../ui.tsx";

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
        View output <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

export function Plots() {
  const { language, showPanel, artifactTarget, plotViews, setPlotView } = useWorkbench(
    "language",
    "showPanel",
    "artifactTarget",
    "plotViews",
    "setPlotView",
  );
  const snapshot = useSnapshot("executions");
  const version = useOutputVersion(language);
  const { before, selectedSlot, dismissedTarget } = plotViews[language];
  const page = useResource<Page<DisplayOutput>>(
    `/outputs?language=${language}&kind=plots${before ? `&before=${before}` : ""}`,
    version,
  );
  const targetId =
    artifactTarget?.panel === "plots" && artifactTarget.language === language
      ? artifactTarget.outputId
      : undefined;
  const pinned = useResource<OutputReference>(targetId ? `/outputs/${targetId}/reference` : null);
  const pinnedActive = !!targetId && dismissedTarget !== artifactTarget;
  const plots: DisplayOutput[] = [...(page.data?.items ?? [])];
  if (pinnedActive && pinned.data && !plots.some((plot) => plot.id === pinned.data!.id))
    plots.push({
      ...pinned.data,
      slotId: `historical:${pinned.data.id}`,
      ownerExecutionId: pinned.data.executionId,
    });
  const targetIndex = plots.findIndex((plot) => plot.id === targetId);
  const [imageError, setImageError] = useState<string>();
  const [imageAttempt, setImageAttempt] = useState(0);
  const latest = plots.length - 1;
  const selectedIndex = plots.findIndex((plot) => plot.slotId === selectedSlot);
  const index = pinnedActive ? targetIndex : selectedIndex >= 0 ? selectedIndex : latest;
  const plot = plots[index];
  const src = plot
    ? `${base}/api/outputs/${plot.id}/png${imageAttempt ? `?retry=${imageAttempt}` : ""}`
    : "";
  function select(index: number) {
    setPlotView(language, {
      dismissedTarget: artifactTarget,
      selectedSlot: index === latest ? null : (plots[index]?.slotId ?? null),
    });
  }
  function browse(before?: string) {
    setPlotView(language, { dismissedTarget: artifactTarget, selectedSlot: null, before });
  }
  const known = snapshot.executions.find((item) => item.id === plot?.executionId);
  const source = useResource<Execution>(plot && !known ? `/executions/${plot.executionId}` : null);
  const execution = known ?? source.data;
  return (
    <div className="pane plots">
      {plot && (
        <div className="pane-toolbar figure-toolbar">
          <button
            className="icon"
            aria-label="Previous figure"
            title="Previous figure"
            disabled={index <= 0}
            onClick={() => select(index - 1)}
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
            onClick={() => select(index + 1)}
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
      )}
      {(page.data?.next || before) && (
        <div className="figure-history">
          {page.data?.next && (
            <button className="text-button" onClick={() => browse(page.data!.next)}>
              Earlier figures
            </button>
          )}
          {before && (
            <button className="text-button" onClick={() => browse()}>
              Latest figures
            </button>
          )}
        </div>
      )}
      {pinnedActive && !plot && pinned.loading ? (
        <Empty icon={<Spinner />}>
          <strong>Loading the requested figure…</strong>
        </Empty>
      ) : pinnedActive && !plot && pinned.error ? (
        <Empty icon={<Image size={28} />}>
          <strong>Couldn’t load the requested figure</strong>
          <p>{pinned.error}</p>
          <button onClick={pinned.retry}>Try again</button>
          <button className="text-button" onClick={() => browse()}>
            Latest figures
          </button>
        </Empty>
      ) : plot ? (
        <>
          <div className="figure">
            {imageError === plot.id ? (
              <Empty icon={<Image size={28} />}>
                <strong>Couldn’t load this image</strong>
                <p>The recorded figure is still selected.</p>
                <button
                  onClick={() => {
                    setImageError(undefined);
                    setImageAttempt((value) => value + 1);
                  }}
                >
                  Try again
                </button>
              </Empty>
            ) : (
              <img
                key={src}
                alt={`Plot from ${execution?.actor ?? "recorded"} execution ${plot.executionId}`}
                src={src}
                onError={() => setImageError(plot.id)}
              />
            )}
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
        <Empty>No plots yet</Empty>
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
        <div className="search-field">
          <Search size={14} />
          <input
            aria-label="Filter objects"
            placeholder="Filter objects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="icon" aria-label="Clear object filter" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <button
          className="icon"
          aria-label="Refresh objects"
          title="Refresh objects"
          disabled={pending || !connected}
          onClick={() => void inspect()}
        >
          <RefreshCw size={14} className={pending ? "spin" : ""} />
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
          <table className="object-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr className="object" key={row.name}>
                  <td>
                    {row.type
                      .split("/")
                      .some((type) => ["DataFrame", "data.frame"].includes(type)) ? (
                      <button
                        className="text-button"
                        aria-label="Preview in Data"
                        title={`Open ${row.name} in Data`}
                        disabled={!connected || preview.busy}
                        onClick={() =>
                          void preview.run(async () => {
                            setPreviewing(row.name);
                            await previewTable(row.name);
                          })
                        }
                      >
                        {preview.busy && previewing === row.name ? (
                          <Spinner />
                        ) : (
                          <Table2 size={13} />
                        )}
                        <code>{row.name}</code>
                      </button>
                    ) : (
                      <code>{row.name}</code>
                    )}
                  </td>
                  <td title={row.type}>{row.type}</td>
                  <td title={row.preview}>{row.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{pending ? "Refreshing…" : "No objects"}</Empty>
      )}
    </div>
  );
}

const cellText = (cell: unknown) =>
  cell === null ? "null" : typeof cell === "object" ? JSON.stringify(cell) : String(cell);
function compareCells(left: unknown, right: unknown): number {
  const numeric = (cell: unknown): number | bigint | undefined => {
    if (typeof cell === "number") return cell;
    if (cell === "Infinity") return Infinity;
    if (cell === "-Infinity") return -Infinity;
    if (typeof cell === "string" && cell.length <= 100 && /^[+-]?\d+$/.test(cell))
      return BigInt(cell);
  };
  const a = numeric(left),
    b = numeric(right);
  if (a !== undefined && b !== undefined) return a < b ? -1 : a > b ? 1 : 0;
  return cellText(left).localeCompare(cellText(right), undefined, { numeric: true });
}
const delimitedText = (rows: unknown[][], delimiter: string) =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cellText(cell);
          return text.includes(delimiter) || /["\r\n]/.test(text)
            ? `"${text.replaceAll('"', '""')}"`
            : text;
        })
        .join(delimiter),
    )
    .join(delimiter === "," ? "\r\n" : "\n");

export function Data() {
  const {
    language,
    tablePreview,
    showPanel,
    revealExecution,
    previewTable,
    connected,
    artifactTarget,
    tableFilter,
    setTableFilter,
    tableSort: sort,
    setTableSort: setSort,
  } = useWorkbench(
    "language",
    "tablePreview",
    "showPanel",
    "revealExecution",
    "previewTable",
    "connected",
    "artifactTarget",
    "tableFilter",
    "setTableFilter",
    "tableSort",
    "setTableSort",
  );
  const snapshot = useSnapshot("executions");
  const environmentRecord = [...snapshot.executions]
    .reverse()
    .find(
      (item) =>
        item.language === language &&
        item.inspection === "environment" &&
        !item.inspectionOptions?.names &&
        item.status === "succeeded",
    );
  const objects = useResource<InspectionResult>(
    environmentRecord ? `/executions/${environmentRecord.id}/result` : null,
  );
  const tables =
    objects.data?.kind === "environment"
      ? objects.data.rows.filter((row) =>
          row.type.split("/").some((type) => ["DataFrame", "data.frame"].includes(type)),
        )
      : [];
  const [objectName, setObjectName] = useState("");
  const action = useAction();
  const requested = tablePreview?.language === language ? tablePreview : null;
  useEffect(() => setObjectName(requested?.name ?? ""), [language, requested?.name]);
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
  const refreshed = useRef("");
  useEffect(() => {
    if (!requested || target || !environmentRecord || !record || pending || !connected) return;
    if (
      environmentRecord.createdAt <= record.createdAt ||
      refreshed.current === environmentRecord.id
    )
      return;
    refreshed.current = environmentRecord.id;
    void action.run(() => previewTable(requested.name, false));
  }, [environmentRecord?.id, record?.id, pending, connected, requested?.name, target?.outputId]);

  const filterSource = `${language}:${target?.outputId ?? record?.id ?? ""}`;
  const filter = tableFilter?.source === filterSource ? tableFilter.value : "";
  const setFilter = (value: string) => setTableFilter({ source: filterSource, value });
  const rows =
    table?.rows
      .map((cells, index) => ({ cells, index }))
      .filter(({ cells }) =>
        cells.some((cell) => cellText(cell).toLowerCase().includes(filter.toLowerCase())),
      ) ?? [];
  if (sort?.source === filterSource) {
    rows.sort((a, b) => {
      const left = a.cells[sort.column],
        right = b.cells[sort.column];
      const order = compareCells(left, right);
      return (sort.descending ? -order : order) || a.index - b.index;
    });
  }
  return (
    <div className="pane data-pane">
      <form
        className="pane-toolbar data-picker"
        onSubmit={(event) => {
          event.preventDefault();
          if (objectName.trim()) void action.run(() => previewTable(objectName.trim()));
        }}
      >
        <input
          aria-label="Table object"
          placeholder="Table name"
          list="table-objects"
          value={objectName}
          onChange={(event) => setObjectName(event.target.value)}
        />
        <datalist id="table-objects">
          {tables.map((row) => (
            <option key={row.name} value={row.name} />
          ))}
        </datalist>
        <button disabled={!objectName.trim() || action.busy || !connected}>Open</button>
      </form>
      {!requested && !target && !record && tables.length > 0 && (
        <div className="table-choices">
          {tables.map((row) => (
            <button
              className="text-button"
              key={row.name}
              onClick={() => {
                setObjectName(row.name);
                void action.run(() => previewTable(row.name));
              }}
            >
              {row.name}
            </button>
          ))}
        </div>
      )}

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
            <div className="table-filter">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Filter table preview"
                placeholder="Filter this preview…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter && (
                <button
                  className="icon"
                  aria-label="Clear table filter"
                  title="Clear filter"
                  onClick={() => setFilter("")}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="table-meta">
              {filter ? `${rows.length} of ${table.rows.length}` : table.rows.length} rows ·{" "}
              {table.columns.length} columns
              {table.truncated && <Badge>First 100 rows</Badge>}
            </div>
            <span className="spacer" />
            <CopyButton
              label="Copy table"
              text={delimitedText([table.columns, ...rows.map((row) => row.cells)], "\t")}
            />
            <button
              className="icon"
              aria-label="Download preview CSV"
              title="Download visible preview as CSV"
              onClick={() => {
                const csv = delimitedText([table.columns, ...rows.map((row) => row.cells)], ",");
                downloadText(
                  csv,
                  `${title === "Data preview" ? "data" : title.replace(/[^a-zA-Z0-9_-]/g, "_")}-preview.csv`,
                  "text/csv;charset=utf-8",
                );
              }}
            >
              <Download size={15} />
            </button>
            <button
              className="icon"
              aria-label="Expand data"
              title="Expand data"
              onClick={() => showPanel("data", true)}
            >
              <Maximize2 size={15} />
            </button>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}>
            <table>
              <caption className="sr-only">
                {title}. {rows.length} rows
                {table.truncated ? ", preview limited to the first 100" : ""}.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="row-number" aria-label="Row number">
                    #
                  </th>
                  {table.columns.map((column, i) => (
                    <th
                      scope="col"
                      key={i}
                      aria-sort={
                        sort?.source === filterSource && sort.column === i
                          ? sort.descending
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button
                        className="table-sort"
                        title={`Sort preview by ${String(column)}`}
                        onClick={() =>
                          setSort({
                            source: filterSource,
                            column: i,
                            descending:
                              sort?.source === filterSource && sort.column === i
                                ? !sort.descending
                                : false,
                          })
                        }
                      >
                        {String(column)}
                        {sort?.source === filterSource &&
                          sort.column === i &&
                          (sort.descending ? " ↓" : " ↑")}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cells: row, index }) => (
                  <tr key={index}>
                    <th scope="row" className="row-number">
                      {index + 1}
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
            {!!table.rows.length && !rows.length && (
              <div className="empty-table">
                No rows match this filter.
                <button className="text-button" onClick={() => setFilter("")}>
                  Clear filter
                </button>
              </div>
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
        <Empty>No table selected</Empty>
      )}
    </div>
  );
}
