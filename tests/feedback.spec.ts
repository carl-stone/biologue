import { test, expect } from "@playwright/test";
import { fixture, initialSnapshot } from "./ui-fixture.ts";
import type { Execution } from "../packages/protocol/src/index.ts";

test("completion after a cancellation request exposes the warning beside the captured output", async ({
  page,
}) => {
  const record: Execution = {
    id: "completed-after-cancel",
    actor: "human",
    language: "r",
    purpose: "analysis",
    status: "succeeded",
    code: "Sys.sleep(30); later_statement <- TRUE",
    codeHash: "synthetic",
    codePreview: "Sys.sleep(30)",
    createdAt: new Date().toISOString(),
    error:
      "Cancellation was requested, but the code reported normal completion. Later statements may have run; review the results and live objects.",
  };
  await fixture(page, { executions: [record] });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Session language", exact: true }).selectOption("r");
  await page.getByRole("button", { name: "Focus Console", exact: true }).click();
  await expect(page.locator(".execution .output-error")).toHaveText(record.error!);
  await expect(page.locator(".execution .console-code")).toContainText("later_statement <- TRUE");
  await expect(page.locator(".execution .execution-status")).toHaveCount(0);
});

test("rapid agent updates retain the response without rendering errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const run = {
    id: "streaming-run",
    conversationId: "conversation-1",
    status: "running" as const,
    contextVersion: 0,
    startedAt: new Date().toISOString(),
  };
  const ui = await fixture(page, { runs: [run], agent: { enabled: true, model: "test" } });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
  let text = "";
  for (let index = 0; index < 120; index++) {
    const delta = `word${index}: These donor measurements remain paired.\n\n`;
    text += delta;
    await ui.emit({ type: "agent-delta", runId: run.id, delta });
    if (index === 60) {
      await page.locator(".chat-messages").evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(page.locator(".chat .jump-latest")).toBeVisible();
    }
  }
  await expect(page.locator(".chat-messages > .message")).toContainText("word119");
  expect(await page.locator(".chat-messages").evaluate((element) => element.scrollTop)).toBe(0);
  await page.locator(".chat .jump-latest").click();
  await expect(page.locator(".chat .jump-latest")).toHaveCount(0);
  await ui.emit({
    type: "message",
    message: {
      id: "streamed-response",
      conversationId: run.conversationId,
      role: "assistant",
      runId: run.id,
      text,
      createdAt: run.startedAt,
    },
  });
  await ui.emit({ type: "agent-run", run: { ...run, status: "completed" } });
  await expect(page.locator(".chat-messages > .message")).toContainText("word119");
  expect(errors).toEqual([]);
});

// Synthetic browser states. Real execution and source identity are covered by workspace.spec.ts.
test("new conversations need no name, can be renamed, and keep agent settings beside the composer", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent: { enabled: true, model: "gpt-6-luna", provider: "openai-codex" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue(
    "conversation-3",
  );
  await expect(page.getByRole("textbox", { name: "Message Biologue", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Rename conversation", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Conversation name", exact: true })
    .fill("Matched donors");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toContainText(
    "Matched donors",
  );
  expect(ui.state.conversations.at(-1)?.titleMode).toBe("manual");
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Conversation settings", exact: true });
  await expect(settings).toBeVisible();
  expect(await settings.evaluate((el) => !!el.closest(".chat"))).toBe(true);
  await expect(page.locator('.workspace-nav [data-panel="controls"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agent settings", exact: true })).toBeFocused();
});

test("untitled tabs can be edited, reopened, and saved without an up-front dialog", async ({
  page,
}) => {
  const ui = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const path = ui.state.documents.find((doc) => doc.untitled)!.path;
  const editor = page.getByRole("textbox", { name: `Code editor: ${path}`, exact: true });
  await editor.fill("print('untitled work')");
  await expect
    .poll(() => ui.state.documents.find((doc) => doc.path === path)?.content)
    .toBe("print('untitled work')");
  expect(ui.state.files).not.toContain(path);
  await page.getByRole("tab", { name: path.split("/").pop(), exact: true }).press("Delete");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Untitled/ })
    .click();
  await expect(editor).toContainText("untitled work");
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("textbox", { name: "File name", exact: true }).fill("donors.py");
  await page.getByRole("dialog").getByRole("button", { name: "Save file", exact: true }).click();
  await expect(page.getByRole("tab", { name: "donors.py", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("textbox", { name: "Code editor: donors.py", exact: true }),
  ).toContainText("untitled work");
  await expect(page.locator(".save-file .unsaved-dot")).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "donors.py", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Code editor: donors.py", exact: true }),
  ).toContainText("untitled work");
});

test("console echoes exact code, recalls commands, and keeps routine metadata out of the transcript", async ({
  page,
}) => {
  const execution: Execution = {
    id: "console-history",
    actor: "human",
    language: "python",
    purpose: "analysis",
    status: "succeeded",
    code: "x = 2\nprint(x)",
    codePreview: "x = 2",
    codeHash: "synthetic",
    createdAt: "2026-09-29T09:00:00Z",
  };
  await fixture(page, { executions: [execution] });
  await page.goto("/");
  await expect(page.locator(".console-code")).toContainText("print(x)");
  await expect(page.locator(".console")).not.toContainText(/Finished|1 execution|Show inspections/);
  const input = page.getByRole("textbox", { name: "Console code", exact: true });
  await input.fill("draft expression");
  await input.press("Home");
  await input.press("ArrowUp");
  await expect(input).toHaveValue(execution.code);
  await input.press("ControlOrMeta+End");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("draft expression");
  await page.getByLabel("Console options", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Include object checks", exact: true }),
  ).toBeVisible();
});

test("review captures cover a wide workspace, local settings, file saving, and narrow navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ui = await fixture(page, {
    agent: { enabled: true, model: "gpt-6-luna", provider: "openai-codex" },
    researchContext: {
      text: "The same donors contribute to both conditions. The values below are synthetic.",
      version: 1,
      updatedAt: "2026-09-29T09:00:00Z",
    },
    messages: [
      {
        id: "q",
        conversationId: "conversation-1",
        role: "user",
        text: "Before we compare conditions, can we check that each donor has both samples?",
        createdAt: "2026-09-29T09:00:00Z",
      },
      {
        id: "a",
        conversationId: "conversation-1",
        role: "assistant",
        text: "Yes. Let’s check the sample pairing first. Are these repeated measurements from the same donors, or separate preparations? That determines how we should compare them.",
        createdAt: "2026-09-29T09:00:01Z",
      },
    ],
  });
  await page.setViewportSize({ width: 2111, height: 1268 });
  await page.goto("/");
  await expect(page.locator(".cm-content")).toContainText("hello");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".plots")).not.toBeVisible();
  await expect(page.locator(".header-actions")).not.toContainText("Workspace connected");
  await page.screenshot({ path: "test-results/feedback-wide.png" });
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.screenshot({ path: "test-results/feedback-settings.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.screenshot({ path: "test-results/feedback-save.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 760, height: 700 });
  await page.getByRole("button", { name: "Focus Conversation", exact: true }).click();
  await page.screenshot({ path: "test-results/feedback-narrow-chat.png" });
  await page.getByRole("button", { name: "Focus Editor", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.screenshot({ path: "test-results/feedback-narrow-editor.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("unsent edits survive when an untitled document is saved elsewhere", async ({ page }) => {
  const ui = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  const original = ui.state.documents.find((doc) => doc.untitled)!;
  await ui.connect(false);
  await page
    .getByRole("textbox", { name: `Code editor: ${original.path}`, exact: true })
    .fill("print('local correction')");
  const saved = {
    ...initialSnapshot.documents[0],
    path: "elsewhere.py",
    content: "print('saved elsewhere')",
  };
  ui.state.documents.push(saved);
  ui.state.files.push(saved.path);
  await ui.emit({ type: "document", document: { ...original, savedAs: saved.path } });
  await expect(
    page.getByText("This document was saved as elsewhere.py.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("local correction");
  await ui.connect(true);
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Untitled/ })
    .click();
  await page.getByRole("button", { name: "Keep as untitled", exact: true }).click();
  await expect(
    page.getByText("This document was saved as elsewhere.py.", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("local correction");
  expect(ui.state.documents.find((doc) => doc.path === "elsewhere.py")?.content).toBe(
    "print('saved elsewhere')",
  );
  expect(
    ui.state.documents.some(
      (doc) =>
        doc.path !== original.path && doc.untitled && doc.content === "print('local correction')",
    ),
  ).toBe(true);
});
