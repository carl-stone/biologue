import { useState } from "react";
import { ArrowUpRight, Image, Table2 } from "lucide-react";
import type { ExecutionSummary, DisplayOutput, Page } from "@carl/protocol";
import { useWorkbench, useSnapshot, useResource, useOutputVersion } from "../state.tsx";
import { languageName } from "../ui.tsx";

function ActivityExecution({ execution, open }: { execution: ExecutionSummary; open: boolean }) {
  const { revealExecution, revealArtifact } = useWorkbench("revealExecution", "revealArtifact");
  const version = useOutputVersion(execution.id);
  const outputs = useResource<Page<DisplayOutput>>(
    open ? `/outputs?executionId=${execution.id}` : null,
    version,
  );
  const artifacts =
    outputs.data?.items.filter(
      (output) => output.table || output.mimeTypes.includes("image/png"),
    ) ?? [];
  const status =
    execution.status === "succeeded"
      ? "Finished"
      : execution.status === "running"
        ? "Running"
        : execution.status === "queued"
          ? "Queued"
          : execution.status === "not_executed"
            ? "Not run"
            : execution.status === "failed"
              ? "Failed"
              : execution.status === "completion_unknown"
                ? "Completion unknown"
                : "Stopped";
  return (
    <div className="activity-execution">
      <button
        className="text-button activity-source"
        title={execution.codePreview}
        onClick={() => revealExecution(execution)}
      >
        <span>{execution.document?.path || `${languageName(execution.language)} output`}</span>
        <span className="small-note">{status}</span>
        <ArrowUpRight size={12} />
      </button>
      <div className="activity-artifacts">
        {artifacts.slice(-6).map((output, index) => {
          const plot = output.mimeTypes.includes("image/png");
          return (
            <button
              key={output.id}
              className="output-link"
              onClick={() => revealArtifact(execution, output, plot ? "plots" : "data")}
            >
              {plot ? <Image size={13} /> : <Table2 size={13} />}
              {plot ? "View figure" : "View table"}
              {artifacts.length > 1 ? ` ${index + 1}` : ""}
            </button>
          );
        })}
        {outputs.error && (
          <button className="text-button" onClick={outputs.retry}>
            Retry loading results
          </button>
        )}
      </div>
    </div>
  );
}

/** Link discussion to recorded computation without treating output as interpretation. */
export function RunActivity({ runId }: { runId: string }) {
  const { executions } = useSnapshot("executions");
  const [open, setOpen] = useState(false);
  const records = executions.filter(
    (execution) => execution.runId === runId && execution.purpose === "analysis",
  );
  if (!records.length) return null;
  return (
    <details className="run-activity" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Workspace activity · {records.length} {records.length === 1 ? "execution" : "executions"}
      </summary>
      {open &&
        records.map((execution) => (
          <ActivityExecution key={execution.id} execution={execution} open={open} />
        ))}
    </details>
  );
}
