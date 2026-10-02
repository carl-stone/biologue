import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { diagnosticEvents, diagnosticIssues } from "../packages/server/src/diagnostics.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    run: { type: "string" },
    conversation: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
    since: { type: "string" },
    component: { type: "string" },
    event: { type: "string" },
    level: { type: "string" },
    fingerprint: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: npm run diagnostics -- [issues|events] --state-dir <project>/.biologue [--run ID] [--conversation ID] [--after ID] [--limit 100] [--since ISO_DATE] [--component NAME] [--event NAME] [--level error] [--fingerprint ID]\nReads diagnostics.sqlite without starting Biologue. Outputs paginated JSON.",
  );
} else {
  const command = z.enum(["issues", "events"]).parse(positionals[0] ?? "issues");
  const query = z
    .object({
      after: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      since: z.iso.datetime().optional(),
      runId: z.string().optional(),
      conversationId: z.string().optional(),
      component: z.string().optional(),
      event: z.string().optional(),
      fingerprint: z.string().optional(),
      level: z.enum(["info", "warning", "error"]).optional(),
    })
    .parse({ ...values, runId: values.run, conversationId: values.conversation });
  const stateDir = resolve(
    values["state-dir"] ??
      process.env.BIOLOGUE_STATE_DIR ??
      resolve(process.env.BIOLOGUE_PROJECT ?? "examples/sandbox", ".biologue"),
  );
  const db = new DatabaseSync(resolve(stateDir, "diagnostics.sqlite"), { readOnly: true });
  try {
    const result = command === "issues" ? diagnosticIssues(db, query) : diagnosticEvents(db, query);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n");
  } finally {
    db.close();
  }
}
