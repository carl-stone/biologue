import { useState } from "react";
import type { AgentQuestion, Conversation, AgentUsage } from "@carl/protocol";
import { api, base, useResource, useSnapshot, useWorkbench } from "../state.tsx";
import { Dialog, Spinner, useAction } from "../ui.tsx";

export function ConversationManager({ onClose }: { onClose: () => void }) {
  const { conversations, runs } = useSnapshot("conversations", "runs");
  const { conversation, setConversation } = useWorkbench("conversation", "setConversation");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const search = useResource<{ ids: string[] }>(
    query.trim() ? `/conversations/search?q=${encodeURIComponent(query.trim())}` : null,
  );
  const action = useAction();
  const current = conversations.find((item) => item.id === conversation);
  const update = (id: string, value: object) =>
    action.run(() => api(`/conversations/${id}`, "PATCH", value));
  const visible = conversations
    .filter(
      (item) =>
        Boolean(item.archived) === archived &&
        (!query.trim() ||
          item.title.toLowerCase().includes(query.toLowerCase()) ||
          search.data?.ids.includes(item.id)),
    )
    .sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt),
    );
  return (
    <Dialog title="Conversations" onClose={onClose}>
      <input
        autoFocus
        aria-label="Search conversations"
        placeholder="Search titles and messages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <label className="checkbox-label">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Archived
      </label>
      {search.error && <p role="alert">{search.error}</p>}
      <div className="conversation-list">
        {search.loading && (
          <p className="small-note">
            <Spinner /> Searching…
          </p>
        )}
        {!visible.length && !search.loading && (
          <p className="small-note">
            {query
              ? "No matching conversations"
              : archived
                ? "No archived conversations"
                : "No conversations"}
          </p>
        )}
        {visible.map((item) => (
          <div key={item.id} className="conversation-row">
            <button
              className="text-button conversation-name"
              aria-current={item.id === conversation}
              onClick={() => {
                setConversation(item.id);
                onClose();
              }}
            >
              {item.pinned ? "★ " : ""}
              {item.title}
              {runs.some((run) => run.conversationId === item.id && run.status === "running")
                ? " · Running"
                : ""}
            </button>
            <button
              title={item.pinned ? "Unpin" : "Pin"}
              disabled={action.busy}
              onClick={() => void update(item.id, { pinned: !item.pinned })}
            >
              {item.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              disabled={
                action.busy ||
                runs.some((run) => run.conversationId === item.id && run.status === "running")
              }
              onClick={() => void update(item.id, { archived: !item.archived })}
            >
              {item.archived ? "Restore" : "Archive"}
            </button>
          </div>
        ))}
      </div>
      {current && (
        <div className="dialog-actions">
          <a
            className="icon-link"
            href={`${base}/api/conversations/${conversation}/export`}
            download
          >
            Export Markdown
          </a>
          <button
            disabled={
              action.busy ||
              runs.some((run) => run.conversationId === conversation && run.status === "running")
            }
            title="Copies conversation history. Files and live sessions stay shared."
            onClick={() =>
              void action.run(async () => {
                const fork = await api<Conversation>(
                  `/conversations/${conversation}/fork`,
                  "POST",
                  {},
                );
                setConversation(fork.id);
                onClose();
              })
            }
          >
            Branch conversation
          </button>
        </div>
      )}
    </Dialog>
  );
}

export function QuestionCard({ question }: { question: AgentQuestion }) {
  const [answer, setAnswer] = useState("");
  const action = useAction();
  return (
    <form
      className="agent-question"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(() => api(`/agent/questions/${question.id}`, "POST", { answer }));
      }}
    >
      <p>{question.title}</p>
      {question.options ? (
        <div className="question-options">
          {question.options.map((option) => (
            <button
              type="button"
              key={option}
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  api(`/agent/questions/${question.id}`, "POST", { answer: option }),
                )
              }
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <>
          <textarea
            aria-label="Answer Biologue"
            placeholder={question.placeholder ?? "Your answer…"}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
          />
          <button disabled={action.busy || !answer.trim()}>Answer</button>
        </>
      )}
      <button
        className="text-button"
        type="button"
        disabled={action.busy}
        onClick={() => void action.run(() => api(`/agent/questions/${question.id}`, "POST", {}))}
      >
        Skip
      </button>
    </form>
  );
}

export function UsageDialog({
  usage,
  active,
  onClose,
}: {
  usage: AgentUsage;
  active: boolean;
  onClose: () => void;
}) {
  const { conversation, notify } = useWorkbench("conversation", "notify");
  const action = useAction();
  return (
    <Dialog title="Context and usage" onClose={onClose}>
      <dl className="usage-grid">
        <dt>Context</dt>
        <dd>
          {usage.context?.tokens?.toLocaleString() ?? "Unknown"} /{" "}
          {usage.context?.contextWindow.toLocaleString() ?? "Unknown"}
        </dd>
        <dt>Input tokens</dt>
        <dd>{usage.tokens.input.toLocaleString()}</dd>
        <dt>Output tokens</dt>
        <dd>{usage.tokens.output.toLocaleString()}</dd>
        <dt>Cached input</dt>
        <dd>{usage.tokens.cacheRead.toLocaleString()}</dd>
        <dt>Cache writes</dt>
        <dd>{usage.tokens.cacheWrite.toLocaleString()}</dd>
        <dt>Estimated token cost</dt>
        <dd>${usage.cost.toFixed(4)}</dd>
      </dl>
      <p className="small-note">
        Subscription billing may differ. Compaction summarizes the model’s context and keeps your
        transcript.
      </p>
      <div className="dialog-actions">
        <button
          disabled={active || action.busy}
          title={
            active
              ? "Stop the response before compacting context"
              : "Summarize conversation context"
          }
          onClick={() =>
            void action.run(async () => {
              await api(`/conversations/${conversation}/compact`, "POST", {});
              notify("Compacting context…");
              onClose();
            })
          }
        >
          Compact context
        </button>
      </div>
    </Dialog>
  );
}
