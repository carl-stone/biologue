import { resolve, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const project = resolve(process.env.BIOLOGUE_PROJECT || "examples/sandbox");
const agentDir = join(resolve(process.env.BIOLOGUE_STATE_DIR || join(project, ".biologue")), "pi");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  await runtime.login("openai-codex", "oauth", {
    signal: controller.signal,
    prompt: async (prompt) => {
      if (prompt.type === "select" && prompt.options.some((option) => option.id === "device_code"))
        return "device_code";
      throw new Error("This command requires Pi's device-code sign-in flow.");
    },
    notify: (event) => {
      if (event.type === "device_code") {
        console.log(`Open ${event.verificationUri}`);
        console.log(`Enter code: ${event.userCode}`);
        console.log("Waiting for you to finish signing in. This code expires in 15 minutes.");
      }
    },
  });
  console.log("Biologue is signed in to ChatGPT. Credentials were saved by Pi.");
} catch (error) {
  console.error(`Sign-in failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
