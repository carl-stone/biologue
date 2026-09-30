import {
  KernelManager,
  SessionManager,
  ServerConnection,
  KernelMessage,
  type Session,
} from "@jupyterlab/services";
import WebSocket from "ws";
import { relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Language, SessionInfo } from "@carl/protocol";
import { adapters } from "./adapters.ts";
import { digest } from "./documents.ts";
import type { KernelBackend, KernelOutput } from "./execution.ts";

export class JupyterKernels implements KernelBackend {
  private kernelManager?: KernelManager;
  private sessionManager?: SessionManager;
  private connections = new Map<Language, Session.ISessionConnection>();
  private pending = new Map<Language, Promise<Session.ISessionConnection>>();
  private generations = new Map<Language, string>();
  private inflight = new Map<Language, () => void>();
  private settings: ServerConnection.ISettings;
  constructor(
    private project: string,
    private baseUrl: string,
    token: string,
    private root = project,
  ) {
    this.settings = ServerConnection.makeSettings({
      baseUrl,
      wsUrl: baseUrl.replace(/^http/, "ws"),
      token,
      appendToken: true,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    });
  }
  sessions(): SessionInfo[] {
    return [...this.connections].map(([language, session]) => ({
      language,
      sessionId: session.id,
      kernelId: session.kernel!.id,
      status: session.kernel!.status,
    }));
  }
  private async ensure(language: Language): Promise<Session.ISessionConnection> {
    const connected = this.connections.get(language);
    if (connected && !connected.isDisposed && connected.kernel?.status !== "dead") return connected;
    const pending = this.pending.get(language);
    if (pending) return pending;
    const promise = this.connect(language);
    this.pending.set(language, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(language);
    }
  }
  private async connect(language: Language) {
    try {
      const response = await fetch(
        new URL("api/status", this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/"),
        {
          headers: { Authorization: `token ${this.settings.token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      throw new Error(
        "Cannot reach Jupyter. Start the managed runtime with npm run dev, or check JUPYTER_URL and JUPYTER_TOKEN.",
      );
    }
    if (!this.sessionManager) {
      this.kernelManager = new KernelManager({ serverSettings: this.settings, standby: "never" });
      this.sessionManager = new SessionManager({
        serverSettings: this.settings,
        kernelManager: this.kernelManager,
        standby: "never",
      });
    }
    const manager = this.sessionManager;
    await manager.refreshRunning();
    const directory = relative(this.root, this.project);
    const path = `${directory ? directory + "/" : ""}carl-${digest(this.project).slice(0, 12)}-${language}.ipynb`;
    const existing = [...manager.running()].find(
      (session) => session.path === path && session.kernel?.name === adapters[language].kernelName,
    );
    const session = existing
      ? manager.connectTo({ model: existing })
      : await manager.startNew({
          path,
          name: `Carl ${language}`,
          type: "notebook",
          kernel: { name: adapters[language].kernelName },
        });
    if (!session.kernel) throw new Error("Jupyter created a session without a kernel.");
    await session.kernel.info;
    this.generations.set(language, randomUUID());
    session.kernel.statusChanged.connect((_kernel, status) => {
      // Jupyter may reuse kernel.id on restart. A transport gap is also uncertain:
      // another client could have executed while this application was disconnected.
      if (["starting", "restarting", "autorestarting", "dead"].includes(status))
        this.generations.set(language, randomUUID());
    });
    session.kernel.connectionStatusChanged.connect((_kernel, status) => {
      if (status === "disconnected") this.generations.set(language, randomUUID());
    });
    this.connections.set(language, session);
    return session;
  }
  async execute(
    language: Language,
    code: string,
    output: (value: KernelOutput) => void,
    started: Parameters<KernelBackend["execute"]>[3],
    signal: AbortSignal,
  ) {
    const session = await this.ensure(language);
    if (signal.aborted) throw new Error("Cancelled before code was sent to the kernel.");
    const kernel = session.kernel!;
    // A restart performed by another client may retain kernel.id and precede its
    // status notification. Ask the live process for its sender-session identity
    // before the preflight callback; kernel_info_request does not execute code.
    const info = await kernel.requestKernelInfo();
    if (!info || info.content.status !== "ok")
      throw new Error("Cannot establish the current kernel identity.");
    if (signal.aborted) throw new Error("Cancelled before code was sent to the kernel.");
    started({
      sessionId: session.id,
      kernelId: kernel.id,
      kernelGeneration: digest(`${this.generations.get(language)}:${info.header.session}`),
    });
    const future = kernel.requestExecute({
      code,
      silent: false,
      store_history: true,
      allow_stdin: false,
      stop_on_error: false,
    });
    // Observe the original IOPub message. Futures reroute display updates to the
    // old request and drop them once that future is disposed; ownership here is
    // always the request that actually produced this output.
    const onIOPub = (_sender: unknown, message: KernelMessage.IIOPubMessage) => {
      if (message.parent_header.msg_id !== future.msg.header.msg_id) return;
      if (KernelMessage.isStreamMsg(message))
        output({
          kind: "stream",
          text: message.content.text,
          metadata: { name: message.content.name },
        });
      else if (KernelMessage.isErrorMsg(message))
        output({
          kind: "error",
          text:
            message.content.traceback.join("\n") ||
            `${message.content.ename}: ${message.content.evalue}`,
        });
      else if (
        KernelMessage.isDisplayDataMsg(message) ||
        KernelMessage.isExecuteResultMsg(message) ||
        KernelMessage.isUpdateDisplayDataMsg(message)
      ) {
        const content = message.content;
        output({
          kind:
            message.header.msg_type === "execute_result"
              ? "result"
              : message.header.msg_type === "update_display_data"
                ? "update"
                : "display",
          data: content.data as Record<string, unknown>,
          metadata: content.metadata as Record<string, unknown>,
          displayId:
            "transient" in content
              ? (content.transient?.display_id as string | undefined)
              : undefined,
        });
      } else if (KernelMessage.isClearOutputMsg(message))
        output({ kind: "clear", wait: message.content.wait });
    };
    kernel.iopubMessage.connect(onIOPub);
    const detach = () => {
      kernel.iopubMessage.disconnect(onIOPub);
      future.dispose();
      if (this.inflight.get(language) === detach) this.inflight.delete(language);
    };
    this.inflight.set(language, detach);
    try {
      const reply = await future.done;
      if (reply.content.status === "error")
        throw new Error(`${reply.content.ename}: ${reply.content.evalue}`);
      if (reply.content.status === "abort") throw new Error("Kernel aborted the execution.");
    } finally {
      detach();
    }
  }
  async interrupt(language: Language) {
    await this.connections.get(language)?.kernel?.interrupt();
  }
  async reconcile(language: Language, signal: AbortSignal) {
    const session = await this.ensure(language);
    const kernel = session.kernel!;
    if (signal.aborted || kernel.connectionStatus !== "connected" || kernel.status !== "idle")
      return false;
    const info = await kernel.requestKernelInfo();
    return (
      !signal.aborted &&
      info?.content.status === "ok" &&
      kernel.connectionStatus === "connected" &&
      kernel.status === "idle"
    );
  }
  abandon(language: Language) {
    this.inflight.get(language)?.();
  }
  dispose() {
    for (const detach of [...this.inflight.values()]) detach();
    for (const connection of this.connections.values()) connection.dispose();
    this.connections.clear();
    this.sessionManager?.dispose();
    this.kernelManager?.dispose();
  }
}
