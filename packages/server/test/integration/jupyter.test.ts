import { OutputService } from "../../src/outputs.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { createApp } from "../../src/app.ts";
import { JupyterKernels } from "../../src/kernels.ts";
import { ExecutionService } from "../../src/execution.ts";
import { adapters } from "../../src/adapters.ts";
import { PiAdapter } from "../../src/pi.ts";
import { scriptedModel } from "../helpers/pi-fixture.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentRun, Conversation, Execution, Language } from "@carl/protocol";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test(
  "real Python session is shared, records plots/errors, supports interruption and reconnect",
  { timeout: 90000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "carl-jupyter-"));
    const port = await unusedPort();
    const token = randomBytes(20).toString("hex");
    const url = `http://127.0.0.1:${port}/`;
    writeFileSync(join(root, "analysis.py"), "human_value = 41\n");
    const jupyter = spawn(
      resolve(".venv/bin/python"),
      [
        "-m",
        "jupyter_server",
        "--no-browser",
        "--ServerApp.ip=127.0.0.1",
        `--ServerApp.port=${port}`,
        "--ServerApp.port_retries=0",
        "--ServerApp.allow_root=True",
        `--ServerApp.root_dir=${root}`,
        "--ServerApp.log_level=ERROR",
      ],
      { env: { ...process.env, JUPYTER_TOKEN: token }, stdio: "ignore" },
    );
    const kernel = new JupyterKernels(root, url, token);
    let instance: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          if (
            (
              await fetch(`${url}api/status`, {
                headers: { Authorization: `token ${token}` },
                signal: AbortSignal.timeout(500),
              })
            ).ok
          ) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((done) => setTimeout(done, 300));
      }
      assert.equal(ready, true, "Jupyter should become ready");
      const model = await scriptedModel();
      instance = await createApp({
        project: root,
        stateDir: join(root, ".carl"),
        repository: process.cwd(),
        kernel,
        pi: new PiAdapter({ project: root, stateDir: join(root, ".carl"), ...model.options }),
      });
      const { app, execution } = instance;
      const headers = { "x-carl-client": "workbench" };
      const runAgent = async (language: Language, code: string, interveningCode?: string) => {
        model.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("inspect_environment", { language }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(
            fauxToolCall("execute_code", {
              language,
              code,
              reason: "Check shared state in this integration test.",
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("The test execution finished."),
        ]);
        const finished = new Promise<AgentRun>((resolve) => {
          const unsubscribe = instance!.events.subscribe((event) => {
            if (event.type === "agent-run" && event.run.finishedAt) {
              unsubscribe();
              resolve(event.run);
            }
          });
        });
        const interventions: Promise<Execution>[] = [];
        const approve = instance!.events.subscribe((event) => {
          if (event.type !== "permission") return;
          if (interveningCode) {
            const pending = instance!.execution.wait(
              instance!.execution.submit({ language, actor: "human", code: interveningCode }).id,
            );
            interventions.push(pending);
            void pending.then(() => instance!.permissions.decide(event.request.id, true));
          } else instance!.permissions.decide(event.request.id, true);
        });
        try {
          const response = await app.inject({
            method: "POST",
            url: "/api/agent/runs",
            headers,
            payload: {
              conversationId: instance!.store.list<Conversation>("conversation")[0].id,
              text: "Use the shared test object.",
            },
          });
          assert.equal(response.statusCode, 202, response.body);
          const run = await finished;
          for (const result of await Promise.all(interventions))
            assert.equal(result.status, "succeeded", result.error);
          assert.equal(run.status, "completed", run.error);
          const execution = instance!.execution.repository
            .list()
            .items.find((record) => record.runId === run.id && record.purpose === "analysis")!;
          assert.ok(execution.toolCallId);
          return execution;
        } finally {
          approve();
        }
      };
      const doc = instance.documents.open("analysis.py");
      const response = await app.inject({
        method: "POST",
        url: "/api/executions",
        headers,
        payload: {
          language: "python",
          code: doc.content,
          document: { path: doc.path, version: doc.version },
          actor: "agent",
        },
      });
      assert.equal(response.statusCode, 202, response.body);
      const submitted = response.json<Execution>();
      assert.equal(
        submitted.actor,
        "human",
        "The public API must not accept a forged agent identity",
      );
      const first = await execution.wait(submitted.id);
      assert.equal(first.status, "succeeded", first.error);
      const second = await runAgent("python", "agent_value = human_value + 1\nprint(agent_value)");
      assert.equal(execution.outputs.raw(second.id)[0].text, "42\n");
      assert.equal(first.kernelId, second.kernelId);
      const humanAgain = execution.submit({
        language: "python",
        actor: "human",
        code: "print(agent_value + 1)",
      });
      assert.equal(execution.outputs.raw((await execution.wait(humanAgain.id)).id)[0].text, "43\n");
      await execution.wait(
        execution.submit({ language: "python", actor: "human", code: "context_input = 10" }).id,
      );
      const guarded = await runAgent(
        "python",
        "context_output = context_input * 2",
        "context_input = 20",
      );
      assert.equal(guarded.status, "not_executed");
      assert.equal(execution.outputs.count(guarded.id), 0);
      const absent = await execution.wait(
        execution.submit({
          language: "python",
          actor: "human",
          code: "print('context_output' in globals())",
        }).id,
      );
      assert.equal(
        execution.outputs.raw(absent.id)[0].text,
        "False\n",
        "Warning must precede any kernel execution",
      );
      const refreshed = await runAgent(
        "python",
        "context_output = context_input * 2\nprint(context_output)",
      );
      assert.equal(refreshed.status, "succeeded", refreshed.error);
      assert.equal(execution.outputs.raw(refreshed.id)[0].text, "40\n");
      if (process.env.CARL_TEST_R === "1") {
        const rHuman = execution.submit({
          language: "r",
          actor: "human",
          code: "human_value <- 7\nmeasurements <- data.frame(sample = c('A', 'B'), signal = c(2.4, 3.1))",
        });
        const rFirst = await execution.wait(rHuman.id);
        assert.equal(rFirst.status, "succeeded", rFirst.error);
        const rSecond = await runAgent("r", "agent_value <- human_value + 1\nprint(agent_value)");
        assert.equal(rSecond.status, "succeeded", rSecond.error);
        assert.ok(execution.outputs.raw(rSecond.id).some((output) => output.text?.includes("8")));
        assert.equal(rSecond.kernelId, rFirst.kernelId);
        assert.notEqual(rSecond.kernelId, first.kernelId);
        await execution.wait(
          execution.submit({
            language: "r",
            actor: "human",
            code: "context_input <- matrix(c(10, 20, 30, 40), nrow=2)",
          }).id,
        );
        const rGuarded = await runAgent(
          "r",
          "context_means <- rowMeans(context_input)",
          "context_input <- context_input / 10",
        );
        assert.equal(rGuarded.status, "not_executed");
        const rAbsent = await execution.wait(
          execution.submit({
            language: "r",
            actor: "human",
            code: "print(exists('context_means', inherits=FALSE))",
          }).id,
        );
        assert.ok(
          execution.outputs.raw(rAbsent.id).some((output) => output.text?.includes("FALSE")),
        );
        assert.equal(
          (await runAgent("r", "context_means <- rowMeans(context_input)")).status,
          "succeeded",
        );
        const rInspect = execution.submit({
          language: "r",
          actor: "human",
          purpose: "inspection",
          code: adapters.r.inspectionCode,
          inspection: "environment",
        });
        const inspected = await execution.wait(rInspect.id);
        assert.equal(inspected.status, "succeeded", inspected.error);
        assert.ok(
          JSON.parse(
            execution.outputs
              .raw(inspected.id)
              .map((output) => output.text || "")
              .join(""),
          ).some((item: { name: string }) => item.name === "measurements"),
        );
        const rTable = execution.submit({
          language: "r",
          actor: "human",
          purpose: "inspection",
          code: adapters.r.tableCode("measurements"),
          inspection: "table",
        });
        const table = await execution.wait(rTable.id);
        assert.equal(table.status, "succeeded", table.error);
        assert.deepEqual(
          JSON.parse(
            execution.outputs
              .raw(table.id)
              .map((output) => output.text || "")
              .join(""),
          ).columns,
          ["sample", "signal"],
        );
        const rPlot = execution.submit({
          language: "r",
          actor: "human",
          code: "plot(c(1,2,3), c(1,4,2))",
        });
        const rPlotted = await execution.wait(rPlot.id);
        assert.equal(rPlotted.status, "succeeded", rPlotted.error);
        assert.ok(
          execution.outputs
            .raw(rPlotted.id)
            .some((output) => typeof output.data?.["image/png"] === "string"),
          "Ark should return a PNG plot",
        );
      }
      const plot = execution.submit({
        language: "python",
        actor: "human",
        code: "import matplotlib.pyplot as plt\nplt.plot([1,2,3], [1,4,2])\nplt.show()",
      });
      const plotted = await execution.wait(plot.id);
      assert.equal(plotted.status, "succeeded", plotted.error);
      assert.ok(
        execution.outputs
          .raw(plotted.id)
          .some((output) => typeof output.data?.["image/png"] === "string"),
      );
      const displayed = await execution.wait(
        execution.submit({
          language: "python",
          actor: "human",
          code: "from IPython.display import display\nlive_display = display({'text/plain': 'original'}, raw=True, display_id=True)",
        }).id,
      );
      const originalOutput = execution.outputs
        .visible({ executionId: displayed.id })
        .items.find((item) => item.preview === "original")!;
      assert.ok(originalOutput);
      const updated = await execution.wait(
        execution.submit({
          language: "python",
          actor: "human",
          code: "live_display.update({'text/plain': 'updated'}, raw=True)",
        }).id,
      );
      const currentOutput = execution.outputs
        .visible({ executionId: displayed.id })
        .items.find((item) => item.slotId === originalOutput.slotId)!;
      assert.notEqual(currentOutput.id, originalOutput.id);
      assert.equal(currentOutput.executionId, updated.id);
      assert.equal(execution.outputs.get(currentOutput.id)?.data?.["text/plain"], "updated");
      assert.equal(execution.outputs.get(originalOutput.id)?.data?.["text/plain"], "original");
      const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
      assert.ok(
        snapshot.executions.every(
          (record: object) => !("code" in record) && !("outputs" in record),
        ),
      );
      assert.deepEqual(
        (await app.inject({ method: "GET", url: `/api/outputs/${currentOutput.id}` })).json(),
        execution.outputs.get(currentOutput.id),
      );
      const failure = execution.submit({
        language: "python",
        actor: "human",
        code: "raise ValueError('intentional test failure')",
      });
      assert.equal((await execution.wait(failure.id)).status, "failed");
      const long = execution.submit({
        language: "python",
        actor: "human",
        code: "import time\ntime.sleep(30)",
      });
      // Wait until the kernel has received the request before interrupting it.
      await new Promise((done) => setTimeout(done, 500));
      await execution.cancel(long.id);
      assert.equal((await execution.wait(long.id)).status, "interrupted");
      kernel.dispose();
      const reconnect = new JupyterKernels(root, url, token);
      try {
        const reconnectedService = new ExecutionService(
          instance.store,
          instance.events,
          reconnect,
          new OutputService(instance.store, instance.events, join(root, ".carl/artifacts")),
        );
        const check = reconnectedService.submit({
          language: "python",
          actor: "human",
          code: "print(agent_value)",
        });
        const checked = await reconnectedService.wait(check.id);
        assert.equal(checked.status, "succeeded", checked.error);
        assert.equal(checked.kernelId, first.kernelId);
        assert.equal(reconnectedService.outputs.raw(checked.id)[0].text, "42\n");
        const conversationId = instance.store.list<Conversation>("conversation")[0].id;
        const stale = await reconnectedService.wait(
          reconnectedService.submit({
            language: "python",
            actor: "agent",
            conversationId,
            code: "print(agent_value)",
          }).id,
        );
        assert.equal(stale.status, "not_executed");
        assert.ok(stale.contextCheck!.issues.some((issue) => issue.kind === "kernel_changed"));
        // Establish an observation in this connection, then restart the same kernel ID.
        const inspection = await reconnectedService.wait(
          reconnectedService.submit({
            language: "python",
            actor: "agent",
            conversationId,
            purpose: "inspection",
            inspection: "environment",
            code: adapters.python.inspectionCode,
          }).id,
        );
        reconnectedService.context.observeContext(conversationId, [
          {
            role: "toolResult",
            toolName: "inspect_environment",
            toolCallId: inspection.id,
            content: [{ type: "text", text: "agent_value preview" }],
            isError: false,
            timestamp: Date.now(),
            details: {
              biologueObservation: {
                executionId: inspection.id,
                names: ["agent_value"],
                kind: "environment_preview",
              },
            },
          },
        ]);
        const restarted = await fetch(`${url}api/kernels/${checked.kernelId}/restart`, {
          method: "POST",
          headers: { Authorization: `token ${token}` },
        });
        assert.ok(restarted.ok);
        await new Promise((done) => setTimeout(done, 500));
        const afterRestart = await reconnectedService.wait(
          reconnectedService.submit({
            language: "python",
            actor: "agent",
            conversationId,
            code: "print(agent_value)",
          }).id,
        );
        assert.equal(afterRestart.status, "not_executed", afterRestart.error);
        assert.equal(afterRestart.kernelId, checked.kernelId);
        assert.ok(
          afterRestart.contextCheck!.issues.some((issue) => issue.kind === "kernel_changed"),
        );
        await reconnectedService.close();
      } finally {
        reconnect.dispose();
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/executions",
        headers: { ...headers, origin: "https://untrusted.example" },
        payload: { language: "python", code: "print('untrusted')" },
      });
      assert.equal(blocked.statusCode, 403);
      const noHeader = await app.inject({
        method: "POST",
        url: "/api/executions",
        payload: { language: "python", code: "print('untrusted')" },
      });
      assert.equal(noHeader.statusCode, 403);
    } finally {
      kernel.dispose();
      await instance?.app.close();
      jupyter.kill("SIGTERM");
      await Promise.race([
        once(jupyter, "exit"),
        new Promise((done) =>
          setTimeout(() => {
            jupyter.kill("SIGKILL");
            done(null);
          }, 2000),
        ),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
