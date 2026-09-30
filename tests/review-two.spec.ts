import { test, expect } from "@playwright/test";
import { fixture, initialSnapshot } from "./ui-fixture.ts";
import type { Execution, PermissionRequest } from "../packages/protocol/src/index.ts";

const execution: Execution = {
  id: "recorded-run",
  actor: "human",
  purpose: "analysis",
  language: "python",
  status: "succeeded",
  createdAt: "2026-09-29T12:00:00Z",
  code: initialSnapshot.documents[0].content,
  codePreview: "print('hello')",
  codeHash: "fixture",
  document: { path: "analysis.py", version: 1 },
};

test("a changed document cannot be approved from an outdated inline or expanded proposal", async ({
  page,
}) => {
  const request: PermissionRequest = {
    id: "edit-review",
    runId: "agent-run",
    conversationId: "conversation-1",
    tool: "edit_document",
    description: "Update the shared document.",
    createdAt: execution.createdAt,
    document: { path: "analysis.py", version: 1 },
    before: initialSnapshot.documents[0].content,
    code: `# ${"long-name".repeat(100)}\nprint('proposed')`,
  };
  const ui = await fixture(page, {
    permissions: [request],
    agent: { enabled: true, model: "test" },
    runs: [
      {
        id: request.runId,
        conversationId: "conversation-1",
        status: "running",
        contextVersion: 0,
        startedAt: execution.createdAt,
      },
    ],
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  ui.handle(async (req) => {
    if (req.path === "/documents" && req.method === "PUT") await pending;
    return undefined;
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeEnabled();
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .fill("print('my correction')");
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeDisabled();
  expect(ui.state.documents[0].version).toBe(1);
  release();
  await expect.poll(() => ui.state.documents[0].version).toBe(2);
  await expect(page.locator(".proposal-changed")).toContainText("document changed");
  const contained = await page
    .locator(".permission-code")
    .evaluateAll((elements) =>
      elements.every(
        (el) =>
          el.getBoundingClientRect().right <=
          el.closest(".permission-card")!.getBoundingClientRect().right,
      ),
    );
  expect(contained).toBe(true);
  await page.getByRole("button", { name: "Expand proposed code", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Apply edit", exact: true })).toBeDisabled();
  await expect(dialog.locator("pre").first()).toHaveText(request.before!);
  await dialog.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "What should Biologue change?", exact: true }),
  ).toBeFocused();
  expect(
    ui.requests.filter((req) => req.path.startsWith("/permissions/") && req.method === "POST"),
  ).toHaveLength(0);
});

test("console retrieval failures can be retried without running code again", async ({ page }) => {
  const ui = await fixture(page, { executions: [{ ...execution, document: undefined }] });
  let listFailed = true,
    sourceFailed = true,
    fullFailed = true;
  ui.handle(async (req) => {
    if (req.path === "/outputs" && req.query.get("executionId"))
      return listFailed
        ? { status: 503, body: { error: "Output list unavailable." } }
        : {
            body: {
              items: [
                {
                  id: "long-output",
                  slotId: "long-output",
                  executionId: execution.id,
                  ownerExecutionId: execution.id,
                  sequence: 1,
                  kind: "stream",
                  mimeTypes: [],
                  preview: "First lines…",
                  truncated: true,
                  table: false,
                },
              ],
            },
          };
    if (req.path === `/executions/${execution.id}`)
      return sourceFailed
        ? { status: 503, body: { error: "Recorded code unavailable." } }
        : { body: execution };
    if (req.path === "/outputs/long-output")
      return fullFailed
        ? { status: 503, body: { error: "Full output unavailable." } }
        : {
            body: {
              id: "long-output",
              executionId: execution.id,
              sequence: 1,
              kind: "stream",
              text: "The complete stored output.",
            },
          };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Console", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry loading output", exact: true }),
  ).toBeVisible();
  listFailed = false;
  await page.getByRole("button", { name: "Retry loading output", exact: true }).click();
  await page.getByRole("button", { name: "Read full output", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry full output", exact: true })).toBeVisible();
  await expect(page.locator(".output-text")).toContainText("First lines…");
  fullFailed = false;
  await page.getByRole("button", { name: "Retry full output", exact: true }).click();
  await expect(page.locator(".output-text")).toHaveText("The complete stored output.");
  await expect(page.getByRole("button", { name: "Retry loading code", exact: true })).toBeVisible();
  sourceFailed = false;
  await page.getByRole("button", { name: "Retry loading code", exact: true }).click();
  await expect(page.locator(".console-code")).toContainText("print('hello')");
  expect(
    ui.requests.filter((req) => req.path === "/executions" && req.method === "POST"),
  ).toHaveLength(0);
});

test("editor executions show the recorded code even after the document changes", async ({
  page,
}) => {
  await fixture(page, { executions: [execution] });
  await page.goto("/");
  await expect(page.locator(".editor-footer")).not.toContainText(/Revision|Finished|View output/);
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .fill("print('new code')");
  await expect(page.locator(".older-code, .execution details")).toHaveCount(0);
  await expect(page.locator("#execution-recorded-run .console-code")).toContainText(
    execution.code.trim(),
  );
  await expect(page.locator("#execution-recorded-run .console-code")).not.toContainText("new code");
  await expect(page.locator("#execution-recorded-run")).toHaveCount(1);
});

test("panel shortcuts move typing focus and retain drafts across narrow layouts", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Code editor: analysis.py", exact: true });
  await editor.click();
  await page.keyboard.press("Alt+1");
  const chat = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await expect(chat).toBeFocused();
  await page.keyboard.type("Keep donor pairing.");
  await expect(editor).toHaveText(initialSnapshot.documents[0].content.trim(), {
    useInnerText: true,
  });
  await page.keyboard.press("Alt+3");
  const console = page.getByRole("textbox", { name: "Console code", exact: true });
  await expect(console).toBeFocused();
  await page.keyboard.type("# a console draft");
  for (const [shortcut, name] of [
    ["4", "Environment"],
    ["5", "Plots"],
    ["6", "Data"],
  ]) {
    await page.keyboard.press(`Alt+${shortcut}`);
    await expect(page.getByRole("region", { name, exact: true })).toHaveCount(1);
    await expect(page.getByRole("tabpanel", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Alt+7");
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 760, height: 650 });
  await page.keyboard.press("Alt+1");
  await expect(chat).toBeFocused();
  await expect(chat).toHaveValue("Keep donor pairing.");
  await page.keyboard.press("Alt+3");
  await expect(console).toHaveValue("# a console draft");
  await expect(console).toBeFocused();
});
