import { randomUUID } from "node:crypto";
import type { AgentProvider, AuthFlow } from "@biologue/protocol";
import type { PiAdapter } from "./pi.ts";
import { Conflict } from "./documents.ts";

/** Pi owns credential storage, rotation, and provider-specific login. Only UI challenges leave here. */
export class ProviderAuth {
  private flows = new Map<
    string,
    {
      view: AuthFlow;
      abort: AbortController;
      answer?: (value: string) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  constructor(private pi: PiAdapter) {}
  async providers(): Promise<AgentProvider[]> {
    const runtime = await this.pi.modelRuntime();
    await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(10_000) });
    return runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: runtime.hasConfiguredAuth(provider.id),
      methods: [
        ...(provider.auth.oauth
          ? [
              {
                type: "oauth" as const,
                label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
              },
            ]
          : []),
        ...(provider.auth.apiKey?.login
          ? [{ type: "api_key" as const, label: provider.auth.apiKey.name }]
          : []),
      ],
    }));
  }
  async start(provider: string, type: "api_key" | "oauth") {
    const runtime = await this.pi.modelRuntime();
    const info = runtime.getProvider(provider);
    if (!info || !(type === "oauth" ? info.auth.oauth : info.auth.apiKey?.login))
      throw Object.assign(new Error("This sign-in method is unavailable."), { statusCode: 400 });
    if ([...this.flows.values()].some((flow) => flow.view.status === "pending"))
      throw new Conflict("Finish or cancel the current sign-in first.");
    // Bound completed challenges; they contain no credentials.
    for (const [id, flow] of this.flows) if (flow.view.status !== "pending") this.flows.delete(id);
    const id = randomUUID(),
      abort = new AbortController();
    const view: AuthFlow = { id, provider, status: "pending" };
    const flow = {
      view,
      abort,
      timeout: setTimeout(() => this.cancel(id), 15 * 60_000),
      answer: undefined as ((value: string) => void) | undefined,
    };
    this.flows.set(id, flow);
    this.pi.diagnostics?.record({
      component: "provider",
      event: "login.started",
      data: { id, provider, type },
    });
    void runtime
      .login(provider, type, {
        signal: abort.signal,
        notify: (event) => {
          if (view.status !== "pending") return;
          if (event.type === "auth_url") {
            view.url = event.url;
            view.message = event.instructions;
          } else if (event.type === "device_code") {
            view.url = event.verificationUri;
            view.code = event.userCode;
          } else view.message = event.message;
        },
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            if (abort.signal.aborted || prompt.signal?.aborted)
              return reject(new Error("Sign-in cancelled."));
            const promptId = randomUUID();
            const cleanup = () => {
              abort.signal.removeEventListener("abort", cancel);
              prompt.signal?.removeEventListener("abort", cancel);
              if (view.prompt?.id === promptId) {
                delete view.prompt;
                flow.answer = undefined;
              }
            };
            const cancel = () => {
              cleanup();
              reject(new Error("Sign-in cancelled."));
            };
            view.prompt = {
              id: promptId,
              type: prompt.type,
              message: prompt.message,
              ...("placeholder" in prompt ? { placeholder: prompt.placeholder } : {}),
              ...("options" in prompt
                ? { options: prompt.options.map(({ id, label }) => ({ id, label })) }
                : {}),
            };
            flow.answer = (value) => {
              cleanup();
              resolve(value);
            };
            abort.signal.addEventListener("abort", cancel, { once: true });
            prompt.signal?.addEventListener("abort", cancel, { once: true });
          }),
      })
      .then(() => {
        if (view.status === "pending") {
          view.status = "complete";
          view.message = "Connected";
          this.pi.diagnostics?.record({
            component: "provider",
            event: "login.finished",
            data: { id, provider, type },
          });
        }
      })
      .catch((error) => {
        this.pi.diagnostics?.record({
          component: "provider",
          event: "login.failed",
          level: "warning",
          error,
          data: { id, provider, type, cancelled: abort.signal.aborted },
        });
        if (view.status === "pending") {
          view.status = "failed";
          view.message = "Sign-in failed. Check the provider details and try again.";
        }
      })
      .finally(() => {
        clearTimeout(flow.timeout);
        delete view.prompt;
        delete view.url;
        delete view.code;
        flow.answer = undefined;
      });
    return view;
  }
  get(id: string) {
    const flow = this.flows.get(id);
    if (!flow) throw Object.assign(new Error("Sign-in expired."), { statusCode: 404 });
    return flow.view;
  }
  current() {
    return [...this.flows.values()].find((flow) => flow.view.status === "pending")?.view ?? null;
  }
  respond(id: string, promptId: string, value: string) {
    const flow = this.flows.get(id);
    if (!flow?.answer || flow.view.status !== "pending" || flow.view.prompt?.id !== promptId)
      throw new Conflict("This sign-in step is no longer waiting.");
    if (
      flow.view.prompt.type === "select" &&
      !flow.view.prompt.options?.some((option) => option.id === value)
    )
      throw Object.assign(new Error("Choose one of the sign-in options."), { statusCode: 400 });
    // Never interpret API-key input as Pi's optional !command credential syntax.
    if (flow.view.prompt.type === "secret" && value.trim().startsWith("!"))
      throw Object.assign(new Error("Enter the credential itself, not a shell command."), {
        statusCode: 400,
      });
    flow.answer(value);
    return { ok: true };
  }
  cancel(id: string) {
    const flow = this.flows.get(id);
    if (flow?.view.status === "pending") {
      flow.view.status = "cancelled";
      flow.abort.abort();
      clearTimeout(flow.timeout);
    }
    return { ok: true };
  }
  async logout(provider: string) {
    await (await this.pi.modelRuntime()).logout(provider);
    return { ok: true };
  }
  close() {
    for (const id of this.flows.keys()) this.cancel(id);
  }
}
