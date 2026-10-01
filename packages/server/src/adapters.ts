import type { EnvironmentQuery, Language } from "@biologue/protocol";

export interface LanguageAdapter {
  language: Language;
  kernelName: string;
  setupCode?: string;
  inspectionCode: (query?: EnvironmentQuery) => string;
  tableCode: (name: string) => string;
}
export const adapters: Record<Language, LanguageAdapter> = {
  python: {
    language: "python",
    kernelName: process.env.BIOLOGUE_PYTHON_KERNEL || "python3",
    tableCode: (name) => `def _biologue_table():
    import json
    from IPython.display import display
    value = globals()[${JSON.stringify(name)}]
    if type(value).__name__ != 'DataFrame' or not type(value).__module__.startswith('pandas'):
        raise TypeError('Table preview currently supports pandas DataFrames.')
    preview = json.loads(value.head(100).to_json(orient='split', date_format='iso'))
    display({'application/json': {'columns': preview['columns'], 'rows': preview['data'], 'truncated': len(value) > 100}}, raw=True)
_biologue_table()
del _biologue_table`,
    inspectionCode: ({ names, offset = 0 } = {}) => `def _biologue_inspect():
    import builtins as b, json, itertools
    def preview(value, depth=0):
        kind = b.type(value)
        label = b.type.__dict__['__name__'].__get__(kind)[:80]
        if kind is b.str:
            return b.repr(value[:160]) + ('…' if b.len(value) > 160 else '')
        if kind is b.bytes:
            return b.repr(value[:60]) + ('…' if b.len(value) > 60 else '')
        if kind is b.int and value.bit_length() > 1024:
            return '<int: ' + b.str(value.bit_length()) + ' bits>'
        if b.any(kind is t for t in (b.int, b.float, b.bool, b.type(None))):
            return b.repr(value)
        if b.any(kind is t for t in (b.list, b.tuple, b.dict, b.set, b.frozenset)):
            if depth:
                return '<' + label + ': ' + b.str(b.len(value)) + ' items>'
            if kind is b.dict:
                parts = [preview(k, 1) + ': ' + preview(v, 1) for k, v in itertools.islice(value.items(), 4)]
            else:
                parts = [preview(v, 1) for v in itertools.islice(value, 4)]
            return label + '(' + ', '.join(parts) + (', …' if b.len(value) > 4 else '') + ')'
        return '<' + label + '>'
    namespace = b.globals()
    requested = ${names === undefined ? "None" : JSON.stringify(names)}
    candidates = b.sorted(n for n in namespace if not n.startswith('_') and n not in ('In', 'Out', 'get_ipython', 'exit', 'quit', 'open')) if requested is None else b.list(b.dict.fromkeys(requested))
    offset = ${offset}
    selected = candidates[offset:offset + 100]
    rows = []
    for name in selected:
        if name not in namespace:
            rows.append({'name': name, 'type': 'unbound', 'preview': '<not defined in workspace>'})
            continue
        value = namespace[name]
        label = b.type.__dict__['__name__'].__get__(b.type(value))[:80]
        rows.append({'name': name, 'type': label, 'preview': preview(value)[:240]})
    next_offset = offset + b.len(selected)
    b.print(json.dumps({'rows': rows, 'next': next_offset if next_offset < b.len(candidates) else None}, ensure_ascii=False))
_biologue_inspect()
del _biologue_inspect`,
  },
  r: {
    language: "r",
    kernelName: process.env.BIOLOGUE_R_KERNEL || "ark",
    // Ark 0.1.252 resumes pending top-level expressions after an unhandled
    // interrupt. Report it through R's error handler so Ark discards them.
    // Keep the hook idempotent and preserve any scientist-installed handler.
    setupCode: `base::local({
  previous <- base::getOption("interrupt")
  if (!base::isTRUE(base::attr(previous, "biologue.interrupt"))) {
    handler <- function() {
      if (base::is.function(previous)) previous()
      base::stop("Execution interrupted.", call. = FALSE)
    }
    base::options(interrupt = base::structure(handler, biologue.interrupt = TRUE))
  }
})`,
    tableCode: (name) => `local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Table preview requires the R package jsonlite.")
  value <- get(${JSON.stringify(name)}, envir = .GlobalEnv)
  if (!is.data.frame(value)) stop("Table preview currently supports data frames.")
  part <- head(value, 100)
  rows <- lapply(seq_len(nrow(part)), function(i) unname(as.list(part[i, , drop = FALSE])))
  cat(jsonlite::toJSON(list(columns = I(names(part)), rows = rows, truncated = nrow(value) > 100), auto_unbox = TRUE, na = "null"))
})`,
    inspectionCode: ({ names, offset = 0 } = {}) => `local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Environment inspection requires the R package jsonlite.")
  requested <- ${names === undefined ? "NULL" : `jsonlite::fromJSON(${JSON.stringify(JSON.stringify(names))})`}
  candidates <- if (is.null(requested)) ls(envir = .GlobalEnv) else unique(requested)
  offset <- ${offset}
  selected <- head(candidates[seq_along(candidates) > offset], 100L)
  rows <- lapply(selected, function(n) {
    if (!exists(n, envir = .GlobalEnv, inherits = FALSE)) return(list(name = n, type = "unbound", preview = "<not defined in workspace>"))
    if (bindingIsActive(n, .GlobalEnv)) return(list(name = n, type = "active binding", preview = "<not evaluated>", observed = FALSE))
    tryCatch({
      v <- get(n, envir = .GlobalEnv, inherits = FALSE)
      kind <- typeof(v)
      cls <- attr(v, "class", exact = TRUE)
      label <- if (is.character(cls)) substr(paste(substr(head(cls, 4L), 1L, 80L), collapse = "/"), 1L, 80L) else kind
      preview <- paste0("<", label, ">")
      if (!is.object(v)) {
        if (kind %in% c("logical", "integer", "double", "complex", "character", "raw")) {
          part <- v[seq_len(min(length(v), 4L))]
          if (kind == "character") part <- substr(part, 1L, 160L)
          preview <- paste0(paste(as.character(part), collapse = ", "), if (length(v) > 4L) ", …" else "")
        } else if (kind == "list") preview <- paste0("<list: ", length(v), " items>")
      }
      list(name = n, type = label, preview = substr(preview, 1L, 240L))
    }, error = function(e) list(name = n, type = "unavailable", preview = "<inspection failed>", observed = FALSE))
  })
  next_offset <- offset + length(selected)
  cat(jsonlite::toJSON(list(rows = rows, "next" = if (next_offset < length(candidates)) next_offset else NULL), auto_unbox = TRUE))
})`,
  },
};

/** Decode language output once at the server boundary, never in a React panel. */
export function decodeTable(value: unknown): import("@biologue/protocol").TableResult | undefined {
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
  outputs: import("@biologue/protocol").Output[],
): import("@biologue/protocol").InspectionResult | undefined {
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
    const value = JSON.parse(text);
    const rows = Array.isArray(value) ? value : value?.rows;
    if (
      Array.isArray(rows) &&
      rows.every(
        (row) =>
          row &&
          typeof row.name === "string" &&
          typeof row.type === "string" &&
          typeof row.preview === "string" &&
          (row.observed === undefined || row.observed === false),
      )
    )
      return {
        kind: "environment",
        rows,
        ...(Number.isSafeInteger(value?.next) && value.next > 0 ? { next: value.next } : {}),
      };
  } catch {
    /* Failed or ordinary console output has no structured result. */
  }
}
