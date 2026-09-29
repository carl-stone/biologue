import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { Prec, type EditorState, type ViewUpdate } from "@uiw/react-codemirror";
import { historyField } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { r } from "@codemirror/legacy-modes/mode/r";
import { keymap, EditorView } from "@codemirror/view";
import { FileCode2, FilePlus2, Play, Save, Square, Download, ChevronDown } from "lucide-react";
import type { Document, Execution, Language } from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import {
  Empty,
  Dialog,
  SavedLabel,
  Spinner,
  downloadText,
  languageName,
  modifier,
  useAction,
} from "../ui.tsx";

const editorSetup = { foldGutter: true, autocompletion: true, highlightActiveLine: true };
// Ephemeral editing history, not a second document authority. Restore only when
// its text still matches the working document; fresh mounts use fresh callbacks.
const editorMemory = new Map<string, { state: EditorState; scrollTop: number }>();
const syntax = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: "#687668" },
    { tag: [tags.keyword, tags.modifier], color: "#8050a0" },
    { tag: [tags.string, tags.regexp], color: "#86602f" },
    { tag: [tags.number, tags.bool, tags.null], color: "#a24b3d" },
    { tag: tags.function(tags.variableName), color: "#326b8b" },
    { tag: [tags.typeName, tags.className], color: "#7c632f" },
    { tag: tags.invalid, color: "#a44133", textDecoration: "underline" },
  ]),
);

export function Editor() {
  const wb = useWorkbench(
    "file",
    "language",
    "drafts",
    "connected",
    "perform",
    "open",
    "flush",
    "notify",
    "setLanguage",
    "revealExecution",
    "draft",
    "setFile",
    "discardDraft",
    "keepLocal",
    "reconcile",
    "showPanel",
  );
  const { file, language, drafts, connected } = wb;
  const snapshot = useSnapshot("documents", "files", "executions", "project");
  const doc = snapshot?.documents.find((item) => item.path === file);
  const draft = drafts[file];
  const fileLanguage: Language | undefined = /\.r$/i.test(file)
    ? "r"
    : /\.py$/i.test(file)
      ? "python"
      : undefined;
  const active = snapshot?.executions.find(
    (item) => item.language === fileLanguage && item.status === "running",
  );
  const lastRun = [...snapshot.executions]
    .reverse()
    .find(
      (execution) =>
        execution.actor === "human" &&
        execution.document?.path === file &&
        execution.purpose === "analysis",
    );
  const runLabel =
    lastRun &&
    {
      queued: "Queued",
      running: "Running",
      succeeded: "Finished",
      failed: "Failed",
      cancelled: "Stopped",
      interrupted: "Stopped",
      abandoned: "Session ended",
      completion_unknown: "Check output",
      not_executed: "Not run",
    }[lastRun.status];
  const action = useAction();
  const createAction = useAction();
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [createError, setCreateError] = useState("");
  const [openFailure, setOpenFailure] = useState<{ path: string; message: string } | null>(null);
  const fileError = openFailure?.path === file ? openFailure.message : "";
  const [position, setPosition] = useState({ line: 1, column: 1, selected: false });
  const editorView = useRef<EditorView | null>(null);
  const runMenu = useRef<HTMLDetailsElement>(null);
  const memoryKey = `${snapshot.project}:${file}`;
  const initialState = useMemo(() => {
    const saved = editorMemory.get(memoryKey);
    return saved && saved.state.doc.toString() === (draft?.content ?? doc?.content)
      ? { json: saved.state.toJSON({ history: historyField }), fields: { history: historyField } }
      : undefined;
  }, [memoryKey, !!doc]);
  const conflict = !!(doc && draft && draft.baseVersion !== doc.version);
  const dirty = !!(draft || (doc && doc.version !== doc.savedVersion));
  useEffect(() => {
    let cancelled = false;
    setOpenFailure(null);
    if (file && connected)
      void wb.open(file).catch((error) => {
        if (!cancelled)
          setOpenFailure({
            path: file,
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [file, connected]);
  async function retryOpen() {
    const path = file;
    setOpenFailure(null);
    try {
      await wb.open(path);
    } catch (error) {
      setOpenFailure({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function save() {
    if (!doc || conflict || doc.diskConflict || !connected) return;
    const current = await wb.flush(doc);
    await api<Document>("/documents/save", "POST", {
      path: current.path,
      expectedVersion: current.version,
    });
    wb.notify(`Saved ${current.path}`);
  }
  async function run(scope: "file" | "selection" | "line" = "file") {
    if (!doc || !fileLanguage || conflict || !connected) return;
    if (runMenu.current) runMenu.current.open = false;
    const state = editorView.current?.state;
    const selected = state?.selection.main;
    const line = state && selected ? state.doc.lineAt(selected.head) : undefined;
    const selection =
      scope === "line" && line
        ? { from: line.from, to: line.to }
        : scope === "selection" && selected && !selected.empty
          ? { from: selected.from, to: selected.to }
          : undefined;
    if (scope !== "file" && !selection) return;
    const text = state?.doc.toString();
    const current = await wb.flush(doc);
    if (selection && current.content !== text)
      throw new Error("The file changed while preparing this run. Select the code and try again.");
    const code = selection ? current.content.slice(selection.from, selection.to) : current.content;
    if (!code.trim()) return;
    wb.setLanguage(fileLanguage);
    const execution = await api<Execution>("/executions", "POST", {
      language: fileLanguage,
      code,
      document: {
        path: current.path,
        version: current.version,
        ...(selection ? { selection } : {}),
      },
    });
    wb.revealExecution(execution, { expand: false, activate: false });
  }
  // Streaming and kernel events should not reconfigure the editor on every event.
  // Stable extensions read the current document/actions through this ref.
  const commands = useRef({ doc, draft: wb.draft, run, save, action });
  commands.current = { doc, draft: wb.draft, run, save, action };
  const extensions = useMemo(
    () => [
      EditorView.contentAttributes.of({ "aria-label": `Code editor: ${file}` }),
      syntax,
      ...(fileLanguage === "python"
        ? [python()]
        : fileLanguage === "r"
          ? [StreamLanguage.define(r)]
          : []),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: (view) => {
              const current = commands.current;
              void current.action.run(() =>
                current.run(view.state.selection.main.empty ? "file" : "selection"),
              );
              return true;
            },
          },
          {
            key: "Shift-Enter",
            run: () => {
              const current = commands.current;
              void current.action.run(() => current.run("line"));
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => {
              const current = commands.current;
              void current.action.run(() => current.run("file"));
              return true;
            },
          },
          {
            key: "Mod-s",
            run: () => {
              const current = commands.current;
              void current.action.run(current.save);
              return true;
            },
          },
        ]),
      ),
    ],
    [file, fileLanguage],
  );
  const change = useCallback((content: string) => {
    const current = commands.current;
    if (current.doc) current.draft(current.doc, content);
  }, []);
  const update = useCallback(
    (event: ViewUpdate) => {
      editorMemory.delete(memoryKey);
      editorMemory.set(memoryKey, {
        state: event.state,
        scrollTop: event.view.scrollDOM.scrollTop,
      });
      if (editorMemory.size > 20) editorMemory.delete(editorMemory.keys().next().value!);
      if (event.selectionSet || event.docChanged) {
        const selection = event.state.selection.main;
        const line = event.state.doc.lineAt(selection.head);
        setPosition({
          line: line.number,
          column: selection.head - line.from + 1,
          selected: !selection.empty,
        });
      }
    },
    [memoryKey],
  );
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!runMenu.current?.contains(event.target as Node) && runMenu.current)
        runMenu.current.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  return (
    <div className="pane editor-pane">
      <div className="pane-toolbar editor-toolbar">
        <FileCode2 size={16} aria-hidden="true" />
        <select
          aria-label="Project file"
          title={file}
          value={file}
          onChange={(event) => {
            wb.setFile(event.target.value);
            if (/\.r$/i.test(event.target.value)) wb.setLanguage("r");
            else if (/\.py$/i.test(event.target.value)) wb.setLanguage("python");
          }}
        >
          {!snapshot?.files.length && <option value="">No project files</option>}
          {snapshot?.files.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </select>
        <button
          className="icon"
          aria-label="New file"
          title="New file"
          disabled={!connected}
          onClick={() => {
            setNewPath("");
            setCreateError("");
            setCreating(true);
          }}
        >
          <FilePlus2 size={15} />
        </button>
        <span className="spacer" />
        <button
          className="save-file"
          aria-label="Save file"
          title={`Save file (${modifier}+S)`}
          disabled={!doc || !dirty || conflict || !!doc.diskConflict || action.busy || !connected}
          onClick={() => void action.run(save)}
        >
          <Save size={15} />
          <span>Save</span>
        </button>
        <button
          className="run"
          disabled={
            !doc ||
            !fileLanguage ||
            !(draft?.content ?? doc.content).trim() ||
            action.busy ||
            conflict ||
            !connected
          }
          title={`Run ${position.selected ? "selected code" : "the entire file"} in ${languageName(fileLanguage || language)} (${modifier}+Enter)`}
          onClick={() => void action.run(() => run(position.selected ? "selection" : "file"))}
        >
          {action.busy ? <Spinner /> : <Play size={13} fill="currentColor" />}
          {position.selected ? "Run selection" : "Run file"}
        </button>
        <details
          className="editor-run-menu"
          ref={runMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label="Run options" title="Run options">
            <ChevronDown size={14} />
          </summary>
          <div className="editor-menu-content">
            <button
              disabled={!doc || !fileLanguage || conflict || !connected || action.busy}
              onClick={() => void action.run(() => run("file"))}
            >
              Run entire file <kbd>{modifier}+Shift+Enter</kbd>
            </button>
            <button
              disabled={!doc || !fileLanguage || conflict || !connected || action.busy}
              onClick={() => void action.run(() => run("line"))}
            >
              Run current line <kbd>Shift+Enter</kbd>
            </button>
          </div>
        </details>
      </div>
      {doc && fileError && (
        <div className="panel-notice" role="status">
          <span>Couldn’t refresh this file. {fileError}</span>
          <button disabled={!connected || action.busy} onClick={() => void action.run(retryOpen)}>
            Retry opening file
          </button>
        </div>
      )}
      {fileLanguage && fileLanguage !== language && (
        <div className="panel-notice">
          This file runs in {languageName(fileLanguage)}. The console is viewing{" "}
          {languageName(language)}.
          <button className="text-button" onClick={() => wb.setLanguage(fileLanguage)}>
            Use {languageName(fileLanguage)} session
          </button>
        </div>
      )}
      {conflict && (
        <div className="conflict" role="status">
          <strong>The working document changed.</strong>
          <p>Your edits are retained on this device. Review both versions before continuing.</p>
          <details>
            <summary>Review working version · revision {doc!.version}</summary>
            <pre>{doc?.content}</pre>
          </details>
          <div className="button-row">
            <button onClick={() => downloadText(draft!.content, `${file.split("/").pop()}.draft`)}>
              <Download size={14} />
              Download my draft
            </button>
            <button onClick={() => wb.discardDraft(file)}>Use working version</button>
            <button onClick={() => wb.keepLocal(file)}>Keep my edits</button>
          </div>
        </div>
      )}
      {doc?.diskConflict && (
        <div className="conflict" role="status">
          <strong>The file changed on disk.</strong>
          <p>
            Your working document is retained. Review the disk version before choosing which to
            keep.
          </p>
          <details>
            <summary>Review disk version</summary>
            <pre>{doc.diskConflict.content ?? "The file was deleted."}</pre>
          </details>
          <div className="button-row">
            <button
              disabled={conflict || action.busy || !connected}
              onClick={() => void action.run(() => wb.reconcile(doc, "working"))}
            >
              Save working version
            </button>
            <button
              disabled={conflict || action.busy || !connected || doc.diskConflict.content === null}
              onClick={() => void action.run(() => wb.reconcile(doc, "disk"))}
            >
              Use disk version
            </button>
          </div>
        </div>
      )}
      {doc ? (
        <CodeMirror
          key={file}
          className="editor"
          aria-label={`Code editor: ${file}`}
          value={draft?.content ?? doc.content}
          onChange={change}
          onUpdate={update}
          initialState={initialState}
          onCreateEditor={(view) => {
            editorView.current = view;
            const selection = view.state.selection.main;
            const line = view.state.doc.lineAt(selection.head);
            setPosition({
              line: line.number,
              column: selection.head - line.from + 1,
              selected: !selection.empty,
            });
            const top = editorMemory.get(memoryKey)?.scrollTop ?? 0;
            requestAnimationFrame(() => {
              if (view.dom.isConnected) view.scrollDOM.scrollTop = top;
            });
          }}
          height="100%"
          extensions={extensions}
          basicSetup={editorSetup}
        />
      ) : (
        <Empty icon={<FileCode2 size={25} />}>
          <strong>
            {fileError
              ? "Couldn’t open this file"
              : file
                ? "Opening your file…"
                : "Your project starts here"}
          </strong>
          <p>
            {fileError ||
              (file
                ? "Loading the working document."
                : "Create a script or notes file to develop your work alongside the conversation.")}
          </p>
          {fileError && (
            <button disabled={!connected || action.busy} onClick={() => void action.run(retryOpen)}>
              Retry opening file
            </button>
          )}
          {!file && (
            <button
              disabled={!connected}
              onClick={() => {
                setNewPath("");
                setCreateError("");
                setCreating(true);
              }}
            >
              <FilePlus2 size={14} />
              Create a file
            </button>
          )}
        </Empty>
      )}
      <div className="editor-footer">
        <span>
          {fileLanguage ? languageName(fileLanguage) : "Text"}
          <span className="separator">/</span>
          {doc ? `Revision ${doc.version}` : "No file"}
        </span>
        {doc && (
          <span className="cursor-position">
            Ln {position.line}, Col {position.column}
          </span>
        )}
        {doc && (
          <SavedLabel dirty={dirty}>
            {draft
              ? conflict
                ? "Edits need review"
                : connected
                  ? "Syncing edits…"
                  : "Edits retained offline"
              : dirty
                ? "Unsaved file"
                : "Saved to file"}
          </SavedLabel>
        )}
        {active ? (
          <button
            className="text-button"
            disabled={!connected}
            onClick={() =>
              void action.run(() => api(`/executions/${active.id}/cancel`, "POST", {}))
            }
          >
            <Square size={11} />
            Interrupt
          </button>
        ) : lastRun ? (
          <button
            className="text-button"
            aria-label="View output for latest run"
            onClick={() => wb.revealExecution(lastRun)}
          >
            {runLabel} · View output
          </button>
        ) : (
          <span className="shortcut-hint">
            <kbd>{modifier}</kbd>
            <kbd>↵</kbd> {position.selected ? "run selection" : "run file"}
          </span>
        )}
      </div>
      {creating && (
        <Dialog title="New file" onClose={() => setCreating(false)}>
          <p>Create a file in this project. Use .py for Python, .R for R, or .md for notes.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!newPath.trim()) return;
              void createAction.run(async () => {
                setCreateError("");
                try {
                  const created = await api<Document>("/documents", "POST", {
                    path: newPath.trim(),
                  });
                  wb.setFile(created.path);
                  if (/\.r$/i.test(created.path)) wb.setLanguage("r");
                  else if (/\.py$/i.test(created.path)) wb.setLanguage("python");
                  setCreating(false);
                  wb.showPanel("editor");
                } catch (error) {
                  setCreateError(error instanceof Error ? error.message : String(error));
                }
              });
            }}
          >
            <label className="field-label" htmlFor="new-file-path">
              File name
            </label>
            <input
              id="new-file-path"
              autoFocus
              value={newPath}
              maxLength={1000}
              placeholder="e.g. compare_conditions.py"
              onChange={(event) => setNewPath(event.target.value)}
            />
            {createError && (
              <p className="inline-error" role="alert">
                {createError}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!newPath.trim() || !connected || createAction.busy}
              >
                {createAction.busy && <Spinner />}Create file
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
