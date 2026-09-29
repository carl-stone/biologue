import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { DisplayOutput, Execution, Output } from "../packages/protocol/src/index.ts";
import { fixture, initialSnapshot } from "./ui-fixture.ts";

test("discussion exposes recorded work, copies code, and gives a long correction room", async ({
  page,
}) => {
  const code = 'print("inspect before interpreting")\n';
  const execution: Execution = {
    id: "work",
    runId: "run",
    conversationId: "conversation-1",
    language: "python",
    actor: "agent",
    purpose: "analysis",
    status: "succeeded",
    code,
    codePreview: code,
    codeHash: "test",
    createdAt: "2026-09-29T10:00:00Z",
  };
  const ui = await fixture(page, {
    agent: { enabled: true, model: "test" },
    executions: [execution],
    messages: [
      {
        id: "answer",
        conversationId: "conversation-1",
        role: "assistant",
        runId: "run",
        text: `First inspect the design.\n\n\`\`\`python\n${code}\`\`\``,
        createdAt: execution.createdAt,
      },
    ],
  });
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator(".chat").getByRole("button", { name: "Copy code", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.locator(".chat").getByRole("button", { name: "Copy response", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("First inspect the design.");
  await page
    .getByRole("textbox", { name: "Message Biologue", exact: true })
    .fill(Array(8).fill("A correction that must remain visible.").join("\n"));
  await expect
    .poll(() => page.locator(".composer textarea").evaluate((el) => el.clientHeight))
    .toBeGreaterThan(120);
  await page.locator(".run-activity summary").click();
  await page
    .locator(".run-activity")
    .getByRole("button", { name: /Python code/ })
    .click();
  await expect(page.locator("#execution-work > details")).toHaveAttribute("open", "");
  await expect(page.locator("#execution-work .code-record pre")).toHaveText(code);
  expect(
    ui.requests.filter((request) => request.method === "POST" && request.path === "/executions"),
  ).toHaveLength(0);
});

test("editor undo survives file switches and layout changes, and run shortcuts keep exact selections", async ({
  page,
}) => {
  const ui = await fixture(page);
  ui.handle(async (request) =>
    request.path === "/executions"
      ? {
          body: {
            id: "run-" + ui.requests.length,
            ...request.body,
            actor: "human",
            status: "queued",
            purpose: "analysis",
            createdAt: new Date().toISOString(),
          },
        }
      : undefined,
  );
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Code editor: analysis.py", exact: true });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("# undo survives\n");
  await expect(page.getByText("Unsaved file", { exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Project file", exact: true })
    .selectOption("analysis.R");
  await page
    .getByRole("combobox", { name: "Project file", exact: true })
    .selectOption("analysis.py");
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("undo survives");
  await page.setViewportSize({ width: 640, height: 760 });
  await page.getByRole("button", { name: "Open Editor", exact: true }).click();
  await editor.press("ControlOrMeta+y");
  await expect(editor).toContainText("undo survives");
  const source = 'x = 1\nprint(x)\nraise RuntimeError("outside selection")\n';
  await editor.fill(source);
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await editor.press("Home");
  await editor.press("Shift+End");
  await expect(page.getByRole("button", { name: "Run selection", exact: true })).toBeVisible();
  await editor.press("ControlOrMeta+Enter");
  const executions = () => ui.requests.filter((request) => request.path === "/executions");
  await expect.poll(() => executions().length).toBe(1);
  expect(executions()[0].body).toMatchObject({
    code: "print(x)",
    document: { path: "analysis.py", selection: { from: 6, to: 14 } },
  });
  await expect(editor).toBeFocused();
  await expect(
    page.getByRole("button", { name: "View output for latest run", exact: true }),
  ).toHaveText("Queued · View output");
  await page.getByRole("button", { name: "Open Editor", exact: true }).click();
  await expect(editor).toHaveText(source.replaceAll("\n", ""));
  await expect(page.getByRole("button", { name: "Run selection", exact: true })).toBeEnabled();
  await editor.press("Shift+Enter");
  await expect.poll(() => executions().length).toBe(2);
  expect(executions()[1].body.code).toBe("print(x)");
  await page.getByRole("button", { name: "Open Editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run selection", exact: true })).toBeEnabled();
  await editor.press("ControlOrMeta+Shift+Enter");
  await expect.poll(() => executions().length).toBe(3);
  expect(executions()[2].body.code).toBe(source);
  expect(executions()[2].body.document.selection).toBeUndefined();
});

test("resizing keeps a dialog draft and Escape closes editor search before the expanded panel", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Investigation name", exact: true })
    .fill("Donor comparison");
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.getByRole("textbox", { name: "Investigation name", exact: true })).toHaveValue(
    "Donor comparison",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".layout-narrow")).toBeVisible();
  await page.getByRole("button", { name: "Open Editor", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Expand panel", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .press("ControlOrMeta+f");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-search")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore layout", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Expand panel", exact: true })).toBeVisible();
});

test("an unreadable file offers recovery instead of an endless loading state", async ({ page }) => {
  const ui = await fixture(page, { files: ["unavailable.py"], documents: [] });
  let fail = true;
  ui.handle(async (request) =>
    request.path === "/documents" && request.method === "GET"
      ? fail
        ? { status: 503, body: { error: "File temporarily unavailable." } }
        : { body: { ...initialSnapshot.documents[0], path: "unavailable.py" } }
      : undefined,
  );
  await page.goto("/");
  await expect(page.getByText("Couldn’t open this file", { exact: true })).toBeVisible();
  await expect(page.getByText("Opening your file…", { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry opening file", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Code editor: unavailable.py", exact: true }),
  ).toContainText("Synthetic example");
});

test("table filtering and export preserve quoted data and never execute code", async ({ page }) => {
  const execution: Execution = {
    id: "table",
    language: "python",
    actor: "human",
    purpose: "inspection",
    inspection: "table",
    status: "succeeded",
    code: "inspect",
    codePreview: "inspect",
    codeHash: "test",
    createdAt: "2026-09-29T10:00:00Z",
  };
  const ui = await fixture(page, { executions: [execution] });
  ui.handle(async (request) =>
    request.path === "/executions/table/result"
      ? {
          body: {
            kind: "table",
            columns: ["sample", "note"],
            rows: [
              ["A", "has,comma"],
              ["B", 'quote "text"'],
              ["C", "line\nbreak"],
            ],
            truncated: false,
          },
        }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open Data", exact: true }).click();
  await page.getByRole("textbox", { name: "Filter table preview", exact: true }).fill("quote");
  await expect(page.locator(".table-meta")).toContainText("1 of 3 rows");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Open Data", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Filter table preview", exact: true }),
  ).toHaveValue("quote");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download preview CSV", exact: true }).click();
  const downloaded = await download;
  expect(readFileSync((await downloaded.path())!, "utf8")).toBe(
    'sample,note\r\nB,"quote ""text"""',
  );
  await page.getByRole("button", { name: "Clear table filter", exact: true }).click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy table", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('C\t"line\nbreak"');
  expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("figure browsing holds its place and recovers failed images and historical requests", async ({
  page,
}) => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII=";
  const executions: (Execution & { outputs: Output[] })[] = [1, 2].map((id) => ({
    id: `figure-${id}`,
    language: "python",
    actor: "human",
    purpose: "analysis",
    status: "succeeded",
    code: `print(${id})`,
    codePreview: `print(${id})`,
    codeHash: "test",
    createdAt: "2026-09-29T10:00:00Z",
    outputs: [
      {
        id: `output-${id}`,
        executionId: `figure-${id}`,
        sequence: 0,
        kind: "display",
        data: { "image/png": png },
      },
    ],
  }));
  const reference = (id: number): DisplayOutput => ({
    id: `output-${id}`,
    executionId: `figure-${id}`,
    sequence: 0,
    kind: "display",
    mimeTypes: ["image/png"],
    preview: "",
    truncated: false,
    table: false,
    slotId: `output-${id}`,
    ownerExecutionId: `figure-${id}`,
  });
  let visible = [reference(1), reference(2)],
    failReference = false,
    failImage = false;
  const ui = await fixture(page, { executions });
  ui.handle(async (request) => {
    if (request.path === "/outputs" && request.query.get("kind") === "plots")
      return {
        body: request.query.has("before") ? { items: [] } : { items: visible, next: "older" },
      };
    if (request.path === "/outputs/output-1/reference" && failReference)
      return { status: 503, body: { error: "Stored figure temporarily unavailable." } };
  });
  await page.route("**/api/outputs/*/png*", (route) =>
    route.fulfill(
      failImage
        ? { status: 503, body: "unavailable" }
        : { contentType: "image/png", body: Buffer.from(png, "base64") },
    ),
  );
  await page.goto("/");
  await expect(page.locator(".figure-count")).toHaveText("Figure 2 of 2");
  await page.getByRole("button", { name: "Previous figure", exact: true }).click();
  visible.push(reference(3));
  await ui.emit({ type: "execution", execution: { ...executions[1], id: "figure-3" } });
  await ui.emit({ type: "outputs", executionId: "figure-3", language: "python" });
  await expect(page.locator(".figure-count")).toHaveText("Figure 1 of 3");
  await expect(page.locator(".figure img")).toHaveAttribute("src", /output-1\/png/);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Open Plots", exact: true }).click();
  await expect(page.locator(".figure img")).toHaveAttribute("src", /output-1\/png/);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Earlier figures", exact: true }).click();
  await expect(page.getByRole("button", { name: "Latest figures", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Latest figures", exact: true }).click();
  await expect(page.locator(".figure-count")).toHaveText("Figure 3 of 3");
  failImage = true;
  await page.reload();
  await expect(page.getByText("Couldn’t load this image", { exact: true })).toBeVisible();
  failImage = false;
  await page.locator(".plots").getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() => page.locator(".figure img").evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  visible = [reference(2)];
  failReference = true;
  await ui.emit({ type: "outputs", executionId: "figure-2", language: "python" });
  await expect(page.locator(".figure-count")).toHaveText("Figure 1 of 1");
  await page
    .locator("#execution-figure-1")
    .getByRole("button", { name: "View figure", exact: true })
    .click();
  await expect(page.getByText("Couldn’t load the requested figure", { exact: true })).toBeVisible();
  await expect(page.locator(".figure img")).toHaveCount(0);
  failReference = false;
  await page.locator(".plots").getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".figure img")).toHaveAttribute("src", /output-1\/png/);
  expect(
    ui.requests.filter((request) => request.path === "/executions" && request.method === "POST"),
  ).toHaveLength(0);
});
