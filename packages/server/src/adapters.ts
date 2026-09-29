import type { Language } from "@carl/protocol";

export interface LanguageAdapter {
  language: Language;
  kernelName: string;
  inspectionCode: string;
  tableCode: (name: string) => string;
}
export const adapters: Record<Language, LanguageAdapter> = {
  python: {
    language: "python",
    kernelName: process.env.CARL_PYTHON_KERNEL || "python3",
    tableCode: (name) => `def _carl_table():
    import json
    from IPython.display import display
    value = globals()[${JSON.stringify(name)}]
    if type(value).__name__ != 'DataFrame' or not type(value).__module__.startswith('pandas'):
        raise TypeError('Table preview currently supports pandas DataFrames.')
    preview = json.loads(value.head(100).to_json(orient='split', date_format='iso'))
    display({'application/json': {'columns': preview['columns'], 'rows': preview['data'], 'truncated': len(value) > 100}}, raw=True)
_carl_table()
del _carl_table`,
    inspectionCode: `def _carl_inspect():
    import json
    rows = []
    for name, value in sorted(list(globals().items())):
        if name.startswith('_') or name in ('In', 'Out', 'get_ipython', 'exit', 'quit', 'open'):
            continue
        kind = type(value).__name__
        if kind in ('module', 'function', 'type'):
            continue
        preview = repr(value)[:240] if isinstance(value, (int, float, str, bool, list, tuple, dict, set, type(None))) else '<' + kind + '>'
        rows.append({'name': name, 'type': kind, 'preview': preview})
    print(json.dumps(rows, ensure_ascii=False))
_carl_inspect()
del _carl_inspect`,
  },
  r: {
    language: "r",
    kernelName: process.env.CARL_R_KERNEL || "ark",
    tableCode: (name) => `local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Table preview requires the R package jsonlite.")
  value <- get(${JSON.stringify(name)}, envir = .GlobalEnv)
  if (!is.data.frame(value)) stop("Table preview currently supports data frames.")
  part <- head(value, 100)
  rows <- lapply(seq_len(nrow(part)), function(i) unname(as.list(part[i, , drop = FALSE])))
  cat(jsonlite::toJSON(list(columns = I(names(part)), rows = rows, truncated = nrow(value) > 100), auto_unbox = TRUE, na = "null"))
})`,
    inspectionCode: `local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Environment inspection requires the R package jsonlite.")
  rows <- lapply(ls(envir = .GlobalEnv), function(n) {
    v <- get(n, envir = .GlobalEnv)
    list(name = n, type = paste(class(v), collapse = "/"), preview = paste(capture.output(str(v, max.level = 0L)), collapse = " "))
  })
  cat(jsonlite::toJSON(rows, auto_unbox = TRUE))
})`,
  },
};

/** Decode language output once at the server boundary, never in a React panel. */
export function decodeTable(value: unknown): import("@carl/protocol").TableResult | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object") return;
  const table = value as Record<string, unknown>;
  if (
    !Array.isArray(table.columns) ||
    !Array.isArray(table.rows) ||
    !table.rows.every(
      (row) => Array.isArray(row) && row.length === (table.columns as unknown[]).length,
    ) ||
    typeof table.truncated !== "boolean"
  )
    return;
  return {
    kind: "table",
    columns: table.columns,
    rows: table.rows as unknown[][],
    truncated: table.truncated,
  };
}
export function decodeInspection(
  kind: "table" | "environment" | undefined,
  outputs: import("@carl/protocol").Output[],
): import("@carl/protocol").InspectionResult | undefined {
  const text = outputs
    .filter((output) => output.kind === "stream")
    .map((output) => output.text ?? "")
    .join("");
  if (kind !== "environment") {
    for (const candidate of [...outputs.map((output) => output.data?.["application/json"]), text]) {
      const table = decodeTable(candidate);
      if (table) return table;
    }
  }
  if (kind === "table") return;
  try {
    const rows = JSON.parse(text);
    if (
      Array.isArray(rows) &&
      rows.every(
        (row) =>
          row &&
          typeof row.name === "string" &&
          typeof row.type === "string" &&
          typeof row.preview === "string",
      )
    )
      return { kind: "environment", rows };
  } catch {
    /* Failed or ordinary console output has no structured result. */
  }
}
