import { useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  FlaskConical,
  NotebookPen,
  Plus,
  Square,
} from "lucide-react";
import type { Conversation } from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import {
  Dialog,
  Spinner,
  modifier,
  timeLabel,
  useAction,
  useFollowOutput,
  useProjectDraft,
} from "../ui.tsx";

function MessageContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || "Open image"}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function Chat() {
  const wb = useWorkbench(
    "conversation",
    "setConversation",
    "streaming",
    "connected",
    "showPanel",
    "notify",
    "syncDocuments",
    "chat",
    "loadMessages",
  );
  const { conversation, setConversation, streaming, connected } = wb;
  const snapshot = useSnapshot("runs", "permissions", "agent", "conversations", "researchContext");
  const [drafts, setDrafts] = useProjectDraft<Record<string, string>>("messages", {});
  const text = drafts[conversation] || "";
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const sendAction = useAction();
  const createAction = useAction();
  const stopAction = useAction();
  const messages = wb.chat.items;
  const runs = snapshot!.runs.filter((run) => run.conversationId === conversation);
  const active = runs.find((run) => run.status === "running");
  const latest = runs.at(-1);
  const reviewing = active && snapshot!.permissions.some((request) => request.runId === active.id);
  const scroll = useFollowOutput(
    `${messages.length}:${active && streaming[active.id]}`,
    conversation,
    messages.length > 0,
  );
  const olderScroll = useRef<{ top: number; height: number; conversation: string } | null>(null);
  useLayoutEffect(() => {
    const saved = olderScroll.current,
      element = scroll.scroll.current;
    if (!wb.chat.loading && saved && element) {
      if (saved.conversation === conversation)
        element.scrollTop = saved.top + element.scrollHeight - saved.height;
      olderScroll.current = null;
    }
  }, [wb.chat.loading, messages, conversation]);
  function loadEarlier() {
    const element = scroll.scroll.current;
    if (element)
      olderScroll.current = { top: element.scrollTop, height: element.scrollHeight, conversation };
    void wb.loadMessages();
  }
  function setText(value: string) {
    setDrafts((current) => ({ ...current, [conversation]: value }));
  }
  async function send() {
    if (!text.trim() || !snapshot!.agent.enabled || !connected || !conversation) return;
    const submitted = text;
    await wb.syncDocuments();
    await api(
      active ? `/agent/runs/${active.id}/steer` : "/agent/runs",
      "POST",
      active ? { text: submitted } : { text: submitted, conversationId: conversation },
    );
    setDrafts((current) => ({
      ...current,
      [conversation]: current[conversation] === submitted ? "" : current[conversation],
    }));
    scroll.toLatest();
    input.current?.focus();
    if (active) wb.notify("Message queued for Biologue.");
  }
  return (
    <div className="chat pane">
      <div className="pane-toolbar">
        <select
          aria-label="Conversation"
          value={conversation}
          onChange={(event) => setConversation(event.target.value)}
        >
          {snapshot!.conversations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <button
          className="icon"
          title="New conversation"
          aria-label="New conversation"
          disabled={!connected}
          onClick={() => {
            setTitle("");
            setCreating(true);
          }}
        >
          <Plus size={17} />
        </button>
      </div>
      <button className="context-link" onClick={() => wb.showPanel("context")}>
        <NotebookPen size={14} />
        {snapshot!.researchContext.version
          ? `Research context · v${snapshot!.researchContext.version}`
          : "Add your research context"}
        <ArrowUpRight size={13} />
      </button>
      <div className="chat-messages" ref={scroll.scroll} onScroll={scroll.onScroll}>
        {wb.chat.error && (
          <div className="inline-error" role="alert">
            <p>{wb.chat.error}</p>
            <button onClick={loadEarlier} disabled={!connected || wb.chat.loading}>
              Retry loading messages
            </button>
          </div>
        )}
        {wb.chat.next && !wb.chat.error && (
          <button
            className="text-button"
            onClick={loadEarlier}
            disabled={!connected || wb.chat.loading}
          >
            {wb.chat.loading ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
        )}
        {wb.chat.loading && !wb.chat.loaded && <div role="status">Loading conversation…</div>}
        {wb.chat.loaded && !messages.length && (
          <div className="conversation-empty">
            <div className="carl-mark">
              <FlaskConical size={27} strokeWidth={1.5} />
            </div>
            <span className="eyebrow">A place to think together</span>
            <h1>
              What are you trying
              <br />
              to understand?
            </h1>
            <p>
              A result you don’t trust. A pattern you can’t explain. Start with the question that
              matters to you.
            </p>
            <div className="conversation-hint">
              <span>Bring the context</span>
              <p>
                What you observed, what you suspect, and what someone outside your lab would miss.
              </p>
              <button className="text-button" onClick={() => wb.showPanel("context")}>
                Make a research note <ArrowUpRight size={14} />
              </button>
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div className="message-heading">
              <span className="message-author">{message.role === "user" ? "You" : "Biologue"}</span>
              <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
              {message.delivery === "pending" && (
                <span className="message-delivery" role="status">
                  {active ? "Queued" : "Saved for your next message"}
                </span>
              )}
            </div>
            {message.role === "assistant" ? (
              <MessageContent text={message.text} />
            ) : (
              <div className="message-text">{message.text}</div>
            )}
          </article>
        ))}
        {active && streaming[active.id] && (
          <article className="message assistant">
            <span className="message-author">Biologue</span>
            <MessageContent text={streaming[active.id]} />
          </article>
        )}
        {latest?.error && !active && (
          <div className="inline-error" role="status">
            <strong>The run could not finish.</strong>
            <p>{latest.error}</p>
            <span>Your conversation is retained. You can send a follow-up.</span>
          </div>
        )}
      </div>
      {scroll.away && (
        <button className="jump-latest" onClick={scroll.toLatest}>
          <ArrowDown size={14} />
          Latest messages
        </button>
      )}
      {active && (
        <div className={`thinking ${reviewing ? "needs-review" : ""}`} role="status">
          {reviewing ? (
            <>
              <span className="status-dot waiting" />
              <button className="text-button" onClick={() => wb.showPanel("controls")}>
                Review Biologue’s request <ArrowUpRight size={13} />
              </button>
            </>
          ) : (
            <>
              <span className="pulse" />
              Working with your context
            </>
          )}
          <span className="spacer" />
          <button
            className="icon"
            aria-label="Stop agent run"
            title="Stop agent run"
            disabled={!connected || stopAction.busy}
            onClick={() =>
              void stopAction.run(() => api(`/agent/runs/${active.id}/cancel`, "POST", {}))
            }
          >
            <Square size={13} />
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendAction.run(send);
        }}
      >
        <textarea
          ref={input}
          aria-label="Message Biologue"
          placeholder={
            active ? "Add context or steer the work…" : "Think it through with Biologue…"
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void sendAction.run(send);
            }
          }}
        />
        <div className="composer-bottom">
          {!snapshot!.agent.enabled ? (
            <button
              type="button"
              className="text-button setup-link"
              onClick={() => wb.showPanel("controls")}
            >
              Connect a model <ArrowUpRight size={13} />
            </button>
          ) : (
            <span>{active ? "Send context to this run" : `${modifier}+Enter to send`}</span>
          )}
          <button
            className="send"
            aria-label={active ? "Send context" : "Send message"}
            title={
              !connected
                ? "Reconnect to send"
                : !snapshot!.agent.enabled
                  ? "Connect a model in Agent to send"
                  : "Send message"
            }
            disabled={
              !text.trim() ||
              !snapshot!.agent.enabled ||
              !connected ||
              sendAction.busy ||
              !conversation
            }
          >
            {sendAction.busy ? <Spinner /> : <ArrowUp size={18} />}
          </button>
        </div>
      </form>
      {creating && (
        <Dialog title="New conversation" onClose={() => setCreating(false)}>
          <p>Give this investigation a name. Your project’s research context will come with it.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              void createAction.run(async () => {
                const created = await api<Conversation>("/conversations", "POST", { title });
                setConversation(created.id);
                setCreating(false);
              });
            }}
          >
            <label className="field-label" htmlFor="conversation-title">
              Investigation name
            </label>
            <input
              id="conversation-title"
              autoFocus
              maxLength={120}
              placeholder="e.g. Understanding the unexpected signal"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!title.trim() || createAction.busy || !connected}
              >
                {createAction.busy && <Spinner />}Create conversation
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
