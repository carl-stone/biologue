import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion, AgentRun } from "@biologue/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";
import { Conflict } from "./documents.ts";

/** Browser implementation of Pi's standard extension dialog protocol. */
export class ExtensionDialogs {
  private pending = new Map<
    string,
    { question: AgentQuestion; finish: (answer?: string) => void }
  >();
  constructor(
    private store: Store,
    private events: Events,
  ) {}
  list() {
    return [...this.pending.values()].map((item) => item.question);
  }
  answer(id: string, answer?: string) {
    const item = this.pending.get(id);
    if (!item) throw new Conflict("This question is no longer waiting.");
    if (answer !== undefined && item.question.options && !item.question.options.includes(answer))
      throw Object.assign(new Error("Choose an available answer."), { statusCode: 400 });
    this.store.put("question-answer", id, {
      ...item.question,
      answer,
      answeredAt: new Date().toISOString(),
    });
    item.finish(answer);
    return { ok: true };
  }
  cancelRun(runId: string) {
    for (const item of this.pending.values()) if (item.question.runId === runId) item.finish();
  }
  context(run: AgentRun): ExtensionUIContext {
    const ask = (
      kind: AgentQuestion["kind"],
      title: string,
      options?: string[],
      placeholder?: string,
      opts?: ExtensionUIDialogOptions,
    ) =>
      new Promise<string | undefined>((resolve) => {
        if (opts?.signal?.aborted) return resolve(undefined);
        const question = {
          id: randomUUID(),
          runId: run.id,
          conversationId: run.conversationId,
          kind,
          title,
          options,
          placeholder,
        };
        let timer: NodeJS.Timeout | undefined;
        const cancel = () => finish();
        const finish = (answer?: string) => {
          if (!this.pending.delete(question.id)) return;
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", cancel);
          this.events.emit({ type: "question-resolved", id: question.id });
          resolve(answer);
        };
        this.pending.set(question.id, { question, finish });
        opts?.signal?.addEventListener("abort", cancel, { once: true });
        if (opts?.timeout) timer = setTimeout(cancel, opts.timeout);
        this.events.emit({ type: "question", question });
      });
    const noop = () => {};
    return {
      select: (title, options, opts) => ask("select", title, options, undefined, opts),
      input: (title, placeholder, opts) => ask("input", title, undefined, placeholder, opts),
      confirm: async (title, message, opts) =>
        (await ask("confirm", `${title}\n${message}`, ["Yes", "No"], undefined, opts)) === "Yes",
      editor: (title, prefill) => ask("input", title, undefined, prefill),
      // Pi's documented RPC fallback: rich terminal components are not rendered in a browser.
      custom: async () => undefined,
      notify: (text: string, level: "info" | "warning" | "error" = "info") => {
        run.notices = [...(run.notices ?? []), { text, level }].slice(-20);
        this.store.put("run", run.id, run);
        this.events.emit({ type: "agent-run", run: { ...run } });
      },
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => "",
      addAutocompleteProvider: noop,
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: "Terminal themes are not supported in the browser.",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: noop,
      // Browser dialogs use CSS. Keep Pi's formatting helpers plain-text so native
      // extensions can format status messages without leaking terminal escapes.
      theme: {
        name: "browser",
        appearance: "light",
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        style: (text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        inverse: (text: string) => text,
        strikethrough: (text: string) => text,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        colors: {},
      } as unknown as ExtensionUIContext["theme"],
    } as ExtensionUIContext;
  }
}
