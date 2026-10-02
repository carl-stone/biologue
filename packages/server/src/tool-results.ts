import type { Execution, Output } from "@biologue/protocol";
import type { OutputService } from "./outputs.ts";

// Like Pi's built-in tools: readable content for the model, bookkeeping in details.
// Execution records and artifacts remain the authoritative, unabridged sources.
export const textResult = (text: string, details?: { executionId?: string }) => ({
  content: [{ type: "text" as const, text }],
  details,
});

export const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

export function outputPage(record: Execution, outputs: OutputService, offset: number) {
  const count = outputs.count(record.id);
  const page = outputs.references(record.id, offset, 8);
  if (offset > 0 && !page.length) throw new Error(`Output offset exceeds ${count} outputs.`);
  const blocks: string[] = [];
  let stream = "";
  const flush = () => {
    if (stream) blocks.push(stream);
    stream = "";
  };
  for (const output of page) {
    const preview = clip(output.preview, 800);
    const truncated = output.truncated || output.preview.length > 800;
    // Small streams are already their own result. Rich or partial outputs need a retrieval ID.
    if (output.kind === "stream" && !truncated) {
      stream += preview;
      continue;
    }
    flush();
    const label = output.mimeTypes.length ? output.mimeTypes.join(", ") : output.kind;
    blocks.push(
      `Output ${output.id} (${label}${truncated ? "; truncated" : ""})${preview ? `:\n${preview}` : ""}`,
    );
  }
  flush();
  if (offset > 0) blocks.unshift(`[Earlier outputs: read_execution outputOffset=0.]`);
  if (offset + page.length < count)
    blocks.push(`[More outputs: read_execution outputOffset=${offset + page.length}.]`);
  return blocks.filter(Boolean).join("\n\n");
}

export function executionText(
  record: Execution,
  outputs: OutputService,
  read?: { codeOffset: number; outputOffset: number },
) {
  const blocks = [`Execution ${record.id} ${record.status}.`];
  const firstPage = !read || (read.codeOffset === 0 && read.outputOffset === 0);
  if (firstPage) {
    if (record.error) blocks.push(clip(record.error, 2000));
  }
  if (read) {
    if (read.codeOffset > record.code.length) throw new Error("Code offset exceeds source length.");
    if (read.outputOffset === 0 || read.codeOffset > 0) {
      const source = record.document
        ? `; ${record.document.path} version ${record.document.version}`
        : "";
      blocks.push(`${record.language}, ${record.actor}${source}`);
      const budget = Math.min(6000, 16_000 - blocks.join("\n\n").length);
      const code = record.code.slice(read.codeOffset, read.codeOffset + Math.max(1, budget));
      blocks.push(code);
      if (read.codeOffset + code.length < record.code.length)
        blocks.push(`[More code: read_execution codeOffset=${read.codeOffset + code.length}.]`);
    }
  }
  if (!read || read.codeOffset === 0 || read.outputOffset > 0)
    blocks.push(
      outputPage(record, outputs, read?.outputOffset ?? Math.max(0, outputs.count(record.id) - 8)),
    );
  return blocks.filter(Boolean).join("\n\n");
}

export function inspectionResult(
  record: Execution,
  outputs: OutputService,
  names?: string[],
  offset = 0,
) {
  const decoded = outputs.result(record.id);
  if (decoded?.kind !== "environment")
    throw new Error(`Inspection ${record.id} has no environment result.`);
  const selected = names ? decoded.rows.filter((row) => names.includes(row.name)) : decoded.rows;
  const lines: string[] = [];
  let remaining = 12_000;
  for (const row of selected) {
    const line = `${JSON.stringify(row.name)} (${row.type}): ${row.preview}`;
    if (lines.length >= 100 || line.length + 1 > remaining) break;
    lines.push(line);
    remaining -= line.length + 1;
  }
  if (lines.length < selected.length || decoded.next !== undefined)
    lines.push(
      `[More: inspect_environment offset=${lines.length < selected.length ? offset + lines.length : decoded.next}${names ? " with the same names" : ""}.]`,
    );
  else if (!lines.length) lines.push(names ? "No matching objects." : "No objects.");
  return textResult(`Environment preview (execution ${record.id})\n${lines.join("\n")}`, {
    executionId: record.id,
  });
}

export function artifactText(output: Output, offset: number) {
  // Choose one representation, rather than repeating text/plain, JSON, and HTML.
  const data = output.data ?? {};
  const value = data["application/json"];
  const fallback = Object.entries(data).find(([mime]) => !mime.startsWith("image/"));
  const text =
    output.text ??
    (value !== undefined
      ? JSON.stringify(value)
      : typeof data["text/plain"] === "string"
        ? data["text/plain"]
        : typeof data["text/html"] === "string"
          ? data["text/html"]
          : fallback
            ? `${fallback[0]}\n${JSON.stringify(fallback[1])}`
            : "");
  if (offset > text.length) throw new Error("Offset exceeds artifact length.");
  const page = text.slice(offset, offset + 16_000);
  return (
    page +
    (offset + page.length < text.length
      ? `\n[More: read_artifact offset=${offset + page.length}.]`
      : "")
  );
}
