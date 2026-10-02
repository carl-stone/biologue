import { OutputService } from "../../src/outputs.ts";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentRun, AppEvent, Conversation, PermissionRequest } from "@biologue/protocol";
import { Store } from "../../src/store.ts";
import { Events } from "../../src/events.ts";
import { Documents } from "../../src/documents.ts";
import { ContextService } from "../../src/context.ts";
import { ConversationSessions } from "../../src/conversation-sessions.ts";
import { ExecutionService, type KernelBackend } from "../../src/execution.ts";
import { Permissions } from "../../src/permissions.ts";
import { PiAdapter } from "../../src/pi.ts";
import { Supervisor } from "../../src/supervisor.ts";
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
export const collaboratorPrompt = readFileSync(
  new URL("../../../../prompts/collaborator.md", import.meta.url),
  "utf8",
);

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function scriptedModel(settings: Settings = {}) {
  const faux = fauxProvider({
    tokensPerSecond: 1_000_000,
    models: [
      { id: "scientist-test", input: ["text", "image"], contextWindow: 100_000, maxTokens: 4096 },
    ],
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const requests: Context[] = [];
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    requests.push(structuredClone(context));
    return stream(model, context, options);
  };
  return {
    faux,
    requests,
    options: {
      modelRuntime: runtime,
      provider: faux.getModel().provider,
      modelId: faux.getModel().id,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        ...settings,
      }),
    },
  };
}

export async function fixture(
  options: {
    root?: string;
    kernel?: KernelBackend;
    settings?: Settings;
    cancellationTimeoutMs?: number;
    model?: Awaited<ReturnType<typeof scriptedModel>>;
    beforeInitialize?: (pi: PiAdapter, store: Store, context: ContextService) => void;
  } = {},
) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "biologue-session-"));
  if (!existsSync(join(root, "analysis.py"))) writeFileSync(join(root, "analysis.py"), "x = 1");
  const stateDir = join(root, ".biologue");
  const store = new Store(join(stateDir, "biologue.sqlite"));
  const events = new Events();
  const context = new ContextService(store, events);
  const documents = new Documents(root, store, events);
  const calls: string[] = [];
  const kernel: KernelBackend = options.kernel ?? {
    execute: async (_language, code, output, started) => {
      started({ sessionId: "shared", kernelId: "kernel" });
      calls.push(code);
      output({ kind: "stream", text: "actual test output" });
    },
    interrupt: async () => {},
  };
  const execution = new ExecutionService(
    store,
    events,
    kernel,
    new OutputService(store, events, join(stateDir, "artifacts")),
    options.cancellationTimeoutMs,
  );
  const permissions = new Permissions(store, events);
  const sessions = new ConversationSessions(store, events);
  const model = options.model ?? (await scriptedModel(options.settings));
  const pi = new PiAdapter({ project: root, stateDir, ...model.options });
  // Title generation has its own tests; do not consume scripted agent responses.
  pi.conversationTitle = async () => "";
  const supervisor = new Supervisor(
    store,
    events,
    context,
    documents,
    execution,
    permissions,
    pi,
    collaboratorPrompt,
    sessions,
  );
  options.beforeInitialize?.(pi, store, context);
  await supervisor.initialize();
  const conversationId = store.list<Conversation>("conversation")[0].id;
  const observed: AppEvent[] = [];
  events.subscribe((event) => observed.push(event));
  const finished = () =>
    new Promise<AgentRun>((resolve) => {
      const unsubscribe = events.subscribe((event) => {
        if (event.type === "agent-run" && event.run.finishedAt) {
          unsubscribe();
          resolve(event.run);
        }
      });
    });
  const requested = () =>
    new Promise<PermissionRequest>((resolve, reject) => {
      const unsubscribe = events.subscribe((event) => {
        if (event.type === "permission") {
          unsubscribe();
          resolve(event.request);
        }
        if (event.type === "agent-run" && event.run.finishedAt) {
          unsubscribe();
          reject(new Error(event.run.error ?? "Run finished without requesting permission."));
        }
      });
    });
  return {
    root,
    stateDir,
    store,
    events,
    observed,
    context,
    documents,
    calls,
    execution,
    permissions,
    sessions,
    pi,
    supervisor,
    conversationId,
    finished,
    requested,
    ...model,
    run: (text: string) => {
      const done = finished();
      supervisor.start(conversationId, text);
      return done;
    },
    close: async (remove = true) => {
      await supervisor.close();
      await execution.close();
      documents.close();
      store.close();
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}
