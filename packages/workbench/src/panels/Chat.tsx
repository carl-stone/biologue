import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Plus,
  Square,
  Pencil,
  Settings2,
  Search,
  Paperclip,
  GitBranch,
  X,
} from "lucide-react";
import type {
  Conversation,
  Attachment,
  Message,
  PermissionRequest,
  PermissionDecisionSummary,
  AgentSettings,
} from "@biologue/protocol";
import { api, useWorkbench, useSnapshot, useResource } from "../state.tsx";
import type { AgentResources } from "@biologue/protocol";
import { RunActivity } from "./RunActivity.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { Controls } from "./Controls.tsx";
import { ConversationManager, QuestionCard, UsageDialog } from "./ConversationTools.tsx";
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
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/(?:^|\s)language-(\S+)/)?.[1]
    : undefined;
  return (
    <div className="chat-code-block">
      <div className="code-record-heading">
        <span>{language || "Code"}</span>
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
    "questions",
    "files",
  );
  const [drafts, setDrafts] = useProjectDraft<Record<string, string>>("messages", {});
  const text = drafts[conversation] || "";
  const slash = /^\/\S*$/.test(text);
  const resources = useResource<AgentResources>(slash ? "/agent/resources" : null);
  const [cursor, setCursor] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const mention = text.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
  useEffect(() => setSuggestionIndex(0), [text, cursor]);
  const suggestions: { command: string; description: string; path?: string }[] =
    dismissedSuggestion === text
      ? []
      : mention
        ? snapshot.files
            .filter((path) => path.toLowerCase().includes(mention[1].toLowerCase()))
            .slice(0, 8)
            .map((path) => ({ command: path, description: "Attach project file", path }))
        : slash
          ? [
              { command: "/mcp", description: "MCP connection status" },
              ...(resources.data?.prompts ?? []).map((item) => ({
                command: `/${item.name}`,
                description: item.description,
              })),
              ...(resources.data?.skills ?? []).map((item) => ({
                command: `/skill:${item.name}`,
                description: item.description,
              })),
            ]
              .filter((item) => item.command.startsWith(text))
              .slice(0, 8)
          : [];
  function chooseSuggestion(item: (typeof suggestions)[number]) {
    if (item.path && mention) {
      const start = cursor - mention[1].length - 1;
      setText(text.slice(0, start) + text.slice(cursor));
      setCursor(start);
      void attachmentAction.run(async () => {
        await wb.syncDocuments();
        addAttachment(await api<Attachment>("/attachments", "POST", { path: item.path }));
      });
    } else {
      setText(item.command + " ");
      setCursor(item.command.length + 1);
    }
    input.current?.focus();
  }
  const [renaming, setRenaming] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string>();
  const [history, setHistory] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [queueMode, setQueueMode] = useState<"steer" | "followUp">("steer");
  const [attachmentDrafts, setAttachmentDrafts] = useProjectDraft<Record<string, Attachment[]>>(
    "attachments",
    {},
  );
  const attachments = attachmentDrafts[conversation] ?? [];
  const upload = useRef<HTMLInputElement>(null);
  const attachmentAction = useAction();
  useEffect(() => {
    if (wb.panelRequest?.id === "controls") {
      setSettingsSection("Model");
      setSettings(true);
    }
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
  const current = snapshot.conversations.find((item) => item.id === conversation);
  const agent = current?.settings ?? snapshot.agent;
  const enabled = current?.settings ? !!(agent.provider && agent.model) : snapshot.agent.enabled;
  const questions = (snapshot.questions ?? []).filter(
    (item) => item.conversationId === conversation,
  );
  const usage = active?.usage ?? [...runs].reverse().find((run) => run.usage)?.usage;
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
    : questions.length
      ? "Waiting for your answer"
      : active?.phase === "compacting"
        ? "Compacting context…"
        : active?.phase === "retrying"
          ? (active.phaseDetail ?? "Retrying…")
          : ([...(active?.activity ?? [])].reverse().find((item) => item.status === "running")
              ?.label ?? "Working…");
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
  function addAttachment(item: Attachment) {
    setAttachmentDrafts((current) => ({
      ...current,
      [conversation]: [...(current[conversation] ?? []), item].slice(0, 8),
    }));
  }
  async function attachFiles(files: File[]) {
    if (files.length + attachments.length > 8) throw new Error("Attach up to 8 files per message.");
    for (const file of files) {
      if (file.size > 4_000_000) throw new Error("Attachments must be under 4 MB.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read attachment."));
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file);
      });
      addAttachment(
        await api<Attachment>("/attachments", "POST", {
          name: file.name,
          mimeType: file.type || "text/plain",
          data,
        }),
      );
    }
  }
  async function send() {
    if ((!text.trim() && !attachments.length) || !enabled || !connected || !conversation) return;
    const submitted = text;
    await wb.syncDocuments();
    await api(active ? `/agent/runs/${active.id}/steer` : "/agent/runs", "POST", {
      text: submitted.trim() || "Review the attached files.",
      attachments: attachments.map((item) => item.id),
      ...(active ? { mode: queueMode } : { conversationId: conversation }),
    });
    setDrafts((current) => ({
      ...current,
      [conversation]: current[conversation] === submitted ? "" : current[conversation],
    }));
    setAttachmentDrafts((current) => ({
      ...current,
      [conversation]: (current[conversation] ?? []).filter(
        (item) => !attachments.some((sent) => sent.id === item.id),
      ),
    }));
    scroll.toLatest();
    input.current?.focus();
    if (active)
      wb.notify(
        queueMode === "steer" ? "Sent to the running response." : "Queued after this response.",
      );
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
          {snapshot!.conversations
            .filter((item) => !item.archived || item.id === conversation)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
        <button
          className="icon"
          aria-label="Search conversations"
          title="Search and manage conversations"
          onClick={() => setHistory(true)}
        >
          <Search size={14} />
        </button>
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
                  {message.entryId && !active && (
                    <button
                      className="icon"
                      aria-label="Branch from message"
                      title="Branch from this message; files and sessions stay shared"
                      disabled={createAction.busy || !connected}
                      onClick={() =>
                        void createAction.run(async () => {
                          const child = await api<Conversation>(
                            `/conversations/${conversation}/fork`,
                            "POST",
                            { entryId: message.entryId },
                          );
                          setConversation(child.id);
                        })
                      }
                    >
                      <GitBranch size={13} />
                    </button>
                  )}
                  {message.delivery === "pending" && (
                    <span className="message-delivery" role="status">
                      {active
                        ? message.queue === "steer"
                          ? "Steering"
                          : "Queued"
                        : "Saved for your next message"}
                    </span>
                  )}
                </div>
                {message.role === "assistant" ? (
                  <MessageContent text={message.text} />
                ) : (
                  <div className="message-text">{message.text}</div>
                )}
                {!!message.attachments?.length && (
                  <div className="attachment-list">
                    {message.attachments.map((item) => (
                      <span
                        key={item.id}
                        title={
                          item.document
                            ? `Snapshot of revision ${item.document.version}`
                            : item.mimeType
                        }
                      >
                        <Paperclip size={12} />
                        {item.name}
                      </span>
                    ))}
                  </div>
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
          {(active ?? latest)?.notices?.map((notice, i) => (
            <div
              className={`agent-notice ${notice.level}`}
              key={`${(active ?? latest)?.id}:${i}`}
              role="status"
            >
              <MessageContent text={notice.text} />
            </div>
          ))}
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} />
          ))}
          {active &&
            messages.some((message) => message.delivery === "pending" && message.queue) && (
              <button
                className="text-button"
                disabled={sendAction.busy}
                onClick={() =>
                  void sendAction.run(async () => {
                    const removed = await api<Message[]>(
                      `/agent/runs/${active.id}/clear-queue`,
                      "POST",
                      {},
                    );
                    if (removed.length) {
                      setText(
                        [text, ...removed.map((item) => item.text)].filter(Boolean).join("\n\n"),
                      );
                      setAttachmentDrafts((current) => ({
                        ...current,
                        [conversation]: [
                          ...(current[conversation] ?? []),
                          ...removed.flatMap((item) => item.attachments ?? []),
                        ].filter(
                          (item, i, all) => all.findIndex((other) => other.id === item.id) === i,
                        ),
                      }));
                      input.current?.focus();
                    }
                  })
                }
              >
                Edit queued messages
              </button>
            )}
          {latest?.error && !active && (
            <div className="inline-error" role="status">
              <strong>
                {/oauth|refresh.token|unauthorized|authentication|\b401\b/i.test(latest.error)
                  ? "Sign-in expired"
                  : "Response failed"}
              </strong>
              {/oauth|refresh.token|unauthorized|authentication|\b401\b/i.test(latest.error) ? (
                <>
                  <p>Reconnect your provider account to continue.</p>
                  <button
                    onClick={() => {
                      setSettings(true);
                      setSettingsSection("Providers");
                    }}
                  >
                    Open provider settings
                  </button>
                  <details className="error-details">
                    <summary>Error details</summary>
                    <pre>{latest.error}</pre>
                  </details>
                </>
              ) : (
                <p>{latest.error}</p>
              )}
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
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            void attachmentAction.run(() => attachFiles([...event.dataTransfer.files]));
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void sendAction.run(send);
        }}
      >
        {!!suggestions.length && (
          <div
            className="slash-suggestions"
            id="composer-suggestions"
            role="listbox"
            aria-label={mention ? "Project file suggestions" : "Prompt and skill suggestions"}
          >
            {suggestions.map((item, index) => (
              <button
                type="button"
                key={item.command}
                id={`composer-suggestion-${index}`}
                role="option"
                aria-selected={suggestionIndex === index}
                title={item.description}
                onClick={() => chooseSuggestion(item)}
              >
                <span>{item.command}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        )}
        {!!attachments.length && (
          <div className="attachment-list">
            {attachments.map((item) => (
              <span key={item.id}>
                {item.name}
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    setAttachmentDrafts((current) => ({
                      ...current,
                      [conversation]: attachments.filter((other) => other.id !== item.id),
                    }))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="Message Biologue"
          placeholder={active ? "Message Biologue…" : "Message Biologue…"}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(event.target.selectionStart);
            setDismissedSuggestion(null);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          aria-controls={suggestions.length ? "composer-suggestions" : undefined}
          aria-activedescendant={
            suggestions.length ? `composer-suggestion-${suggestionIndex}` : undefined
          }
          rows={3}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              void attachmentAction.run(() => attachFiles([...event.clipboardData.files]));
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (suggestions.length) {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissedSuggestion(text);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSuggestionIndex(
                  (index) =>
                    (index + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
                    suggestions.length,
                );
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault();
                chooseSuggestion(suggestions[suggestionIndex] ?? suggestions[0]);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendAction.run(send);
            }
          }}
        />
        <div className="composer-bottom">
          <button
            type="button"
            className="icon"
            aria-label="Attach files"
            title="Attach files"
            disabled={attachmentAction.busy || attachments.length >= 8}
            onClick={() => setAttachOpen(true)}
          >
            <Paperclip size={15} />
          </button>
          <button
            type="button"
            className="text-button model-settings"
            ref={settingsButton}
            aria-label="Agent settings"
            title="Model and thinking level"
            aria-expanded={settings}
            onClick={() => {
              setSettingsSection("Model");
              setSettings(!settings);
            }}
          >
            <Settings2 size={14} />
            <span>
              {enabled ? agent.model : "Choose model"}
              {enabled && agent.thinking ? ` · ${agent.thinking}` : ""}
            </span>
          </button>
          {enabled && (
            <button
              type="button"
              className="text-button permission-mode"
              aria-label="Permission settings"
              title="Permission mode"
              onClick={() => {
                setSettingsSection("Model");
                setSettings(!settings);
              }}
            >
              {
                { ask: "Ask", plan: "Plan", edit: "Allow edits", auto: "Full access" }[
                  (agent as AgentSettings).mode ?? "ask"
                ]
              }
            </button>
          )}
          {usage && (
            <button
              className="text-button context-usage"
              type="button"
              aria-label="Context and usage"
              title="Context and usage"
              onClick={() => setUsageOpen(true)}
            >
              {usage.context?.percent == null ? "Usage" : `${Math.round(usage.context.percent)}%`}
            </button>
          )}
          {active ? (
            <select
              className="queue-mode"
              aria-label="Message delivery"
              value={queueMode}
              onChange={(e) => setQueueMode(e.target.value as typeof queueMode)}
            >
              <option value="steer">Steer</option>
              <option value="followUp">Queue</option>
            </select>
          ) : (
            <span className="composer-hint" title="Enter sends · Shift+Enter adds a line">
              Enter ↵
            </span>
          )}
          <button
            className="send"
            aria-label={active ? "Send context" : "Send message"}
            title={
              !connected
                ? "Reconnect to send"
                : !enabled
                  ? "Set up a model to send"
                  : "Send message"
            }
            disabled={
              (!text.trim() && !attachments.length) ||
              !enabled ||
              !connected ||
              sendAction.busy ||
              attachmentAction.busy ||
              !conversation
            }
          >
            {sendAction.busy ? <Spinner /> : <ArrowUp size={14} />}
            {active && queueMode === "followUp" ? "Queue" : "Send"}
          </button>
        </div>
      </form>
      <input
        hidden
        ref={upload}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,text/*,.csv,.tsv,.json,.md,.py,.R,.r,.txt,.yaml,.yml"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void attachmentAction.run(() => attachFiles(files));
        }}
      />
      {attachOpen && (
        <Dialog
          title="Attach files"
          className="attachment-picker"
          onClose={() => setAttachOpen(false)}
        >
          <button
            onClick={() => {
              setAttachOpen(false);
              upload.current?.click();
            }}
          >
            Upload files
          </button>
          <input
            autoFocus
            aria-label="Find project file"
            placeholder="Find project file…"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
          />
          <div className="resource-list">
            {!snapshot.files.some((path) =>
              path.toLowerCase().includes(fileFilter.toLowerCase()),
            ) && <p className="small-note">No matching project files</p>}
            {snapshot.files
              .filter((path) => path.toLowerCase().includes(fileFilter.toLowerCase()))
              .slice(0, 100)
              .map((path) => (
                <button
                  key={path}
                  disabled={attachmentAction.busy}
                  onClick={() =>
                    void attachmentAction.run(async () => {
                      await wb.syncDocuments();
                      addAttachment(await api<Attachment>("/attachments", "POST", { path }));
                      setAttachOpen(false);
                    })
                  }
                >
                  {path}
                </button>
              ))}
          </div>
        </Dialog>
      )}
      {history && <ConversationManager onClose={() => setHistory(false)} />}
      {usageOpen && usage && (
        <UsageDialog usage={usage} active={!!active} onClose={() => setUsageOpen(false)} />
      )}
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
          <Controls
            initialSection={settingsSection}
            onInsert={(value) => {
              setText(value.startsWith("/mcp") ? value : value + text);
              setSettings(false);
              input.current?.focus();
            }}
          />
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
