import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Execution, Output } from "../packages/protocol/src/index.ts";
import { fixture, initialSnapshot } from "./ui-fixture.ts";

for (const panel of ["Data", "Environment", "Plots"] as const) {
  test(`${panel} distinguishes loading from failure and retries without running code`, async ({
    page,
  }) => {
    const record: Execution = {
      id: "saved-inspection",
      language: "python",
      actor: "human",
      purpose: "inspection",
      inspection: panel === "Data" ? "table" : "environment",
      status: "succeeded",
      code: "inspect",
      codeHash: "test",
      codePreview: "inspect",
      createdAt: "2026-09-29T10:00:00Z",
    };
    const ui = await fixture(page, { executions: panel === "Plots" ? [] : [record] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    ui.handle(async (request) => {
      if (request.path !== (panel === "Plots" ? "/outputs" : `/executions/${record.id}/result`))
        return;
      await pending;
      if (fail) return { status: 503, body: { error: "Stored result temporarily unavailable." } };
      return {
        body:
          panel === "Data"
            ? { kind: "table", columns: ["measurement"], rows: [[2.4]] }
            : panel === "Environment"
              ? {
                  kind: "environment",
                  rows: [{ name: "measurement", type: "float", preview: "2.4" }],
                }
              : { items: [] },
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: `Focus ${panel}`, exact: true }).click();
    const pane = page.locator(
      panel === "Data" ? ".data-pane" : panel === "Plots" ? ".plots" : ".environment",
    );
    await expect(pane.getByText(/^Loading /)).toBeVisible();
    release();
    await expect(pane.getByText(/^Couldn’t load/)).toBeVisible();
    await expect(pane.getByText("Stored result temporarily unavailable.")).toBeVisible();
    fail = false;
    await pane.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      pane.getByText(panel === "Plots" ? "Plots" : "measurement", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByText(/^Couldn’t load/)).toHaveCount(0);
    expect(
      ui.requests.filter(
        (request) => request.path === "/inspect" || request.path === "/executions",
      ),
    ).toHaveLength(0);
  });
}

test("environment pages stay distinct from targeted agent inspections and unknown completion is visible", async ({
  page,
}) => {
  const inventory: Execution = {
    id: "inventory-0",
    language: "python",
    actor: "human",
    purpose: "inspection",
    inspection: "environment",
    inspectionOptions: { offset: 0 },
    code: "inspect",
    codeHash: "test",
    codePreview: "inspect",
    status: "succeeded",
    createdAt: "2026-09-29T10:00:00Z",
  };
  const ui = await fixture(page, { executions: [inventory] });
  const offsets = new Map([[inventory.id, 0]]);
  ui.handle(async (request) => {
    if (request.path === "/inspect") {
      const offset = request.body.offset;
      const record = {
        ...inventory,
        id: `inventory-request-${offsets.size}`,
        inspectionOptions: { offset },
      };
      offsets.set(record.id, offset);
      await ui.emit({ type: "execution", execution: record });
      return { body: record };
    }
    const offset = request.path.endsWith("/result")
      ? offsets.get(request.path.split("/")[2])
      : undefined;
    if (offset === 0)
      return {
        body: {
          kind: "environment",
          rows: Array.from({ length: 100 }, (_, i) => ({
            name: `object_${i}`,
            type: "int",
            preview: String(i),
          })),
          next: 100,
        },
      };
    if (offset === 100)
      return {
        body: {
          kind: "environment",
          rows: [{ name: "last_object", type: "int", preview: "100" }],
        },
      };
    return undefined;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Environment", exact: true }).click();
  await expect(page.getByText("Objects 1–100", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next objects" }).click();
  await expect(page.getByText("last_object", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next objects" })).toBeDisabled();
  expect(ui.requests.find((request) => request.path === "/inspect")?.body).toEqual({
    language: "python",
    offset: 100,
  });
  await ui.emit({
    type: "execution",
    execution: {
      ...inventory,
      id: "targeted",
      actor: "agent",
      inspectionOptions: { names: ["object_1"] },
    },
  });
  await expect(page.getByText("last_object", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous objects" }).click();
  await expect(page.getByText("Objects 1–100", { exact: true })).toBeVisible();
  await ui.emit({
    type: "execution",
    execution: {
      ...inventory,
      id: "unknown",
      purpose: "analysis",
      inspection: undefined,
      status: "completion_unknown",
      kernelUncertain: true,
      error: "Interrupt did not confirm completion. Code may still be running.",
    },
  });
  await page.getByRole("button", { name: "Focus Console", exact: true }).click();
  await expect(page.locator("#execution-unknown .execution-status")).toHaveText(
    "Completion unknown",
  );
});

test("single-panel grips appear while arranging; actual tabs and regrouped panels survive reload", async ({
  page,
}) => {
  const ui = await fixture(page);
  ui.handle(async (request) => {
    if (request.path === "/layout" && request.method === "PUT") {
      ui.state.layout = request.body;
      return { body: { ok: true } };
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toBeVisible();
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Research context", exact: true })
    .fill("Keep this draft");
  await page.getByRole("button", { name: "Arrange panels", exact: true }).click();
  await expect(page.locator(".dv-tab:visible")).toHaveCount(7);
  await page
    .getByRole("tab", { name: "Research context", exact: true })
    .dragTo(page.locator(".editor-pane"));
  const editorGroup = page.locator(".dv-groupview").filter({
    has: page.getByRole("tab", { name: "Editor", exact: true }),
  });
  await expect(
    editorGroup.getByRole("tab", { name: "Research context", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => JSON.stringify(ui.state.layout))
    .toMatch(/"views":\["(editor","context|context","editor)"\]/);
  // Reload while the saved layout has visible headers. Arrangement mode is temporary.
  await page.reload();
  await expect(page.getByRole("button", { name: "Arrange panels", exact: true })).toBeEnabled();
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toHaveValue(
    "Keep this draft",
  );
  await page.getByRole("button", { name: "Arrange panels", exact: true }).click();
  await expect(
    editorGroup.getByRole("tab", { name: "Research context", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset panel layout", exact: true }).click();
  await expect(page.locator(".dv-tab:visible")).toHaveCount(7);
  await page.getByRole("button", { name: "Done arranging panels", exact: true }).click();
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset panel layout", exact: true }).click();
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Arrange panels", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Arrange panels", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.locator(".dv-tab:visible")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole("button", { name: "Arrange panels", exact: true })).toBeVisible();
  await expect(page.locator(".dv-single-tab .dv-tab:visible")).toHaveCount(0);
});

test("compact layouts, focus, and keyboard navigation retain local work", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message Biologue", exact: true })
    .fill("A question in progress");
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Research context", exact: true })
    .fill("Observation: the samples were collected on different days.");
  await page.getByRole("textbox", { name: "Console code", exact: true }).fill("print('draft')");
  await page.setViewportSize({ width: 1000, height: 740 });
  await expect(page.locator(".layout-compact")).toBeVisible();
  await expect
    .poll(() => page.locator(".chat").evaluate((el) => el.clientWidth))
    .toBeGreaterThanOrEqual(280);
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toHaveValue(
    /different days/,
  );
  await page.keyboard.press("Alt+2");
  await page.keyboard.press("Alt+f");
  await expect(page.getByRole("button", { name: "Restore layout" })).toBeVisible();
  await expect
    .poll(() => page.locator(".editor-pane").evaluate((el) => el.clientWidth))
    .toBeGreaterThan(850);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Expand panel" })).toBeVisible();
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.locator(".layout-narrow")).toBeVisible();
  await page.keyboard.press("Alt+1");
  await expect(page.getByRole("textbox", { name: "Message Biologue", exact: true })).toHaveValue(
    "A question in progress",
  );
  await page.reload();
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toHaveValue(
    /different days/,
  );
  await page.getByRole("button", { name: "Focus Console", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Console code", exact: true })).toHaveValue(
    "print('draft')",
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test("file execution follows the script language and offline drafts remain editable", async ({
  page,
}) => {
  const ui = await fixture(page);
  ui.handle(async (request) =>
    request.path === "/executions" ? { body: { id: "execution-1", ...request.body } } : undefined,
  );
  await page.goto("/");
  await page.getByRole("combobox", { name: "Session language" }).selectOption("r");
  await expect(page.getByText("This file runs in Python. The console is viewing R.")).toBeVisible();
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Session language" })).toHaveValue("python");
  expect(ui.requests.find((request) => request.path === "/executions")?.body).toEqual({
    language: "python",
    code: initialSnapshot.documents[0].content,
    document: { path: "analysis.py", version: 1 },
  });
  await ui.connect(false);
  await expect(page.locator(".connection-banner")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .fill("print('retained while offline')");
  await expect(page.getByText("Offline edits", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
  await ui.connect(true);
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("retained while offline");
});

test("version conflicts retain and expose both document and context versions", async ({ page }) => {
  const ui = await fixture(page);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .fill("print('my draft')");
  await ui.emit({
    type: "document",
    document: { ...initialSnapshot.documents[0], content: "print('shared version')", version: 2 },
  });
  await expect(page.getByText("The working document changed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  await page.getByText("Review working version · revision 2").click();
  await expect(page.locator(".conflict pre")).toHaveText("print('shared version')");
  await expect(page.locator(".cm-content")).toHaveText("print('my draft')");
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Research context", exact: true })
    .fill("My observed result");
  await ui.emit({
    type: "context",
    context: {
      text: "A correction from another window",
      version: 1,
      updatedAt: new Date().toISOString(),
    },
  });
  await expect(page.getByRole("button", { name: "Save context", exact: true })).toBeDisabled();
  await page.getByText("Review saved notes · version 1").click();
  await expect(page.locator(".research .conflict pre")).toHaveText(
    "A correction from another window",
  );
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toHaveValue(
    "My observed result",
  );
});

test("failed submissions explain the error and retain the console draft", async ({ page }) => {
  const ui = await fixture(page);
  ui.handle(async (request) =>
    request.path === "/executions"
      ? {
          status: 503,
          body: { error: "The Python kernel is unavailable. Reconnect the session and try again." },
        }
      : undefined,
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Console code", exact: true });
  await input.fill("print('keep this input')");
  await input.press("ControlOrMeta+Enter");
  const error = page.getByRole("alert").filter({ hasText: "The Python kernel is unavailable" });
  await expect(error).toBeVisible();
  await expect(input).toHaveValue("print('keep this input')");
  await expect(page.getByRole("button", { name: "Run console code" })).toBeEnabled();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(error).toHaveCount(0);
});

test("saving context preserves changes typed while the request is in flight", async ({ page }) => {
  const ui = await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  ui.handle(async (request) => {
    if (request.path !== "/context") return;
    await pending;
    const context = { text: request.body.text, version: 1, updatedAt: new Date().toISOString() };
    await ui.emit({ type: "context", context });
    return { body: context };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  const notes = page.getByRole("textbox", { name: "Research context", exact: true });
  await notes.fill("Observation one");
  await page.getByRole("button", { name: "Save context", exact: true }).click();
  await expect
    .poll(() => ui.requests.filter((request) => request.path === "/context").length)
    .toBe(1);
  await notes.fill("Observation one\nObservation two");
  release();
  await expect(page.getByRole("button", { name: "Save context", exact: true })).toBeEnabled();
  await expect(notes).toHaveValue("Observation one\nObservation two");
  await expect(page.getByRole("button", { name: "Save context", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save context", exact: true }).click();
  await expect
    .poll(() => ui.requests.filter((request) => request.path === "/context").length)
    .toBe(2);
  expect(ui.requests.filter((request) => request.path === "/context")[1].body).toEqual({
    text: "Observation one\nObservation two",
    expectedVersion: 1,
  });
});

test("conversation drafts are separate, sends are guarded, and new investigations are named", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent: { enabled: true, provider: "test", model: "UI fixture" },
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  ui.handle(async (request) => {
    if (request.path !== "/agent/runs") return;
    await pending;
    return { body: { id: "run-test" } };
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await input.fill("First question");
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption("conversation-2");
  await expect(input).toHaveValue("");
  await input.fill("Second question");
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption("conversation-1");
  await expect(input).toHaveValue("First question");
  await input.press("ControlOrMeta+Enter");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await input.fill("New thought while sending");
  await input.press("ControlOrMeta+Enter");
  expect(ui.requests.filter((request) => request.path === "/agent/runs")).toHaveLength(1);
  release();
  await expect(input).toHaveValue("New thought while sending");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue(
    "conversation-3",
  );
  await expect(input).toHaveValue("");
});

test("permission review shows exact code, prevents duplicate decisions, and supports denial", async ({
  page,
}) => {
  const request = {
    id: "permission-1",
    runId: "run-1",
    tool: "execute_code",
    description: "Inspect the synthetic signal distribution.",
    code: "measurements.describe()",
    language: "python" as const,
    createdAt: "2026-09-26T10:00:00Z",
  };
  const ui = await fixture(page, {
    agent: { enabled: true, provider: "test", model: "UI fixture" },
    permissions: [request],
    runs: [
      {
        id: "run-1",
        conversationId: "conversation-1",
        status: "running",
        startedAt: request.createdAt,
        contextVersion: 0,
      },
    ],
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  ui.handle(async (req) => {
    if (!req.path.startsWith("/permissions")) return;
    await pending;
    await ui.emit({ type: "permission-resolved", id: req.path.split("/").at(-1)! });
    return { body: { ok: true } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Conversation", exact: true }).click();
  await expect(page.locator(".permission-card pre")).toHaveText(request.code);
  await page.getByRole("button", { name: "Expand proposed code", exact: true }).click();
  await expect(page.getByRole("dialog").locator("pre")).toHaveText(request.code);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Expand proposed code", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Expand proposed code", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run once", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Decline", exact: true }),
  ).toBeDisabled();
  expect(ui.requests.filter((req) => req.path === "/permissions/permission-1")).toHaveLength(1);
  expect(ui.requests.find((req) => req.path === "/permissions/permission-1")?.body).toEqual({
    allow: true,
  });
  release();
  await expect(page.locator(".permission-card")).toHaveCount(0);
  await ui.emit({ type: "permission", request: { ...request, id: "permission-2" } });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.locator(".permission-card")).toHaveCount(0);
  expect(ui.requests.find((req) => req.path === "/permissions/permission-2")?.body).toEqual({
    allow: false,
  });
});

test("a failed approval stays visible in the code review dialog and can be retried", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent: { enabled: true, provider: "test", model: "UI fixture" },
    permissions: [
      {
        id: "permission-retry",
        conversationId: "conversation-1",
        runId: "run-1",
        tool: "execute_code",
        language: "python",
        description: "Summarize the measurements.",
        code: "measurements.describe()",
        createdAt: "2026-09-29T10:00:00Z",
      },
    ],
  });
  let fail = true;
  ui.handle(async (request) => {
    if (request.path !== "/permissions/permission-retry") return;
    if (fail) return { status: 503, body: { error: "Couldn’t save this decision. Try again." } };
    await ui.emit({ type: "permission-resolved", id: "permission-retry" });
    return { body: { ok: true } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Conversation", exact: true }).click();
  await page.getByRole("button", { name: "Expand proposed code", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Run once", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Couldn’t save this decision. Try again.");
  await expect(dialog.getByRole("button", { name: "Run once", exact: true })).toBeEnabled();
  fail = false;
  await dialog.getByRole("button", { name: "Run once", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    ui.requests.filter((request) => request.path === "/permissions/permission-retry"),
  ).toHaveLength(2);
});

test("new messages do not pull a scientist away from earlier reading", async ({ page }) => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `message-${i}`,
    conversationId: "conversation-1",
    role: "assistant" as const,
    text: `**Observation ${i + 1}**\n\nThis is a synthetic UI fixture. It does not establish a biological interpretation.\n\n- Check the supplied context.\n- Retain uncertainty.`,
    createdAt: "2026-09-26T10:00:00Z",
  }));
  const ui = await fixture(page, { messages });
  await page.goto("/");
  await expect(page.locator(".message")).toHaveCount(12);
  await page.locator(".chat-messages").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await ui.emit({
    type: "message",
    message: { ...messages[0], id: "message-new", text: "A new message" },
  });
  await expect
    .poll(() => page.locator(".chat-messages").evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(page.getByRole("button", { name: "Latest messages", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message Biologue", exact: true })
    .fill(Array(8).fill("A correction while reviewing the earlier discussion.").join("\n"));
  await expect
    .poll(async () => {
      const jump = await page
        .getByRole("button", { name: "Latest messages", exact: true })
        .boundingBox();
      const composer = await page.locator(".composer").boundingBox();
      return !!jump && !!composer && jump.y + jump.height <= composer.y;
    })
    .toBe(true);
  await page.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(page.getByText("A new message", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Latest messages", exact: true })).toHaveCount(0);
});

test("an older figure opens its own artifact and exact source", async ({ page }) => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII=";
  const executions: (Execution & { outputs: Output[] })[] = [1, 2].map((id) => ({
    id: `figure-${id}`,
    language: "python",
    actor: "human",
    code: `print('source ${id}')`,
    codePreview: `print('source ${id}')`,
    codeHash: `hash-${id}`,
    purpose: "analysis",
    status: "succeeded",
    createdAt: "2026-09-26T10:00:00Z",
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
  await fixture(page, { executions });
  await page.goto("/");
  await expect(page.locator(".figure-count")).toHaveText("Figure 2 of 2");
  await page.locator(".execution").first().getByRole("button", { name: "View figure" }).click();
  await expect(page.locator(".figure-count")).toHaveText("Figure 1 of 2");
  await page.locator(".plots").getByRole("button", { name: "View output" }).click();
  await expect(page.locator("#execution-figure-1 .console-code")).toContainText(
    "print('source 1')",
  );
  await page.getByRole("button", { name: "Expand figure" }).click();
  await expect(page.getByRole("button", { name: "Restore layout" })).toBeVisible();
});

test("main panels and help dialog meet automated accessibility checks", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.locator(".cm-content")).toContainText("Synthetic example");
  for (const panel of [null, "Research context", "Agent settings", "Data"] as const) {
    if (panel)
      await page
        .getByRole("button", {
          name: panel === "Agent settings" ? panel : `Focus ${panel}`,
          exact: true,
        })
        .click();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      result.violations,
      `${panel || "Initial workspace"}: ${JSON.stringify(result.violations)}`,
    ).toEqual([]);
  }
  await page.getByRole("button", { name: "Workspace help" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Workspace help" })).toBeFocused();
});

test("queued corrections remain visible after cancellation and delivery does not duplicate them", async ({
  page,
}) => {
  const run = {
    id: "run-queued",
    conversationId: "conversation-1",
    status: "running" as const,
    startedAt: "2026-09-26T10:00:00Z",
    contextVersion: 0,
  };
  const ui = await fixture(page, {
    agent: { enabled: true, provider: "test", model: "UI fixture" },
    runs: [run],
  });
  const message = {
    id: "correction-1",
    conversationId: "conversation-1",
    role: "user" as const,
    text: "Those samples share one donor.",
    createdAt: "2026-09-26T10:01:00Z",
    runId: run.id,
    delivery: "pending" as const,
  };
  ui.handle(async (request) => {
    if (request.path === `/agent/runs/${run.id}/steer`) {
      await ui.emit({ type: "message", message });
      return { body: { ok: true } };
    }
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message Biologue", exact: true }).fill(message.text);
  await page.getByRole("button", { name: "Send context", exact: true }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await ui.emit({
    type: "agent-run",
    run: { ...run, status: "cancelled", finishedAt: "2026-09-26T10:02:00Z" },
  });
  await expect(page.getByText("Saved for your next message", { exact: true })).toBeVisible();
  await ui.emit({ type: "message", message: { ...message, delivery: "delivered" } });
  await expect(page.getByText("Saved for your next message", { exact: true })).toHaveCount(0);
  await expect(page.getByText(message.text, { exact: true })).toHaveCount(1);
});

test("automatic document sync preserves a revert typed during an outstanding request", async ({
  page,
}) => {
  const ui = await fixture(page);
  let release!: () => void;
  let first = true;
  ui.handle(async (request) => {
    if (request.path !== "/documents" || request.method !== "PUT" || !first) return;
    first = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    const document = {
      ...ui.state.documents[0],
      content: request.body.content,
      version: 2,
      editId: request.body.editId,
    };
    await ui.emit({ type: "document", document });
    return { body: document };
  });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Code editor: analysis.py", exact: true });
  await editor.fill("print('in flight')");
  await expect
    .poll(
      () =>
        ui.requests.filter((request) => request.path === "/documents" && request.method === "PUT")
          .length,
    )
    .toBe(1);
  await editor.fill(initialSnapshot.documents[0].content);
  release();
  await expect.poll(() => ui.state.documents[0].version).toBe(3);
  expect(ui.state.documents[0].content).toBe(initialSnapshot.documents[0].content);
  await expect(editor.locator(".cm-line")).toHaveText(
    initialSnapshot.documents[0].content.split("\n"),
  );
  expect(
    ui.requests.filter((request) => request.path === "/documents" && request.method === "PUT")[1]
      .body.expectedVersion,
  ).toBe(2);
  await expect(page.getByRole("button", { name: "Share buffer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(editor.locator(".cm-line")).toHaveText(
    initialSnapshot.documents[0].content.split("\n"),
  );
});

test("disk conflicts expose the reviewed disk version and can be resolved in the editor", async ({
  page,
}) => {
  const document = {
    ...initialSnapshot.documents[0],
    content: "working copy",
    version: 2,
    diskConflict: { content: "external edit", hash: "external-hash" },
  };
  const ui = await fixture(page, { documents: [document] });
  ui.handle(async (request) => {
    if (request.path !== "/documents/reconcile") return;
    expect(request.body).toEqual({
      path: document.path,
      expectedVersion: 2,
      expectedDiskHash: "external-hash",
      choice: "disk",
    });
    const reconciled = {
      ...document,
      content: "external edit",
      version: 3,
      savedVersion: 3,
      diskHash: "external-hash",
      diskConflict: undefined,
    };
    await ui.emit({ type: "document", document: reconciled });
    return { body: reconciled };
  });
  await page.goto("/");
  await expect(page.getByText("The file changed on disk.", { exact: true })).toBeVisible();
  await page.getByText("Review disk version", { exact: true }).click();
  await expect(page.locator(".conflict pre")).toHaveText("external edit");
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Use disk version", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("external edit");
  await expect(page.locator(".save-file .unsaved-dot")).toHaveCount(0);
  await expect(page.locator(".save-feedback")).not.toBeVisible();
});

test("chat pages only the selected conversation and keeps the reading position when loading earlier messages", async ({
  page,
}) => {
  const messages = Array.from({ length: 125 }, (_, i) => ({
    id: `history-${i}`,
    conversationId: "conversation-1",
    role: "assistant" as const,
    sequence: i,
    text: `Observation ${i}. The interpretation remains unresolved.`,
    createdAt: "2026-09-28T10:00:00Z",
    delivery: "delivered" as const,
  }));
  const ui = await fixture(page, { messages });
  await page.goto("/");
  await expect(page.locator(".message")).toHaveCount(50);
  expect(
    ui.requests
      .filter((request) => request.path.endsWith("/messages"))
      .map((request) => request.path),
  ).toEqual(["/conversations/conversation-1/messages"]);
  await page.locator(".chat-messages").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const anchor = page.getByText(messages[75].text, { exact: true });
  const top = (await anchor.boundingBox())!.y;
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect(page.locator(".message")).toHaveCount(100);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(3);
  expect(
    ui.requests.filter((request) => request.path.endsWith("/messages"))[1].query.get("before"),
  ).toBe("history-75");
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption("conversation-2");
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Biologue", exact: true })).toBeVisible();
  await ui.emit({
    type: "message",
    message: { ...messages[0], id: "history-live", text: "A newer observation.", sequence: 125 },
  });
  await expect(page.locator(".message")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption("conversation-1");
  await expect(page.locator(".message")).toHaveCount(50);
  await expect(page.getByText("A newer observation.", { exact: true })).toBeVisible();
  await ui.connect(false);
  await ui.connect(true);
  await expect(page.locator(".message")).toHaveCount(50);
});

test("conversation loading errors are retryable and a live delivery survives a stale page", async ({
  page,
}) => {
  const ui = await fixture(page);
  let attempt = 0;
  let release!: () => void;
  const message = {
    id: "accepted-question",
    conversationId: "conversation-1",
    role: "user" as const,
    text: "Preserve the matched control.",
    createdAt: "2026-09-28T10:00:00Z",
    delivery: "pending" as const,
  };
  ui.handle(async (request) => {
    if (!request.path.endsWith("/messages")) return;
    if (!attempt++)
      return { status: 503, body: { error: "Conversation temporarily unavailable." } };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { body: { items: [message] } };
  });
  await page.goto("/");
  await expect(
    page.getByRole("alert").filter({ hasText: "Conversation temporarily unavailable" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry loading messages", exact: true }).click();
  await expect.poll(() => attempt).toBe(2);
  await ui.emit({ type: "message", message: { ...message, delivery: "delivered" } });
  release();
  await expect(page.getByText(message.text, { exact: true })).toHaveCount(1);
  await expect(page.getByText("Saved for your next message", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry loading messages", exact: true }),
  ).toHaveCount(0);
});
