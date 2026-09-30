import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  AppEvent,
  Document,
  Execution,
  ExecutionSummary,
  Language,
  OutputReference,
  Snapshot,
  Page,
  Message,
  PermissionRequest,
} from "@biologue/protocol";
import { ConversationHistory, type ConversationHistoryState } from "./conversation-history.ts";
import { DocumentSync, type PendingEdit } from "./document-sync.ts";

export const origin = "__TAURI_INTERNALS__" in window ? "http://127.0.0.1:4317" : "";
const projectKey = new URLSearchParams(window.location.search).get("project");
export const base =
  origin + (projectKey && /^[a-f0-9]{24}$/.test(projectKey) ? `/projects/${projectKey}` : "");
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Biologue-Client": "workbench" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Could not reach the workspace. Check the connection before trying again. Your drafts are retained.",
    );
  }
  const value = await response.json().catch(() => {
    throw new Error(`The workspace returned an unexpected response (${response.status}).`);
  });
  if (!response.ok)
    throw Object.assign(new Error(value.error || `Request failed (${response.status}).`), {
      status: response.status,
    });
  return value as T;
}
function upsert<T extends { id: string }>(items: T[], value: T) {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];
}
export function applyEvent(state: Snapshot, event: AppEvent): Snapshot {
  switch (event.type) {
    case "question":
      return { ...state, questions: upsert(state.questions ?? [], event.question) };
    case "question-resolved":
      return {
        ...state,
        questions: (state.questions ?? []).filter((item) => item.id !== event.id),
      };
    case "agent-settings":
      return { ...state, agent: event.agent };
    case "execution":
      return { ...state, executions: upsert(state.executions, event.execution) };
    case "document":
      return {
        ...state,
        files:
          event.document.untitled || state.files.includes(event.document.path)
            ? state.files
            : [...state.files, event.document.path].sort(),
        documents: state.documents.some((doc) => doc.path === event.document.path)
          ? state.documents.map((doc) =>
              doc.path === event.document.path && event.document.version >= doc.version
                ? event.document
                : doc,
            )
          : [...state.documents, event.document],
      };
    case "agent-run":
      return { ...state, runs: upsert(state.runs, event.run) };
    case "permission":
      return { ...state, permissions: upsert(state.permissions, event.request) };
    case "permission-resolved":
      return {
        ...state,
        permissions: state.permissions.filter((item) => item.id !== event.id),
        permissionHistory: event.resolution
          ? upsert(state.permissionHistory ?? [], event.resolution).slice(-100)
          : state.permissionHistory,
      };
    case "context":
      return { ...state, researchContext: event.context };
    case "conversation":
      return { ...state, conversations: upsert(state.conversations, event.conversation) };
    default:
      return state;
  }
}
export type PanelId =
  "chat" | "editor" | "console" | "environment" | "plots" | "data" | "context" | "controls";
type TablePreview = { name: string; executionId: string; language: Language };
type ArtifactTarget = {
  executionId: string;
  outputId: string;
  language: Language;
  panel: "plots" | "data";
};
type PlotView = {
  before?: string;
  selectedSlot: string | null;
  dismissedTarget: ArtifactTarget | null;
};
interface WorkbenchState {
  snapshot: Snapshot | null;
  ready: boolean;
  outputVersions: Record<string, number>;
  keepLocal: (path: string) => void;
  reconcile: (doc: Document, choice: "disk" | "working") => Promise<void>;
  loadExecutions: () => Promise<void>;
  chat: ConversationHistoryState;
  loadMessages: () => Promise<void>;
  syncDocuments: () => Promise<void>;
  connected: boolean;
  error: string;
  setError: (value: string) => void;
  language: Language;
  setLanguage: (value: Language) => void;
  file: string;
  setFile: (value: string) => void;
  conversation: string;
  setConversation: (value: string) => void;
  drafts: Record<string, PendingEdit>;
  draft: (doc: Document, content: string) => void;
  discardDraft: (path: string) => void;
  flush: (doc: Document) => Promise<Document>;
  open: (path: string) => Promise<void>;
  perform: (fn: () => Promise<unknown>) => Promise<void>;
  streaming: Record<string, string>;
  notice: string;
  notify: (message: string) => void;
  panelRequest: { id: PanelId; maximize: boolean } | null;
  showPanel: (id: PanelId, maximize?: boolean) => void;
  executionTarget: string | null;
  expandExecution: boolean;
  revealExecution: (
    execution: ExecutionSummary,
    options?: { expand?: boolean; activate?: boolean },
  ) => void;
  permissionTarget: { id: string } | null;
  revealPermission: (request: PermissionRequest) => void;
  artifactTarget: ArtifactTarget | null;
  plotViews: Record<Language, PlotView>;
  setPlotView: (language: Language, view: Partial<PlotView>) => void;
  tableFilter: { source: string; value: string } | null;
  setTableFilter: (filter: WorkbenchState["tableFilter"]) => void;
  revealArtifact: (
    execution: ExecutionSummary,
    output: OutputReference,
    panel: "plots" | "data",
  ) => void;
  tablePreview: TablePreview | null;
  previewTable: (name: string, focus?: boolean) => Promise<void>;
}

class WorkbenchStore {
  private listeners = new Set<() => void>();
  state: WorkbenchState;
  readonly documents: DocumentSync;
  private history: ConversationHistory;
  private project = "";
  private noticeTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    this.history = new ConversationHistory(
      (id, before) =>
        api<Page<Message>>(
          `/conversations/${encodeURIComponent(id)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`,
        ),
      (chat) => this.update({ chat }),
    );
    const set =
      <K extends keyof WorkbenchState>(key: K) =>
      (value: WorkbenchState[K]) =>
        this.update({ [key]: value } as Pick<WorkbenchState, K>);
    this.state = {
      snapshot: null,
      ready: false,
      connected: false,
      error: "",
      language: "python",
      file: "analysis.py",
      conversation: "",
      chat: this.history.state,
      loadMessages: () => this.history.load(),
      drafts: {},
      streaming: {},
      outputVersions: {},
      notice: "",
      panelRequest: null,
      executionTarget: null,
      expandExecution: false,
      permissionTarget: null,
      revealPermission: (request) => {
        const conversation =
          request.conversationId ??
          this.state.snapshot?.runs.find((run) => run.id === request.runId)?.conversationId;
        if (!conversation)
          return this.error(new Error("The conversation for this request could not be found."));
        if (conversation !== this.state.conversation) this.state.setConversation(conversation);
        this.update({
          permissionTarget: { id: request.id },
          panelRequest: { id: "chat", maximize: false },
        });
      },
      artifactTarget: null,
      plotViews: {
        python: { selectedSlot: null, dismissedTarget: null },
        r: { selectedSlot: null, dismissedTarget: null },
      },
      setPlotView: (language, view) =>
        this.update({
          plotViews: {
            ...this.state.plotViews,
            [language]: { ...this.state.plotViews[language], ...view },
          },
        }),
      tableFilter: null,
      setTableFilter: set("tableFilter"),
      tablePreview: null,
      setError: set("error"),
      setLanguage: set("language"),
      setFile: (file) => {
        this.update({ file });
        if (this.project) {
          try {
            localStorage.setItem(`biologue-active-file:${this.project}`, file);
          } catch {
            /* Document recovery storage reports persistence failures separately. */
          }
        }
      },
      setConversation: (conversation) => {
        this.update({ conversation });
        try {
          localStorage.setItem(`biologue-active-conversation:${this.project}`, conversation);
        } catch {
          /* Keep the current selection in memory. */
        }
        void this.history.select(conversation);
      },
      notify: (notice) => {
        clearTimeout(this.noticeTimer);
        this.update({ notice });
        this.noticeTimer = setTimeout(() => this.update({ notice: "" }), 5000);
      },
      showPanel: (id, maximize = false) => this.update({ panelRequest: { id, maximize } }),
      perform: async (fn) => {
        this.update({ error: "" });
        try {
          await fn();
        } catch (error) {
          this.error(error);
        }
      },
      draft: (doc, content) => this.documents.edit(doc, content),
      discardDraft: (path) => {
        try {
          this.documents.discard(path);
        } catch (error) {
          this.error(error);
        }
      },
      keepLocal: (path) => this.documents.keepLocal(path),
      flush: (doc) => this.documents.flush(doc.path),
      open: async (path) =>
        this.documents.receive(await api<Document>(`/documents?path=${encodeURIComponent(path)}`)),
      reconcile: async (doc, choice) => {
        const current = await this.documents.flush(doc.path);
        const saved = await api<Document>("/documents/reconcile", "POST", {
          path: doc.path,
          expectedVersion: current.version,
          expectedDiskHash: doc.diskConflict ? doc.diskConflict.hash : doc.diskHash,
          choice,
        });
        this.documents.receive(saved);
      },
      syncDocuments: async () => {
        for (const path of Object.keys(this.state.drafts)) await this.documents.flush(path);
      },
      loadExecutions: async () => {
        const current = this.state.snapshot;
        if (!current?.executionCursor) return;
        const page = await api<Page<ExecutionSummary>>(
          `/executions?before=${encodeURIComponent(current.executionCursor)}&limit=100`,
        );
        const latest = this.state.snapshot!;
        this.update({
          snapshot: {
            ...latest,
            executionCursor: page.next,
            executions: [
              ...page.items.filter((item) => !latest.executions.some((old) => old.id === item.id)),
              ...latest.executions,
            ],
          },
        });
      },
      revealExecution: (execution, { expand = true, activate = true } = {}) => {
        const current = this.state.snapshot!;
        const { code: _code, ...summary } = execution as Execution;
        this.update({
          language: execution.language,
          executionTarget: execution.id,
          expandExecution: expand,
          snapshot: current.executions.some((item) => item.id === execution.id)
            ? current
            : {
                ...current,
                executions: [...current.executions, summary].sort((a, b) =>
                  a.createdAt.localeCompare(b.createdAt),
                ),
              },
          ...(activate ? { panelRequest: { id: "console" as const, maximize: false } } : {}),
        });
      },
      revealArtifact: (execution, output, panel) =>
        this.update({
          language: execution.language,
          artifactTarget: {
            executionId: output.executionId,
            outputId: output.id,
            language: execution.language,
            panel,
          },
          ...(panel === "data" ? { tablePreview: null } : {}),
          panelRequest: { id: panel, maximize: false },
        }),
      previewTable: async (name, focus = true) => {
        const previous = this.state.tablePreview;
        const language = this.state.language;
        const execution = await api<Execution>("/table", "POST", { language, name });
        if (!this.state.snapshot!.executions.some((item) => item.id === execution.id))
          this.event({ type: "execution", execution });
        if (
          !focus &&
          (this.state.tablePreview !== previous ||
            this.state.language !== language ||
            this.state.artifactTarget)
        )
          return;
        this.update({
          tablePreview: { name, executionId: execution.id, language },
          artifactTarget: null,
          ...(focus ? { panelRequest: { id: "data" as const, maximize: false } } : {}),
        });
      },
    };
    this.documents = new DocumentSync({
      send: async (path, edit) => {
        try {
          return await api<Document>("/documents", "PUT", {
            path,
            content: edit.content,
            expectedVersion: edit.baseVersion,
            editId: edit.editId,
          });
        } catch (error) {
          if ((error as { status?: number }).status === 409) await this.state.open(path);
          throw error;
        }
      },
      changed: (documents, drafts) => {
        const snapshot = this.state.snapshot;
        this.update({
          drafts,
          ...(snapshot
            ? {
                snapshot: {
                  ...snapshot,
                  documents: documents.filter((doc) => !doc.savedAs || drafts[doc.path]),
                },
              }
            : {}),
        });
      },
      persist: (path, edit) => {
        if (!this.project) return;
        const key = `biologue-document:${this.project}:${path}`;
        try {
          if (edit) localStorage.setItem(key, JSON.stringify(edit));
          else localStorage.removeItem(key);
        } catch {
          this.error(
            new Error(
              "Local recovery storage is unavailable. Keep the workspace connected to retain edits.",
            ),
          );
        }
      },
      error: (error) => this.error(error),
    });
  }
  private error(error: unknown) {
    this.update({ error: error instanceof Error ? error.message : String(error) });
  }
  update(change: Partial<WorkbenchState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  connection(connected: boolean) {
    this.update({ connected });
    this.documents.connection(connected);
  }
  snapshot(snapshot: Snapshot) {
    let preferred = this.state.file;
    let preferredConversation = this.state.conversation;
    if (this.project !== snapshot.project) {
      try {
        const migrated = `biologue-storage:${snapshot.project}`;
        if (!localStorage.getItem(migrated)) {
          // Preserve drafts and selections from earlier application namespaces.
          for (const key of Object.keys(localStorage)) {
            const match = key.match(
              /^[\w-]+?-(active-file|active-conversation|document|drafts):(.*)$/,
            );
            if (!match || key.startsWith("biologue-")) continue;
            const [, kind, path] = match;
            if (
              kind === "document"
                ? !path.startsWith(`${snapshot.project}:`)
                : path !== snapshot.project
            )
              continue;
            const target = `biologue-${kind}:${path}`;
            if (localStorage.getItem(target) === null)
              localStorage.setItem(target, localStorage.getItem(key)!);
          }
          localStorage.setItem(migrated, "1");
        }
        preferred = localStorage.getItem(`biologue-active-file:${snapshot.project}`) ?? preferred;
        preferredConversation =
          localStorage.getItem(`biologue-active-conversation:${snapshot.project}`) ??
          preferredConversation;
      } catch {
        /* Use the default file. */
      }
    }
    this.update({
      snapshot,
      ready: true,
      conversation: snapshot.conversations.some((item) => item.id === preferredConversation)
        ? preferredConversation
        : snapshot.conversations.find((item) => !item.archived)?.id || "",
      streaming: {},
      file:
        snapshot.files.includes(preferred) ||
        snapshot.documents.some((doc) => doc.path === preferred)
          ? preferred
          : snapshot.files[0] || snapshot.documents[0]?.path || "",
    });
    void this.history.select(this.state.conversation, true);
    if (this.project !== snapshot.project) {
      this.project = snapshot.project;
      try {
        const legacy = JSON.parse(localStorage.getItem(`biologue-drafts:${this.project}`) || "{}");
        const restored: Record<string, PendingEdit> = {};
        const prefix = `biologue-document:${this.project}:`;
        for (const key of Object.keys(localStorage))
          if (key.startsWith(prefix))
            legacy[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key)!);
        for (const [path, value] of Object.entries(legacy)) {
          const edit = value as PendingEdit;
          if (typeof edit?.content === "string" && Number.isInteger(edit.baseVersion)) {
            restored[path] = { ...edit, editId: edit.editId || crypto.randomUUID() };
            localStorage.setItem(prefix + path, JSON.stringify(restored[path]));
          }
        }
        this.documents.restore(restored);
        localStorage.removeItem(`biologue-drafts:${this.project}`);
      } catch {
        this.error(
          new Error("Could not restore local edits. Saved working documents are still available."),
        );
      }
    }
    for (const document of snapshot.documents) this.documents.receive(document);
    this.documents.connection(this.state.connected);
    this.update({
      outputVersions: {
        ...this.state.outputVersions,
        python: (this.state.outputVersions.python || 0) + 1,
        r: (this.state.outputVersions.r || 0) + 1,
        epoch: (this.state.outputVersions.epoch || 0) + 1,
      },
    });
  }
  event(event: AppEvent) {
    if (event.type === "message") this.history.receive(event.message);
    if (event.type === "messages-reset" && event.conversationId === this.state.conversation)
      void this.history.select(event.conversationId, true);
    if (event.type === "permission-resolved" && event.error) this.error(new Error(event.error));
    if (event.type === "document") {
      if (
        event.document.savedAs &&
        this.state.file === event.document.path &&
        !this.state.drafts[event.document.path]
      )
        this.state.setFile(event.document.savedAs);
      if (this.state.snapshot) this.update({ snapshot: applyEvent(this.state.snapshot, event) });
      this.documents.receive(event.document);
      return;
    }
    if (event.type === "outputs") {
      const versions = this.state.outputVersions;
      this.update({
        outputVersions: {
          ...versions,
          [event.executionId]: (versions[event.executionId] || 0) + 1,
          [event.language]: (versions[event.language] || 0) + 1,
        },
      });
      return;
    }
    const change: Partial<WorkbenchState> = {};
    if (event.type === "agent-delta")
      change.streaming = {
        ...this.state.streaming,
        [event.runId]: (this.state.streaming[event.runId] || "") + event.delta,
      };
    if (event.type === "message" && event.message.role === "assistant" && event.message.runId)
      change.streaming = { ...this.state.streaming, [event.message.runId]: "" };
    if (event.type === "agent-run" && event.run.status !== "running")
      change.streaming = { ...this.state.streaming, [event.run.id]: "" };
    if (this.state.snapshot) change.snapshot = applyEvent(this.state.snapshot, event);
    this.update(change);
  }
  disconnect() {
    this.connection(false);
    clearTimeout(this.noticeTimer);
  }
}
const State = createContext<WorkbenchStore | null>(null);
const shallowEqual = (a: unknown, b: unknown) =>
  Object.is(a, b) ||
  (!!a &&
    !!b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    ));
export function useSelect<T>(selector: (state: WorkbenchState) => T): T {
  const store = useContext(State)!;
  const cache = useRef<{ value: T }>(undefined);
  return useSyncExternalStore(store.subscribe, () => {
    const value = selector(store.state);
    if (!cache.current || !shallowEqual(cache.current.value, value)) cache.current = { value };
    return cache.current.value;
  });
}
export function useWorkbench<K extends keyof WorkbenchState>(
  ...keys: [K, ...K[]]
): Pick<WorkbenchState, K> {
  return useSelect(
    (state) => Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<WorkbenchState, K>,
  );
}
export function useSnapshot<K extends keyof Snapshot>(...keys: [K, ...K[]]): Pick<Snapshot, K> {
  return useSelect(
    (state) =>
      Object.fromEntries(keys.map((key) => [key, state.snapshot?.[key]])) as Pick<Snapshot, K>,
  );
}
export function useOutputVersion(key: string) {
  return useSelect(
    (state) => `${state.outputVersions.epoch || 0}:${state.outputVersions[key] || 0}`,
  );
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkbenchStore());
  useEffect(() => {
    let source: EventSource,
      retry: ReturnType<typeof setTimeout>,
      disposed = false;
    function connect() {
      if (disposed) return;
      source = new EventSource(`${base}/api/events`);
      source.onopen = () => {}; // Reconcile the reconnect snapshot before resuming edits.
      source.onerror = () => {
        store.connection(false);
        if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 1500);
      };
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as
          AppEvent | { type: "snapshot"; snapshot: Snapshot };
        if (event.type === "snapshot") {
          store.snapshot(event.snapshot);
          store.connection(true);
        } else store.event(event);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      source.close();
      store.disconnect();
    };
  }, [store]);
  return <State.Provider value={store}>{children}</State.Provider>;
}

/** Refresh at most every 100ms while streaming, with one request in flight per view. */
export function useResource<T>(path: string | null, revision: string | number = 0) {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error?: string;
    loading: boolean;
  }>({
    path: null,
    loading: false,
  });
  const refresh = useRef<() => void>(() => {});
  const observedRevision = useRef(revision);
  useEffect(() => {
    observedRevision.current = revision;
    if (!path) return;
    let cancelled = false,
      running = false,
      dirty = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      timer = undefined;
      if (running || cancelled || !dirty) return;
      running = true;
      dirty = false;
      setState((current) => ({
        path,
        data: current.path === path ? current.data : undefined,
        loading: true,
      }));
      try {
        const data = await api<T>(path);
        if (!cancelled) setState({ path, data, loading: false });
      } catch (error) {
        if (!cancelled)
          setState({
            path,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          });
      } finally {
        running = false;
        if (dirty && !cancelled) timer = setTimeout(() => void run(), 100);
      }
    };
    refresh.current = () => {
      dirty = true;
      if (!running && !timer) timer = setTimeout(() => void run(), 100);
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      refresh.current = () => {};
    };
  }, [path]);
  useEffect(() => {
    if (observedRevision.current !== revision) {
      observedRevision.current = revision;
      refresh.current();
    }
  }, [revision]);
  return {
    ...(state.path === path ? state : { path, loading: !!path }),
    retry: () => refresh.current(),
  };
}
