import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { r } from "@codemirror/legacy-modes/mode/r";
import { keymap, EditorView } from "@codemirror/view";
import { FileCode2, Play, Save, Square, Download } from "lucide-react";
import type { Document, Execution, Language } from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import {
  Empty,
  SavedLabel,
  Spinner,
  downloadText,
  languageName,
  modifier,
  useAction,
} from "../ui.tsx";

const editorSetup = { foldGutter: true, autocompletion: true, highlightActiveLine: true };
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
  );
  const { file, language, drafts, connected } = wb;
  const snapshot = useSnapshot("documents", "files", "executions");
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
  const conflict = !!(doc && draft && draft.baseVersion !== doc.version);
  const dirty = !!(draft || (doc && doc.version !== doc.savedVersion));
  useEffect(() => {
    if (snapshot && file) void wb.perform(() => wb.open(file));
  }, [file, !!snapshot]);
  async function save() {
    if (!doc || conflict || doc.diskConflict || !connected) return;
    const current = await wb.flush(doc);
    await api<Document>("/documents/save", "POST", {
      path: current.path,
      expectedVersion: current.version,
    });
    wb.notify(`Saved ${current.path}`);
  }
  async function run() {
    if (!doc || !fileLanguage || conflict || !connected) return;
    const current = await wb.flush(doc);
    if (!current.content.trim()) return;
    wb.setLanguage(fileLanguage);
    const execution = await api<Execution>("/executions", "POST", {
      language: fileLanguage,
      code: current.content,
      document: { path: current.path, version: current.version },
    });
    wb.revealExecution(execution, false);
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
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            const current = commands.current;
            void current.action.run(current.run);
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
    ],
    [file, fileLanguage],
  );
  const change = useCallback((content: string) => {
    const current = commands.current;
    if (current.doc) current.draft(current.doc, content);
  }, []);
  return (
    <div className="pane editor-pane">
      <div className="pane-toolbar editor-toolbar">
        <FileCode2 size={16} aria-hidden="true" />
        <select
          aria-label="Project file"
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
          title={`Run the entire file in ${languageName(fileLanguage || language)} (${modifier}+Enter)`}
          onClick={() => void action.run(run)}
        >
          {action.busy ? <Spinner /> : <Play size={13} fill="currentColor" />}Run file
        </button>
      </div>
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
          height="100%"
          extensions={extensions}
          basicSetup={editorSetup}
        />
      ) : (
        <Empty icon={<FileCode2 size={25} />}>
          <strong>{file ? "Opening your file…" : "Your project starts here"}</strong>
          <p>
            {file
              ? "Loading the working document."
              : "Add a script to your project folder, then reload the workspace."}
          </p>
        </Empty>
      )}
      <div className="editor-footer">
        <span>
          {fileLanguage ? languageName(fileLanguage) : "Text"}
          <span className="separator">/</span>
          {doc ? `Revision ${doc.version}` : "No file"}
        </span>
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
        ) : (
          <span className="shortcut-hint">
            <kbd>{modifier}</kbd>
            <kbd>↵</kbd> run file
          </span>
        )}
      </div>
    </div>
  );
}
