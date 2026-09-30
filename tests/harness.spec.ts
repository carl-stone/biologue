import { test, expect } from "@playwright/test";
import { fixture } from "./ui-fixture.ts";

const agent = { enabled: true, provider: "openai-codex", model: "gpt-6-luna", thinking: "medium" };

test("per-conversation permissions, prompt discovery and keyboard commands are usable", async ({
  page,
}) => {
  const ui = await fixture(page, { agent });
  ui.handle(async (req) =>
    req.path === "/agent/resources"
      ? {
          body: {
            skills: [
              { name: "study-design", description: "Review design", path: "/project/skill" },
            ],
            prompts: [
              {
                name: "review-analysis",
                description: "Review assumptions",
                path: "/prompts/review.md",
              },
            ],
            instructions: [],
            diagnostics: [],
          },
        }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Permission mode", exact: true }).selectOption("plan");
  await expect.poll(() => ui.state.conversations[0].settings?.mode).toBe("plan");
  await page.getByRole("tab", { name: "Resources", exact: true }).click();
  await page.getByRole("button", { name: /\/review-analysis/ }).click();
  await expect(page.getByRole("textbox", { name: "Message Biologue", exact: true })).toHaveValue(
    "/review-analysis ",
  );
  const editor = page.locator(".cm-content").first();
  const codeBefore = await editor.innerText();
  await editor.click();
  await page.keyboard.press("Control+k");
  await expect(editor).toHaveText(codeBefore, { useInnerText: true });
  const command = page.getByRole("combobox", { name: "Find command or file" });
  await command.fill("Show Research");
  await command.press("Enter");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toBeVisible();
});

test("attachments capture project files and uploads and clear only after a successful send", async ({
  page,
}) => {
  const ui = await fixture(page, { agent });
  ui.handle(async (req) =>
    req.path === "/attachments"
      ? {
          body: {
            id: `attachment-${ui.requests.length}`,
            name: req.body.path ?? req.body.name,
            mimeType: "text/plain",
            size: 12,
          },
        }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Attach files", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Attach files", exact: true })
    .getByRole("button", { name: "analysis.py", exact: true })
    .click();
  await expect(page.locator(".composer .attachment-list")).toContainText("analysis.py");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("scientist note"),
  });
  await expect(page.locator(".composer .attachment-list")).toContainText("notes.txt");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => ui.requests.filter((req) => req.path === "/agent/runs").length).toBe(1);
  expect(ui.requests.find((req) => req.path === "/agent/runs")!.body.attachments).toHaveLength(2);
  await expect(page.locator(".composer .attachment-list")).toHaveCount(0);
});

test("queue delivery, extension questions and context usage surface in the conversation", async ({
  page,
}) => {
  const ui = await fixture(page, { agent });
  ui.state.runs = [
    {
      id: "active",
      conversationId: ui.state.conversations[0].id,
      status: "running",
      startedAt: new Date().toISOString(),
      contextVersion: 0,
      usage: {
        tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, total: 130 },
        cost: 0.001,
        context: { tokens: 500, contextWindow: 1000, percent: 50 },
      },
    },
  ];
  ui.state.questions = [
    {
      id: "question",
      runId: "active",
      conversationId: ui.state.conversations[0].id,
      kind: "select",
      title: "Which comparison?",
      options: ["Matched controls", "All samples"],
    },
  ];
  await page.goto("/");
  await page.getByRole("combobox", { name: "Message delivery" }).selectOption("followUp");
  const input = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await input.fill("After this, check the assumptions.");
  await input.press("Enter");
  await expect
    .poll(() => ui.requests.some((req) => req.path === "/agent/runs/active/steer"))
    .toBe(true);
  expect(ui.requests.find((req) => req.path === "/agent/runs/active/steer")!.body.mode).toBe(
    "followUp",
  );
  await page.getByRole("button", { name: "Matched controls", exact: true }).click();
  await expect
    .poll(() => ui.requests.some((req) => req.path === "/agent/questions/question"))
    .toBe(true);
  await page.getByRole("button", { name: "Context and usage", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Context and usage", exact: true })).toContainText(
    "500 / 1,000",
  );
  await expect(page.getByRole("button", { name: "Compact context", exact: true })).toBeDisabled();
});

test("conversation manager pins, archives and searches history", async ({ page }) => {
  const ui = await fixture(page, { agent });
  ui.handle(async (req) =>
    req.path === "/conversations/search"
      ? { body: { ids: [ui.state.conversations[0].id] } }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Search conversations", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Conversations", exact: true });
  await dialog.getByRole("button", { name: "Pin", exact: true }).first().click();
  await expect(dialog.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Search conversations", exact: true })
    .fill("body-only match");
  await expect(dialog.locator(".conversation-row")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog.locator(".conversation-row")).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Archived", exact: true }).check();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
});
