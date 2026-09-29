import { useState } from "react";
import { Download, Save } from "lucide-react";
import type { ResearchContext as Context } from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import { SavedLabel, Spinner, downloadText, modifier, useAction, useProjectDraft } from "../ui.tsx";

export function ResearchContext() {
  const { connected, notify } = useWorkbench("connected", "notify");
  const snapshot = useSnapshot("researchContext");
  const context = snapshot!.researchContext;
  const [draft, setDraft] = useProjectDraft<{ text: string; version: number } | null>(
    "research-draft",
    null,
  );
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const conflict = draft && draft.version !== context.version;
  async function save() {
    if (!draft || conflict || !connected) return;
    const submitted = draft;
    const result = await api<Context>("/context", "PUT", {
      text: submitted.text,
      expectedVersion: submitted.version,
    });
    setDraft((current) =>
      !current || current.text === submitted.text ? null : { ...current, version: result.version },
    );
    setSaved(true);
    notify("Research context saved. New runs will use these notes.");
  }
  return (
    <div className="pane research">
      <div className="research-body">
        <div className="research-intro">
          <h2>Research context</h2>
          <p>Your question, observations, and corrections. Saved notes inform the next run.</p>
          <details className="context-guide">
            <summary>What belongs here?</summary>
            <dl>
              <dt>Observations</dt>
              <dd>What you measured or directly noticed.</dd>
              <dt>Interpretations</dt>
              <dd>What you think those observations mean.</dd>
              <dt>Assumptions</dt>
              <dd>What the analysis takes for granted.</dd>
              <dt>Corrections</dt>
              <dd>What Biologue should stop assuming, and why.</dd>
            </dl>
          </details>
        </div>
        <label className="sr-only" htmlFor="research-notes">
          Research context
        </label>
        <textarea
          id="research-notes"
          placeholder={
            "Question\nWhat are you trying to understand?\n\nObservations\nWhat have you actually observed?\n\nInterpretations & assumptions\nWhat do you suspect, and what remains uncertain?\n\nCorrections\nWhat should Biologue know about your system?"
          }
          value={draft?.text ?? context.text}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(
              text === context.text ? null : { text, version: draft?.version ?? context.version },
            );
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void action.run(save);
            }
          }}
        />
        {conflict && (
          <div className="conflict" role="status">
            <strong>These notes changed elsewhere.</strong>
            <p>Your draft is retained. Review the saved notes before replacing it.</p>
            <details>
              <summary>Review saved notes · version {context.version}</summary>
              <pre>{context.text || "No notes"}</pre>
            </details>
            <div className="button-row">
              <button onClick={() => downloadText(draft!.text, "research-context-draft.txt")}>
                <Download size={14} />
                Download draft
              </button>
              <button onClick={() => setDraft(null)}>Use saved notes</button>
            </div>
          </div>
        )}
        <div className="research-save-state">
          {!draft && context.version === 0 ? (
            <span className="small-note">No context saved yet</span>
          ) : (
            <SavedLabel dirty={!!draft}>
              {draft
                ? "Local draft · not yet shared with Biologue"
                : saved
                  ? "Saved · ready for the next run"
                  : "Saved notes"}
            </SavedLabel>
          )}
        </div>
      </div>
      <div className="pane-toolbar">
        <span className="small-note">
          {context.version ? `Version ${context.version} · authored by you` : "Project notes"}
        </span>
        <span className="spacer" />
        <button
          className="primary"
          title={`Save context (${modifier}+S)`}
          disabled={!draft || !!conflict || action.busy || !connected}
          onClick={() => void action.run(save)}
        >
          {action.busy ? <Spinner /> : <Save size={14} />}Save context
        </button>
      </div>
    </div>
  );
}
