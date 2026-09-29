import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { Prec, type EditorState, type ViewUpdate } from "@uiw/react-codemirror";
import { historyField, undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { r } from "@codemirror/legacy-modes/mode/r";
import { keymap, EditorView } from "@codemirror/view";
import {
  FileCode2,
  FilePlus2,
  Play,
  Save,
  Square,
  Download,
  FolderOpen,
  X,
  Search,
  Undo2,
  Redo2,
  ChevronsRight,
} from "lucide-react";
import type { Document, Execution, Language } from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import {
  Empty,
  Dialog,
  Spinner,
  downloadText,
  languageName,
  modifier,
  useAction,
  useProjectDraft,
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
  const action = useAction();
  const createAction = useAction();
  const [savingAs, setSavingAs] = useState(false);
  const [tabs, setTabs] = useProjectDraft<string[]>(
    "editor-tabs",
    snapshot.files.filter((path) => /\.(py|r)$/i.test(path)),
  );
  const [opening, setOpening] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const availableFiles = [
    ...new Set([
      ...snapshot.files,
      ...Object.keys(drafts),
      ...snapshot.documents
        .filter((item) => !item.savedAs || drafts[item.path])
        .map((item) => item.path),
    ]),
  ];
  const openTabs = [...new Set(tabs)].filter((path) => availableFiles.includes(path));
  useEffect(() => {
    if (file && !tabs.includes(file))
      setTabs((current) => (current.includes(file) ? current : [...current, file]));
  }, [file, tabs]);
  function chooseFile(path: string) {
    wb.setFile(path);
    if (/\.r$/i.test(path)) wb.setLanguage("r");
    else if (/\.py$/i.test(path)) wb.setLanguage("python");
  }
  function closeTab(path: string) {
    const next = openTabs.filter((item) => item !== path);
    setTabs(next);
    if (file === path) chooseFile(next[Math.min(openTabs.indexOf(path), next.length - 1)] || "");
    const closed = snapshot.documents.find((item) => item.path === path);
    if (drafts[path] || (closed && closed.version !== closed.savedVersion))
      wb.notify("Tab closed. Unsaved work is retained in Open file.");
  }
  async function newFile() {
    const created = await api<Document>("/documents/untitled", "POST", { language });
    await wb.open(created.path);
    chooseFile(created.path);
    requestAnimationFrame(() => editorView.current?.focus());
  }
  const [newPath, setNewPath] = useState("");
  const [createError, setCreateError] = useState("");
  const [openFailure, setOpenFailure] = useState<{ path: string; message: string } | null>(null);
  const fileError = openFailure?.path === file ? openFailure.message : "";
  const [position, setPosition] = useState({ line: 1, column: 1, selected: false });
  const editorView = useRef<EditorView | null>(null);
  const memoryKey = `${snapshot.project}:${file}`;
  const initialState = useMemo(() => {
    const saved = editorMemory.get(memoryKey);
    return saved && saved.state.doc.toString() === (draft?.content ?? doc?.content)
      ? { json: saved.state.toJSON({ history: historyField }), fields: { history: historyField } }
      : undefined;
  }, [memoryKey, !!doc]);
  const conflict = !!doc?.savedAs || !!(doc && draft && draft.baseVersion !== doc.version);
  const dirty = !!(draft || (doc && (doc.untitled || doc.version !== doc.savedVersion)));
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
    if (doc.untitled) {
      setNewPath("");
      setCreateError("");
      setSavingAs(true);
      return;
    }
    const current = await wb.flush(doc);
    await api<Document>("/documents/save", "POST", {
      path: current.path,
      expectedVersion: current.version,
    });
    wb.notify(`Saved ${current.path}`);
  }
  async function run(scope: "file" | "selection" | "line" = "file") {
    if (!doc || !fileLanguage || conflict || !connected) return;
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
    const view = editorView.current;
    if (scope === "line" && view && line && view.state.doc.toString() === text) {
      const next =
        line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1).from : line.to;
      view.dispatch({ selection: { anchor: next }, scrollIntoView: true });
    }
    view?.focus();
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
                current.run(view.state.selection.main.empty ? "line" : "selection"),
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
  return (
    <div className="pane editor-pane">
      <div className="editor-tab-strip">
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {openTabs.map((path, index) => {
            const item = snapshot.documents.find((item) => item.path === path);
            const unsaved = !!drafts[path] || !!(item && item.version !== item.savedVersion);
            return (
              <div className={`file-tab ${path === file ? "selected" : ""}`} key={path}>
                <button
                  role="tab"
                  aria-selected={path === file}
                  aria-label={path.split("/").pop()}
                  aria-description={`${unsaved ? "Unsaved changes. " : ""}Press Delete to close this tab; unsaved work is retained.`}
                  aria-controls="editor-document"
                  aria-keyshortcuts="Delete"
                  tabIndex={path === file ? 0 : -1}
                  id={`file-tab-${index}`}
                  title={item?.untitled ? "Untitled document" : path}
                  onClick={() => chooseFile(path)}
                  onKeyDown={(event) => {
                    if (event.key === "Delete") {
                      event.preventDefault();
                      closeTab(path);
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>('.file-tab.selected [role="tab"]')
                          ?.focus(),
                      );
                      return;
                    }
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % openTabs.length
                        : event.key === "ArrowLeft"
                          ? (index + openTabs.length - 1) % openTabs.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? openTabs.length - 1
                              : -1;
                    if (next >= 0) {
                      event.preventDefault();
                      chooseFile(openTabs[next]);
                      document.getElementById(`file-tab-${next}`)?.focus();
                    }
                  }}
                >
                  <FileCode2 size={13} />
                  <span>{path.split("/").pop()}</span>
                  {unsaved && <span className="unsaved-dot" aria-label="Unsaved changes" />}
                  <span
                    className="tab-close"
                    aria-hidden="true"
                    title={`Close ${path.split("/").pop()}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(path);
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="icon"
          aria-label="New file"
          title="New untitled file"
          disabled={!connected || createAction.busy}
          onClick={() => void createAction.run(newFile)}
        >
          <FilePlus2 size={15} />
        </button>
        <button
          className="icon"
          aria-label="Open file"
          title="Open project file"
          onClick={() => {
            setFileQuery("");
            setOpening(true);
          }}
        >
          <FolderOpen size={15} />
        </button>
      </div>
      <div className="pane-toolbar editor-toolbar">
        <button
          className={`save-file ${dirty ? "has-changes" : ""}`}
          aria-label="Save file"
          aria-description={dirty ? "Unsaved changes" : "File is saved"}
          title={`Save file (${modifier}+S)`}
          disabled={!doc || !dirty || conflict || !!doc.diskConflict || action.busy || !connected}
          onClick={() => void action.run(save)}
        >
          <Save size={15} />
          <span>Save</span>
          {dirty && <span className="unsaved-dot" aria-label="Unsaved changes" />}
        </button>
        {doc && (draft || conflict || !dirty) && (
          <span className="save-feedback" role="status">
            {conflict
              ? "Review edits"
              : draft
                ? connected
                  ? "Syncing…"
                  : "Offline edits"
                : "Saved"}
          </span>
        )}
        <button
          className="icon"
          aria-label="Undo"
          title={`Undo (${modifier}+Z)`}
          disabled={!doc}
          onClick={() => {
            if (editorView.current) {
              undo(editorView.current);
              editorView.current.focus();
            }
          }}
        >
          <Undo2 size={14} />
        </button>
        <button
          className="icon"
          aria-label="Redo"
          title={`Redo (${modifier}+Shift+Z)`}
          disabled={!doc}
          onClick={() => {
            if (editorView.current) {
              redo(editorView.current);
              editorView.current.focus();
            }
          }}
        >
          <Redo2 size={14} />
        </button>
        <button
          className="icon"
          aria-label="Find and replace"
          title={`Find and replace (${modifier}+F)`}
          disabled={!doc}
          onClick={() => {
            if (editorView.current) openSearchPanel(editorView.current);
          }}
        >
          <Search size={14} />
        </button>
        <span className="spacer" />
        {active && (
          <button
            className="icon interrupt"
            aria-label="Interrupt code"
            title="Interrupt running code"
            disabled={!connected}
            onClick={() =>
              void action.run(() => api(`/executions/${active.id}/cancel`, "POST", {}))
            }
          >
            <Square size={13} fill="currentColor" />
          </button>
        )}
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
          aria-label={position.selected ? "Run selection" : "Run current line"}
          title={`Run ${position.selected ? "selected code" : "current line"} in ${languageName(fileLanguage || language)} (${modifier}+Enter)`}
          onClick={() => void action.run(() => run(position.selected ? "selection" : "line"))}
        >
          {action.busy ? <Spinner /> : <Play size={13} fill="currentColor" />}
          Run
        </button>
        <button
          className="run-all"
          title={`Run entire file (${modifier}+Shift+Enter)`}
          disabled={
            !doc ||
            !fileLanguage ||
            conflict ||
            !connected ||
            action.busy ||
            !(draft?.content ?? doc.content).trim()
          }
          onClick={() => void action.run(() => run("file"))}
        >
          <ChevronsRight size={15} />
          Run all
        </button>
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
      {doc?.savedAs && draft && (
        <div className="conflict" role="status">
          <strong>This document was saved as {doc.savedAs}.</strong>
          <p>
            Your local edits are retained. Keep them in a new untitled document or open the saved
            file.
          </p>
          <div className="button-row">
            <button
              disabled={!connected || createAction.busy}
              onClick={() =>
                void createAction.run(async () => {
                  const created = await api<Document>("/documents/untitled", "POST", {
                    language: fileLanguage || language,
                  });
                  await wb.open(created.path);
                  wb.draft(created, draft.content);
                  await wb.flush(created);
                  wb.discardDraft(doc.path);
                  chooseFile(created.path);
                })
              }
            >
              Keep as untitled
            </button>
            <button onClick={() => chooseFile(doc.savedAs!)}>Open saved file</button>
            <button onClick={() => downloadText(draft.content, `${file.split("/").pop()}.draft`)}>
              Download my draft
            </button>
          </div>
        </div>
      )}
      {conflict && !doc?.savedAs && (
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
          id="editor-document"
          role="tabpanel"
          aria-labelledby={`file-tab-${openTabs.indexOf(file)}`}
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
            <button disabled={!connected} onClick={() => void createAction.run(newFile)}>
              <FilePlus2 size={14} />
              Create a file
            </button>
          )}
        </Empty>
      )}
      <div className="editor-footer">
        <span>{fileLanguage ? languageName(fileLanguage) : "Text"}</span>
        {doc && (
          <span className="cursor-position">
            Ln {position.line}, Col {position.column}
          </span>
        )}
        <span className="shortcut-hint">
          {modifier}+Enter · {position.selected ? "Run selection" : "Run line"}
        </span>
      </div>
      {opening && (
        <Dialog title="Open file" onClose={() => setOpening(false)}>
          <label className="field-label" htmlFor="file-search">
            Find a project file
          </label>
          <input
            id="file-search"
            autoFocus
            value={fileQuery}
            placeholder="Search files…"
            onChange={(event) => setFileQuery(event.target.value)}
          />
          <div className="open-file-list">
            {availableFiles
              .filter((path) => path.toLowerCase().includes(fileQuery.toLowerCase()))
              .map((path) => (
                <button
                  key={path}
                  onClick={() => {
                    chooseFile(path);
                    setOpening(false);
                  }}
                >
                  <FileCode2 size={15} />
                  <span>{path.startsWith("untitled:") ? path.split("/").pop() : path}</span>
                  {(drafts[path] ||
                    snapshot.documents.some(
                      (doc) => doc.path === path && doc.version !== doc.savedVersion,
                    )) && <small>Unsaved</small>}
                </button>
              ))}
          </div>
        </Dialog>
      )}
      {savingAs && doc && (
        <Dialog title="Save file" onClose={() => setSavingAs(false)}>
          <p>
            Choose a name in this project. Your untitled document is retained until you save it.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!newPath.trim()) return;
              void createAction.run(async () => {
                setCreateError("");
                try {
                  const current = await wb.flush(doc);
                  const created = await api<Document>("/documents/save-as", "POST", {
                    path: current.path,
                    expectedVersion: current.version,
                    target: newPath.trim(),
                  });
                  await wb.open(created.path);
                  setTabs((current) => [
                    ...new Set(current.map((path) => (path === doc.path ? created.path : path))),
                  ]);
                  wb.setFile(created.path);
                  if (/\.r$/i.test(created.path)) wb.setLanguage("r");
                  else if (/\.py$/i.test(created.path)) wb.setLanguage("python");
                  setSavingAs(false);
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
              <button type="button" onClick={() => setSavingAs(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!newPath.trim() || !connected || createAction.busy}
              >
                {createAction.busy && <Spinner />}Save file
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
