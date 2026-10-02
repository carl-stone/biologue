import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { AgentRun, Conversation } from "@biologue/protocol";
import { fixture } from "./pi-fixture.ts";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const [root, scenario] = process.argv.slice(2);
const send = (extra: object) =>
  process.send?.({
    ...extra,
    run: f.store.list<AgentRun>("run").find((r) => r.status === "running"),
  });
const f = await fixture({
  root,
  kernel: {
    execute: async (_language, code, _output, started) => {
      started({ sessionId: "crash-test", kernelId: "kernel-before-crash" });
      appendFileSync(join(root, "external-effects.txt"), code + "\n");
      await f.supervisor.steer(
        f.store.list<AgentRun>("run")[0].id,
        "Correction: the independent unit is the donor.",
      );
      f.context.update("Corrected unit: donor, not culture well.", 0);
      send({ kind: "executing" });
      await new Promise(() => {});
    },
    interrupt: async () => {},
  },
});
const conversation = f.store.get<Conversation>("conversation", f.conversationId)!;
f.store.put("conversation", conversation.id, {
  ...conversation,
  settings: {
    provider: f.options.provider,
    model: f.options.modelId,
    thinking: "off",
    mode: "auto",
  },
});
if (scenario.startsWith("summary")) {
  const c = await f.sessions.get(f.conversationId);
  await c.commit(async (tx) => {
    for (const content of [
      "Original scientific measurements. ".repeat(4000),
      "Recent unresolved interpretation. ".repeat(4000),
    ])
      await tx.appendEntry(c.id, {
        kind: "pi.user",
        model: [{ role: "user", content, timestamp: Date.now() }],
      });
  }, ctx);
  f.faux.setResponses([
    fauxAssistantMessage("Measurements retained; interpretation remains unresolved."),
  ]);
  f.supervisor.harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (c) =>
          (scenario === "summary" &&
            c.type === "document" &&
            c.record.kind === "biologue.scientific-summary" &&
            Array.isArray(c.value?.responses) &&
            c.value.responses.length) ||
          (scenario === "summary-admitted" &&
            c.type === "task" &&
            c.value.kind === "pi.compaction"),
      )
    ) {
      send({ kind: "summary-committed" });
      process.kill(process.pid, "SIGKILL");
    }
  });
} else if (scenario === "startup") {
  f.pi.create = async () => new Promise(() => {});
} else if (scenario === "provider" || scenario === "providers") {
  let requests = 0;
  f.options.modelRuntime.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    if (++requests === (scenario === "providers" ? 2 : 1)) {
      f.context.update("Correction during interrupted request: donor is the unit.", 0);
      send({ kind: "requesting", runs: f.store.list<AgentRun>("run") });
    }
    return stream;
  };
} else if (scenario.startsWith("question")) {
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ask_user", {
        question: "Which independent unit?",
        options: [{ title: "Donor" }, { title: "Well" }],
        allowFreeform: false,
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  f.events.subscribe((event) => {
    if (event.type !== "question") return;
    send({ kind: "question", question: event.question });
    if (scenario === "question-answered") {
      const put = f.store.put.bind(f.store);
      f.store.put = (kind, id, value) => {
        const result = put(kind, id, value);
        if (kind === "question-answer") process.kill(process.pid, "SIGKILL");
        return result;
      };
      f.supervisor.dialogs.answer(event.question.id, event.question.options![0]);
    }
  });
} else {
  const call =
    scenario === "nested"
      ? fauxToolCall("codemode", {
          code: 'const result = await tools.execute_code({language:"python",code:"effect_once()",reason:"Test recovery"}); console.log(result);',
          title: "Test nested recovery",
        })
      : fauxToolCall("execute_code", {
          language: "python",
          code: "effect_once()",
          reason: "Test recovery",
        });
  f.faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" })]);
}
await f.supervisor.start(
  f.conversationId,
  "Continue the scientific investigation.",
  scenario.startsWith("summary") ? { kind: "compaction" } : undefined,
);
if (scenario === "startup") {
  const run = f.store.list<AgentRun>("run").find((r) => r.status === "running")!;
  const accepted = new Promise<void>((resolve) => {
    const detach = f.events.subscribe((event) => {
      if (
        event.type === "message" &&
        event.message.text === "Startup correction: use donor as the unit."
      ) {
        detach();
        resolve();
      }
    });
  });
  void f.supervisor.steer(run.id, "Startup correction: use donor as the unit.", "followUp");
  await accepted;
  send({ kind: "startup-inputs-accepted" });
}
if (scenario === "providers") {
  const c = f.context.createConversation("Independent second conversation");
  f.context.updateConversation(c.id, {
    settings: f.store.get<Conversation>("conversation", f.conversationId)!.settings,
  });
  await f.supervisor.start(c.id, "Continue the second investigation.");
}
setInterval(() => {}, 1000);
