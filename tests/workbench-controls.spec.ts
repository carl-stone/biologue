import { test, expect } from "@playwright/test";
import { fixture } from "./ui-fixture.ts";

const agent = { enabled: true, provider: "openai-codex", model: "gpt-6-luna", thinking: "medium" };

test("editor navigation, menu editing, save-as and file explorer retain independent buffers", async ({
  page,
}) => {
  const ui = await fixture(page);
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("print('hello')");
  await editor.click();
  await page.keyboard.press("Control+g");
  await expect(page.locator(".cm-search")).toHaveCount(0);
  const line = page.getByRole("textbox", { name: "Go to line:", exact: true });
  await expect(line).toBeFocused();
  await line.fill("2");
  await line.press("Enter");
  await expect(page.locator(".cursor-position")).toContainText("Ln 2, Col 1");
  await page.getByLabel("Edit menu", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Toggle line comment", exact: false }).click();
  await expect(editor).toContainText("# print('hello')");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).not.toContainText("# print");
  await editor.press("Control+End");
  await editor.pressSequentially("print(42)");
  await editor.press("Control+Shift+s");
  const save = page.getByRole("dialog", { name: "Save file", exact: true });
  await expect(save.getByLabel("File name", { exact: true })).toBeFocused();
  await save.getByLabel("File name", { exact: true }).fill("copy.py");
  await save.getByRole("button", { name: "Save file", exact: true }).click();
  await expect(page.getByRole("tab", { name: "copy.py", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor).toContainText("print(42)");
  expect(ui.state.documents.find((d) => d.path === "analysis.py")?.savedAs).toBeUndefined();
  await page
    .getByRole("complementary", { name: "Project files" })
    .getByRole("button", { name: "analysis.R", exact: true })
    .click();
  await expect(editor).toContainText("print('R')");
  await page.keyboard.press("Control+p");
  const open = page.getByRole("dialog", { name: "Open file", exact: true });
  await open.getByRole("textbox").fill("copy.py");
  await open.getByRole("textbox").press("Enter");
  await expect(editor).toContainText("print(42)");
  await page.getByLabel("View menu", { exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Line numbers", exact: true }).click();
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Indentation" }).selectOption("2");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Indentation" })).toHaveValue("2");
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.getByRole("button", { name: "Focus Conversation", exact: true }).click();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("dialog", { name: "Open file", exact: true })).toBeVisible();
});

test("chat suggestions support keyboard selection, dismissal and project attachments without sending", async ({
  page,
}) => {
  const ui = await fixture(page, { agent });
  ui.handle(async (req) =>
    req.path === "/agent/resources"
      ? {
          body: {
            prompts: [{ name: "review", description: "Review analysis", path: "review.md" }],
            skills: [],
            instructions: [],
            diagnostics: [],
          },
        }
      : req.path === "/attachments"
        ? { body: { id: "attached", name: req.body.path, mimeType: "text/plain", size: 12 } }
        : undefined,
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await input.fill("/");
  await expect(page.getByRole("option", { name: "/review Review analysis" })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("/review ");
  expect(ui.requests.some((req) => req.path === "/agent/runs")).toBe(false);
  await input.fill("/");
  await input.press("Escape");
  await expect(page.getByRole("listbox", { name: "Prompt and skill suggestions" })).toHaveCount(0);
  await input.fill("Review @analysis.py");
  await expect(page.getByRole("listbox", { name: "Project file suggestions" })).toBeVisible();
  await input.press("Tab");
  await expect(page.locator(".composer .attachment-list")).toContainText("analysis.py");
  await expect(input).toHaveValue("Review ");
  expect(ui.requests.some((req) => req.path === "/agent/runs")).toBe(false);
});

test("external tool approvals show tool arguments and do not pretend to edit a document", async ({
  page,
}) => {
  const ui = await fixture(page, { agent });
  ui.state.runs = [
    {
      id: "run",
      conversationId: "conversation-1",
      status: "running",
      startedAt: new Date().toISOString(),
      contextVersion: 0,
    },
  ];
  ui.state.permissions = [
    {
      id: "mcp",
      runId: "run",
      conversationId: "conversation-1",
      tool: "mcp_literature_save",
      description: "Save citation",
      code: '{"title":"Example"}',
      createdAt: new Date().toISOString(),
    },
  ];
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(page.getByText("Run mcp_literature_save", { exact: true })).toBeVisible();
  await expect(page.getByText("Arguments", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toHaveCount(0);
});

test("sorting data previews retains original row numbers and does not execute code", async ({
  page,
}) => {
  const ui = await fixture(page, {
    executions: [
      {
        id: "table",
        actor: "human",
        purpose: "inspection",
        inspection: "table",
        language: "python",
        status: "succeeded",
        codeHash: "",
        codePreview: "",
        createdAt: "2026-09-30T10:00:00Z",
      },
    ],
  });
  ui.handle(async (req) =>
    req.path === "/executions/table/result"
      ? {
          body: {
            kind: "table",
            columns: ["sample", "signal"],
            rows: [
              ["A", 10],
              ["B", 2],
              ["C", 20],
            ],
            truncated: false,
          },
        }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Data", exact: true }).click();
  const table = page.locator(".data-pane table");
  await expect(table).toBeVisible();
  await table.getByRole("button", { name: "signal", exact: true }).click();
  await expect(table.locator("tbody tr").first()).toContainText("B");
  await expect(table.locator("tbody tr").first().locator("td, th").first()).toHaveText("2");
  await expect(table.locator("th[aria-sort=ascending]")).toContainText("signal");
  await table.getByRole("button", { name: /signal/ }).click();
  await expect(table.locator("tbody tr").first()).toContainText("C");
  expect(ui.requests.some((req) => req.path === "/executions" && req.method === "POST")).toBe(
    false,
  );
});

test("Save all prompts for each untitled file and saves their distinct contents", async ({
  page,
}) => {
  const ui = await fixture(page);
  for (const [name, content] of [
    ["One", "first note"],
    ["Two", "second note"],
  ]) {
    ui.state.documents.push({
      path: `untitled:${name}/${name}.txt`,
      content,
      version: 1,
      savedVersion: 0,
      diskHash: "",
      untitled: true,
    });
  }
  await page.goto("/");
  await page.getByLabel("File menu", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Save all", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save file", exact: true });
  for (const name of ["one.txt", "two.txt"]) {
    await dialog.getByLabel("File name", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Save file", exact: true }).click();
    await expect.poll(() => ui.state.documents.some((doc) => doc.path === name)).toBe(true);
  }
  await expect(dialog).toHaveCount(0);
  expect(ui.state.documents.find((doc) => doc.path === "one.txt")?.content).toBe("first note");
  expect(ui.state.documents.find((doc) => doc.path === "two.txt")?.content).toBe("second note");
});

test("expired sign-in offers provider recovery and keeps raw errors collapsed", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent,
    runs: [
      {
        id: "failed",
        conversationId: "conversation-1",
        status: "failed",
        startedAt: "2026-09-30T10:00:00Z",
        contextVersion: 0,
        error: 'OAuth refresh failed (401): {"error":"refresh_token_reused"}',
      },
    ],
  });
  ui.handle(async (req) =>
    req.path === "/agent/providers"
      ? {
          body: [
            {
              id: "openai-codex",
              name: "ChatGPT (Codex)",
              connected: true,
              methods: [{ type: "oauth" }],
            },
          ],
        }
      : req.path === "/agent/auth"
        ? { body: null }
        : undefined,
  );
  await page.goto("/");
  await expect(page.getByText("Sign-in expired", { exact: true })).toBeVisible();
  await expect(page.locator(".error-details pre")).not.toBeVisible();
  await page.getByRole("button", { name: "Open provider settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
});
