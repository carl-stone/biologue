import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, ArrowUpRight, Plus, Square, Pencil, Settings2 } from "lucide-react";
import type {
  Conversation,
  Message,
  PermissionRequest,
  PermissionDecisionSummary,
} from "@carl/protocol";
import { api, useWorkbench, useSnapshot } from "../state.tsx";
import { RunActivity } from "./RunActivity.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { Controls } from "./Controls.tsx";
import {
  Dialog,
  CopyButton,
  Spinner,
  timeLabel,
  useAction,
  useFollowOutput,
  useProjectDraft,
} from "../ui.tsx";

function CodeBlock({ children }: { children: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  return (
    <div className="chat-code-block">
      <div className="code-record-heading">
        <span>Code</span>
        <CopyButton text={() => code.current?.textContent ?? ""} />
      </div>
      <pre ref={code}>{children}</pre>
    </div>
  );
}

function MessageContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
    "permissionTarget",
    "revealPermission",
    "loadMessages",
    "panelRequest",
  );
  const { conversation, setConversation, streaming, connected } = wb;
  const snapshot = useSnapshot(
    "runs",
    "permissions",
    "permissionHistory",
    "executions",
    "agent",
    "conversations",
    "researchContext",
  );
  const [drafts, setDrafts] = useProjectDraft<Record<string, string>>("messages", {});
  const text = drafts[conversation] || "";
  const [renaming, setRenaming] = useState(false);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    if (wb.panelRequest?.id === "controls") setSettings(true);
  }, [wb.panelRequest]);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setSettings(false);
  }, [conversation, wb.permissionTarget]);
  useEffect(() => {
    if (!settings) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSettings(false);
        settingsButton.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        !settingsPanel.current?.contains(event.target as Node) &&
        !settingsButton.current?.contains(event.target as Node)
      )
        setSettings(false);
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [settings]);
  const [title, setTitle] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const sendAction = useAction();
  const createAction = useAction();
  const stopAction = useAction();
  const messages = wb.chat.items;
  const runs = snapshot!.runs.filter((run) => run.conversationId === conversation);
  const active = runs.find((run) => run.status === "running");
  const latest = runs.at(-1);
  const lastResponse = new Map<string, string>();
  for (const message of messages)
    if (message.role === "assistant" && message.runId) lastResponse.set(message.runId, message.id);
  const belongsHere = (request: { conversationId?: string; runId: string }) =>
    (request.conversationId ??
      snapshot.runs.find((run) => run.id === request.runId)?.conversationId) === conversation;
  const pendingRequests = snapshot.permissions.filter(belongsHere);
  const visibleHistory = wb.chat.loaded
    ? (snapshot.permissionHistory ?? []).filter(
        (request) =>
          belongsHere(request) &&
          (!wb.chat.next || request.createdAt >= (messages[0]?.createdAt ?? "")),
      )
    : [];
  const requests = [...visibleHistory, ...pendingRequests];
  const reviewing = pendingRequests.length > 0;
  const timeline: {
    message?: Message;
    request?: PermissionRequest | PermissionDecisionSummary;
    streaming: boolean;
    at: string;
  }[] = [
    ...messages.map((message) => ({
      message,
      request: undefined,
      streaming: false,
      at: message.createdAt,
    })),
    ...requests.map((request) => ({
      message: undefined,
      request,
      streaming: false,
      at: request.createdAt,
    })),
  ];
  if (active && streaming[active.id])
    timeline.push({
      message: undefined,
      request: undefined,
      streaming: true,
      at: pendingRequests[0]?.createdAt ?? "9999",
    });
  timeline.sort((a, b) => a.at.localeCompare(b.at) || Number(!!a.request) - Number(!!b.request));
  const activeExecution = snapshot.executions.find(
    (execution) => execution.runId === active?.id && execution.status === "running",
  );
  const workStatus = activeExecution
    ? `${activeExecution.purpose === "inspection" ? "Inspecting" : "Running"} ${activeExecution.language === "r" ? "R" : "Python"} ${activeExecution.purpose === "inspection" ? "objects" : "code"}`
    : "Biologue is working…";
  const scroll = useFollowOutput(
    `${messages.length}:${active && streaming[active.id]}:${requests.map((request) => request.id + ("decision" in request ? request.decision : "pending")).join(":")}`,
    conversation,
    wb.chat.loaded && (messages.length > 0 || requests.length > 0),
  );
  const handledTarget = useRef<typeof wb.permissionTarget>(null);
  useEffect(() => {
    if (!wb.chat.loaded || !wb.permissionTarget || handledTarget.current === wb.permissionTarget)
      return;
    // Dockview activates the panel in its own effect. Focus after that activation.
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`permission-${wb.permissionTarget!.id}`);
      if (element) {
        element.scrollIntoView({ block: "center" });
        element.focus({ preventScroll: true });
        handledTarget.current = wb.permissionTarget;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [wb.permissionTarget, wb.chat.loaded, conversation, requests.length]);
  const [requestVisible, setRequestVisible] = useState(false);
  useEffect(() => {
    setRequestVisible(false);
    const element =
      pendingRequests[0] &&
      document.querySelector(`#permission-${pendingRequests[0].id} .permission-end`);
    if (!element || !scroll.scroll.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setRequestVisible(entry.isIntersecting && entry.intersectionRatio === 1),
      { root: scroll.scroll.current, threshold: [0, 1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [pendingRequests[0]?.id, conversation]);
  const olderScroll = useRef<{ top: number; height: number; conversation: string } | null>(null);
  function sizeComposer() {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180, window.innerHeight * 0.25)}px`;
  }
  useLayoutEffect(sizeComposer, [text, conversation]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      sizeComposer();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
      <div className="pane-toolbar conversation-toolbar">
        <select
          aria-label="Conversation"
          value={conversation}
          title={snapshot.conversations.find((item) => item.id === conversation)?.title}
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
          aria-label="Rename conversation"
          title="Rename conversation"
          disabled={!connected || !conversation}
          onClick={() => {
            setTitle(snapshot.conversations.find((item) => item.id === conversation)?.title || "");
            setRenaming(true);
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          className="text-button"
          title="New conversation"
          aria-label="New conversation"
          disabled={!connected || createAction.busy}
          onClick={() =>
            void createAction.run(async () => {
              const created = await api<Conversation>("/conversations", "POST", {});
              setConversation(created.id);
              requestAnimationFrame(() => input.current?.focus());
            })
          }
        >
          <Plus size={14} /> New
        </button>
      </div>
      <div className="chat-transcript">
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
          {timeline.map((item) => {
            if (item.request)
              return (
                <PermissionCard key={`permission-${item.request.id}`} request={item.request} />
              );
            if (item.streaming && active)
              return (
                <article key="streaming" className="message assistant">
                  <span className="message-author">Biologue</span>
                  <MessageContent text={streaming[active.id]} />
                </article>
              );
            const message = item.message!;
            return (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-heading">
                  <span className="message-author">
                    {message.role === "user" ? "You" : "Biologue"}
                  </span>
                  <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                  {message.role === "assistant" && (
                    <CopyButton text={message.text} label="Copy response" />
                  )}
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
                {message.runId &&
                  message.runId !== active?.id &&
                  lastResponse.get(message.runId) === message.id && (
                    <RunActivity runId={message.runId} />
                  )}
              </article>
            );
          })}
          {active && <RunActivity runId={active.id} />}
          {latest?.error && !active && (
            <div className="inline-error" role="status">
              <strong>Biologue couldn’t finish responding.</strong>
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
      </div>
      {active && (
        <div
          className={`thinking ${reviewing && !requestVisible ? "needs-review" : ""}`}
          role="status"
        >
          {reviewing ? (
            <>
              {requestVisible ? (
                <span>Waiting for your decision</span>
              ) : (
                <>
                  <span className="status-dot waiting" />
                  <button
                    className="text-button"
                    onClick={() => wb.revealPermission(pendingRequests[0])}
                  >
                    Review request <ArrowUpRight size={13} />
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <span className="pulse" />
              {workStatus}
            </>
          )}
          <span className="spacer" />
          <button
            className="text-button"
            aria-label="Stop response"
            title="Stop response"
            disabled={!connected || stopAction.busy}
            onClick={() =>
              void stopAction.run(() => api(`/agent/runs/${active.id}/cancel`, "POST", {}))
            }
          >
            <Square size={13} />
            Stop
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
          placeholder={active ? "Message Biologue…" : "Message Biologue…"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendAction.run(send);
            }
          }}
        />
        <div className="composer-bottom">
          <button
            type="button"
            className="text-button model-settings"
            ref={settingsButton}
            aria-label="Agent settings"
            title="Model and thinking level"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={14} />
            <span>
              {snapshot.agent.enabled ? snapshot.agent.model : "Choose model"}
              {snapshot.agent.enabled && snapshot.agent.thinking
                ? ` · ${snapshot.agent.thinking}`
                : ""}
            </span>
          </button>
          <span className="composer-hint">
            {reviewing ? "Sent after your decision" : active ? "Send a follow-up" : "Enter ↵"}
          </span>
          <button
            className="send"
            aria-label={active ? "Send context" : "Send message"}
            title={
              !connected
                ? "Reconnect to send"
                : !snapshot!.agent.enabled
                  ? "Set up a model to send"
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
            {sendAction.busy ? <Spinner /> : <ArrowUp size={14} />}
            {reviewing ? "Queue message" : "Send"}
          </button>
        </div>
      </form>
      {settings && (
        <div
          className="conversation-settings"
          ref={settingsPanel}
          role="region"
          aria-label="Conversation settings"
        >
          <div className="pane-toolbar">
            <strong>Agent settings</strong>
            <span className="spacer" />
            <button className="text-button" onClick={() => setSettings(false)}>
              Done
            </button>
          </div>
          <Controls />
        </div>
      )}
      {renaming && (
        <Dialog title="Rename conversation" onClose={() => setRenaming(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              void createAction.run(async () => {
                await api<Conversation>(`/conversations/${conversation}`, "PATCH", { title });
                setRenaming(false);
              });
            }}
          >
            <label className="field-label" htmlFor="conversation-title">
              Conversation name
            </label>
            <input
              id="conversation-title"
              autoFocus
              maxLength={120}
              placeholder="Conversation name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setRenaming(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!title.trim() || createAction.busy || !connected}
              >
                {createAction.busy && <Spinner />}Save name
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
