import type { Page } from "@playwright/test";
import type {
  AppEvent,
  Snapshot,
  Execution,
  Output,
  DisplayOutput,
  Message,
} from "../packages/protocol/src/index.ts";

// These fixtures exercise UI states only. The separate workspace workflow uses
// the real server and kernel; these responses are not scientific evaluations.
export const initialSnapshot: Snapshot = {
  project: "/test/synthetic-workspace",
  files: ["analysis.py", "analysis.R"],
  documents: [
    {
      path: "analysis.py",
      content: "# Synthetic example\nprint('hello')\n",
      version: 1,
      savedVersion: 1,
      diskHash: "test",
    },
    {
      path: "analysis.R",
      content: "# Synthetic example\nprint('R')\n",
      version: 1,
      savedVersion: 1,
      diskHash: "test-r",
    },
  ],
  executions: [],
  conversations: [
    { id: "conversation-1", title: "First investigation", createdAt: "2026-09-26T09:00:00Z" },
    { id: "conversation-2", title: "Second investigation", createdAt: "2026-09-26T10:00:00Z" },
  ],
  researchContext: { text: "", version: 0, updatedAt: "2026-09-26T09:00:00Z" },
  runs: [],
  permissions: [],
  permissionHistory: [],
  sessions: [],
  agent: { enabled: false },
};

declare global {
  interface Window {
    carlTestEmit: (event: AppEvent | { type: "snapshot"; snapshot: Snapshot }) => void;
    carlTestConnect: (connected: boolean) => void;
  }
}
type Request = { path: string; method: string; body: any; query: URLSearchParams };
type Response = { status?: number; body: unknown };

export async function fixture(
  page: Page,
  overrides: Partial<Snapshot> & { messages?: Message[] } = {},
) {
  const { messages = [], ...snapshotOverrides } = overrides;
  let history = structuredClone(messages);
  const state = structuredClone({ ...initialSnapshot, ...snapshotOverrides });
  const permissionRecords = new Map(
    [...state.permissions, ...(state.permissionHistory ?? [])].map((request) => [
      request.id,
      request,
    ]),
  );
  const originals = state.executions as (Execution & { outputs?: Output[] })[];
  const rawOutputs = originals.flatMap((item) => item.outputs ?? []);
  state.executions = originals.map(({ code: _code, outputs: _outputs, ...summary }) => summary);
  const requests: Request[] = [];
  let handler: (request: Request) => Promise<Response | undefined> = async () => undefined;
  await page.addInitScript((snapshot) => {
    const sources = new Set<FakeEventSource>();
    class FakeEventSource {
      static CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        sources.add(this);
        queueMicrotask(async () => {
          const snapshot = await fetch("/api/snapshot").then((response) => response.json());
          if (this.readyState === 2) return;
          this.onopen?.(new Event("open"));
          this.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", snapshot }) }),
          );
        });
      }
      close() {
        this.readyState = 2;
        sources.delete(this);
      }
    }
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
    window.carlTestEmit = (event) =>
      sources.forEach((source) =>
        source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) })),
      );
    window.carlTestConnect = (connected) =>
      sources.forEach((source) => {
        source.readyState = connected ? 1 : 0;
        if (connected) {
          source.onopen?.(new Event("open"));
          void fetch("/api/snapshot")
            .then((response) => response.json())
            .then((snapshot) =>
              source.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify({ type: "snapshot", snapshot }),
                }),
              ),
            );
        } else source.onerror?.(new Event("error"));
      });
  }, state);
  const emit = async (event: AppEvent) => {
    if (event.type === "permission") {
      state.permissions = [
        ...state.permissions.filter((item) => item.id !== event.request.id),
        event.request,
      ];
      permissionRecords.set(event.request.id, event.request);
    }
    if (event.type === "permission-resolved") {
      state.permissions = state.permissions.filter((item) => item.id !== event.id);
      if (event.resolution) {
        state.permissionHistory = [
          ...(state.permissionHistory ?? []).filter((item) => item.id !== event.id),
          event.resolution,
        ];
        permissionRecords.set(event.id, {
          ...permissionRecords.get(event.id)!,
          ...event.resolution,
        });
      }
    }
    if (event.type === "message")
      history = [...history.filter((item) => item.id !== event.message.id), event.message];
    if (event.type === "document")
      state.documents = state.documents.map((doc) =>
        doc.path === event.document.path ? event.document : doc,
      );
    if (event.type === "execution")
      state.executions = [
        ...state.executions.filter((item) => item.id !== event.execution.id),
        event.execution,
      ];
    try {
      await page.evaluate((value) => window.carlTestEmit(value), event);
    } catch (error) {
      // A server update can finish while the client reloads. Its state above is
      // durable in the fixture; the new page receives it in its next snapshot.
      if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed"))
        throw error;
    }
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const request = {
      path: url.pathname.replace(/^\/api/, ""),
      method: req.method(),
      body: req.postDataJSON(),
      query: url.searchParams,
    };
    requests.push(request);
    const custom = await handler(request);
    if (custom) {
      await route.fulfill({ status: custom.status || 200, json: custom.body });
      return;
    }
    let result: unknown = { ok: true };
    if (request.path === "/snapshot")
      result = { ...state, documents: state.documents.filter((doc) => !doc.savedAs) };
    else if (request.path === "/agent/models")
      result = [
        {
          id: "gpt-6-luna",
          name: "gpt-6-luna",
          provider: "openai-codex",
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "gpt-6-astra",
          name: "gpt-6-astra",
          provider: "openai-codex",
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ];
    else if (/^\/conversations\/[^/]+\/settings$/.test(request.path)) {
      const conversation = state.conversations.find(
        (item) => item.id === request.path.split("/")[2],
      )!;
      conversation.settings = request.body;
      result = conversation;
      await emit({ type: "conversation", conversation });
    } else if (request.path === "/agent/settings") {
      state.agent = { enabled: true, ...request.body };
      result = state.agent;
      await emit({ type: "agent-settings", agent: state.agent });
    } else if (request.path.startsWith("/permissions/") && request.method === "GET")
      result = permissionRecords.get(request.path.split("/")[2]);
    else if (/^\/conversations\/[^/]+\/messages$/.test(request.path)) {
      const id = request.path.split("/")[2];
      const before = url.searchParams.get("before");
      const matching = history.filter((message) => message.conversationId === id);
      const end = before ? matching.findIndex((message) => message.id === before) : matching.length;
      const start = Math.max(0, end - Number(url.searchParams.get("limit") || 50));
      result = {
        items: matching.slice(start, end),
        ...(start ? { next: matching[start].id } : {}),
      };
    } else if (request.path === "/outputs") {
      const executionId = url.searchParams.get("executionId"),
        language = url.searchParams.get("language"),
        kind = url.searchParams.get("kind");
      result = {
        items: rawOutputs
          .filter(
            (output) =>
              (!executionId || output.executionId === executionId) &&
              (!language ||
                originals.find((item) => item.id === output.executionId)?.language === language) &&
              (!kind ||
                (kind === "plots" && output.data?.["image/png"]) ||
                (kind === "tables" && output.data?.["application/json"])),
          )
          .map((output): DisplayOutput => ({
            id: output.id,
            executionId: output.executionId,
            sequence: output.sequence,
            kind: output.kind,
            mimeTypes: Object.keys(output.data ?? {}),
            preview: output.text ?? "",
            truncated: false,
            table: !!output.data?.["application/json"],
            slotId: output.id,
            ownerExecutionId: output.executionId,
          })),
      };
    } else if (/^\/outputs\/[^/]+\/reference$/.test(request.path)) {
      const output = rawOutputs.find((item) => item.id === request.path.split("/")[2])!;
      result = {
        id: output.id,
        executionId: output.executionId,
        sequence: output.sequence,
        kind: output.kind,
        mimeTypes: Object.keys(output.data ?? {}),
        preview: output.text ?? "",
        truncated: false,
        table: !!output.data?.["application/json"],
      };
    } else if (/^\/outputs\/[^/]+\/png$/.test(request.path)) {
      const output = rawOutputs.find((output) => output.id === request.path.split("/")[2]);
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from((output?.data?.["image/png"] as string) ?? "", "base64"),
      });
      return;
    } else if (/^\/executions\/[^/]+$/.test(request.path))
      result = originals.find((item) => item.id === request.path.split("/")[2]);
    else if (request.path.endsWith("/result")) result = null;
    else if (request.path === "/documents" && request.method === "PUT") {
      const previous = state.documents.find((doc) => doc.path === request.body.path)!;
      if (previous.version !== request.body.expectedVersion) {
        await route.fulfill({ status: 409, json: { error: "The document changed." } });
        return;
      }
      const document = {
        ...previous,
        content: request.body.content,
        version: previous.version + 1,
        editId: request.body.editId,
      };
      await emit({ type: "document", document });
      result = document;
    } else if (request.path === "/documents/untitled") {
      const document = {
        path: `untitled:test-${state.documents.length}/Untitled-${state.documents.length + 1}.${request.body.language === "r" ? "R" : "py"}`,
        content: "",
        version: 1,
        savedVersion: 0,
        diskHash: "",
        untitled: true,
      };
      state.documents.push(document);
      await emit({ type: "document", document });
      result = document;
    } else if (request.path === "/documents/save-as") {
      const old = state.documents.find((doc) => doc.path === request.body.path)!;
      const document = {
        path: request.body.target,
        content: old.content,
        version: 1,
        savedVersion: 1,
        diskHash: "saved",
      };
      old.savedAs = document.path;
      await emit({ type: "document", document: old });
      state.documents.push(document);
      state.files.push(document.path);
      await emit({ type: "document", document });
      result = document;
    } else if (request.path === "/documents/save") {
      const document = state.documents.find((doc) => doc.path === request.body.path)!;
      document.savedVersion = document.version;
      await emit({ type: "document", document });
      result = document;
    } else if (request.path === "/documents" && request.method === "GET")
      result = state.documents.find((doc) => doc.path === url.searchParams.get("path"));
    else if (request.path === "/context") {
      state.researchContext = {
        text: request.body.text,
        version: state.researchContext.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await emit({ type: "context", context: state.researchContext });
      result = state.researchContext;
    } else if (request.path.startsWith("/conversations/") && request.method === "PATCH") {
      const conversation = state.conversations.find(
        (item) => item.id === request.path.split("/")[2],
      )!;
      Object.assign(conversation, request.body);
      if (request.body.title) conversation.titleMode = "manual";
      await emit({ type: "conversation", conversation });
      result = conversation;
    } else if (request.path === "/conversations") {
      const conversation = {
        id: `conversation-${state.conversations.length + 1}`,
        title: request.body.title || "New conversation",
        createdAt: new Date().toISOString(),
      };
      state.conversations.push(conversation);
      await emit({ type: "conversation", conversation });
      result = conversation;
    }
    await route.fulfill({ json: result });
  });
  return {
    state,
    requests,
    emit,
    handle: (next: typeof handler) => {
      handler = next;
    },
    connect: (connected: boolean) =>
      page.evaluate((value) => window.carlTestConnect(value), connected),
  };
}
