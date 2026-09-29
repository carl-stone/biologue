/** Browser review against scripts/ui-server.mjs. Synthetic states; no model calls. */
import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixture, initialSnapshot } from "../../tests/ui-fixture.ts";
import type { Execution } from "../../packages/protocol/src/index.ts";

const directory = resolve(process.env.UI_REVIEW_DIR || "test-results/ui-review");
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const findings: object[] = [];
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  findings.push({
    name,
    ...(await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll<HTMLElement>("button, .pane-toolbar, .research")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          // Dockview keeps the other groups mounted at zero width while maximized.
          const group = el.closest(".dv-groupview");
          return (
            el.checkVisibility() &&
            (!group || group.clientWidth > 20) &&
            rect.width > 0 &&
            el.scrollWidth > el.clientWidth + 3
          );
        })
        .map((el) => ({ text: el.innerText.slice(0, 100), class: el.className })),
    }))),
  });
}
async function open(page: Page, panel: string) {
  await page.getByRole("button", { name: `Open ${panel}`, exact: true }).click();
}
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
try {
  const empty = await newPage();
  await fixture(empty);
  await empty.goto("http://127.0.0.1:5174");
  await expect(
    empty.getByRole("heading", { name: "What are you trying to understand?" }),
  ).toBeVisible();
  await capture(empty, "01-empty-workspace");
  await empty.getByRole("button", { name: "Arrange panels", exact: true }).click();
  await capture(empty, "01-arrange-panels");
  await empty.getByRole("button", { name: "Done arranging panels", exact: true }).click();
  for (const width of [900, 1220]) {
    await empty.setViewportSize({ width, height: 768 });
    await capture(empty, `01-${width}-workspace`);
    await empty.getByRole("button", { name: "Arrange panels", exact: true }).click();
    await capture(empty, `01-${width}-arrange-panels`);
    await empty.getByRole("button", { name: "Done arranging panels", exact: true }).click();
  }
  await empty.setViewportSize({ width: 1440, height: 960 });
  for (const panel of ["Research context", "Agent settings", "Data"]) {
    await open(empty, panel);
    if (panel === "Agent settings") await empty.locator(".model-setup summary").click();
    await capture(empty, `02-empty-${panel.replaceAll(" ", "-")}`);
  }
  await empty.getByRole("button", { name: "Workspace help", exact: true }).click();
  await capture(empty, "03-help");
  await empty.keyboard.press("Escape");
  await open(empty, "Conversation");
  await empty.getByRole("button", { name: "New conversation", exact: true }).click();
  await capture(empty, "04-new-conversation");
  await empty.keyboard.press("Escape");

  // Exercise the real editor, runtime, plots, environment, and data viewer too.
  const live = await newPage();
  await live.goto("http://127.0.0.1:5174");
  await expect(live.getByRole("button", { name: "Reset panel layout" })).toBeEnabled();
  await live.getByRole("button", { name: "Reset panel layout" }).click();
  await expect(live.locator(".cm-content")).toContainText("Synthetic measurements");
  await live.getByRole("button", { name: "Run file", exact: true }).click();
  await expect(live.getByRole("img", { name: /^Plot from human/ })).toBeVisible({ timeout: 45000 });
  await live.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(live.locator(".object code", { hasText: "measurements" })).toBeVisible({
    timeout: 20000,
  });
  await capture(live, "05-live-workspace");
  await live.getByRole("button", { name: "Preview in Data" }).click();
  await expect(live.getByRole("cell", { name: "2.4", exact: true })).toBeVisible();
  await capture(live, "06-live-data");
  await live.getByRole("button", { name: "Expand data", exact: true }).click();
  await capture(live, "07-data-focused");
  await live.keyboard.press("Escape");
  for (const [width, height] of [
    [1024, 768],
    [390, 844],
  ]) {
    await live.setViewportSize({ width, height });
    for (const panel of ["Environment", "Data", "Plots", "Console"]) {
      await open(live, panel);
      await capture(live, `07-live-${width}-${panel}`);
    }
  }
  await live.close();

  const page = await newPage();
  const createdAt = "2026-09-29T10:12:00Z";
  const execution: Execution = {
    id: "review-execution",
    actor: "human",
    language: "python",
    purpose: "analysis",
    status: "failed",
    createdAt,
    code: "measurements.groupby('condition').mean()",
    codePreview: "measurements.groupby('condition').mean()",
    codeHash: "review-code",
    error: "KeyError: 'condition'",
    startedAt: createdAt,
    finishedAt: "2026-09-29T10:12:01Z",
  };
  const ui = await fixture(page, {
    project: "/research/macrophage-response",
    agent: { enabled: true, provider: "openai-codex", model: "gpt-6-luna" },
    researchContext: {
      text: "Question\nDoes treatment change macrophage morphology?\n\nObserved\nCells round up after treatment. Two experiments on different days.\n\nAssumption to check\nImaging exposure may differ between batches.",
      version: 3,
      updatedAt: createdAt,
    },
    runs: [
      {
        id: "review-run",
        conversationId: "conversation-1",
        status: "running",
        contextVersion: 3,
        startedAt: createdAt,
      },
    ],
    conversations: [
      {
        id: "conversation-1",
        title: "Macrophage morphology across two experimental batches",
        createdAt,
      },
    ],
    messages: [
      {
        id: "user",
        sequence: 1,
        conversationId: "conversation-1",
        role: "user",
        text: "The treated cells look rounder. Could this be a batch effect?",
        createdAt,
      },
      {
        id: "assistant",
        sequence: 2,
        conversationId: "conversation-1",
        role: "assistant",
        text: "The images suggest a change in morphology, but that alone doesn’t establish a treatment effect.\n\n**First, check the experimental design.** Were treated and control samples imaged on both days?\n\n| Batch | Control | Treated |\n| --- | ---: | ---: |\n| Day 1 | 6 | 6 |\n| Day 2 | 6 | 6 |\n\n```python\nsummary = measurements.groupby(['batch', 'condition']).agg(mean_area=('area', 'mean'))\n```\n\nI can summarize each batch separately before we choose a model.",
        createdAt,
      },
    ],
    executions: [execution],
    permissions: [
      {
        id: "review-permission",
        runId: "review-run",
        tool: "execute_code",
        language: "python",
        description:
          "Summarize cell area by batch and condition so we can see whether the pattern is consistent across imaging days.",
        code: "summary = measurements.groupby(['batch', 'condition']).agg(\n    mean_area=('area', 'mean'),\n    cells=('area', 'size'),\n)\nprint(summary)",
        createdAt,
      },
    ],
  });
  await page.goto("http://127.0.0.1:5174");
  await expect(page.getByText("First, check the experimental design.")).toBeVisible();
  await open(page, "Agent settings");
  await open(page, "Conversation");
  await capture(page, "08-permission-and-conversation");
  await page.getByRole("button", { name: "Expand proposed code" }).click();
  await capture(page, "08-expanded-code-review");
  await page.keyboard.press("Escape");
  await open(page, "Agent settings");
  await page.getByRole("button", { name: "Expand panel" }).click();
  await capture(page, "09-agent-focused");
  await page.keyboard.press("Escape");
  await open(page, "Research context");
  await page.getByText("What belongs here?", { exact: true }).click();
  await capture(page, "10-research-notes");
  await open(page, "Console");
  await page.locator(".execution > details > summary").first().click();
  await capture(page, "11-execution-error");
  await ui.connect(false);
  await capture(page, "12-offline");
  await ui.connect(true);
  for (const [width, height] of [
    [1024, 768],
    [760, 650],
    [640, 760],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const panel of [
      "Conversation",
      "Editor",
      "Research context",
      "Agent settings",
      "Environment",
      "Data",
      "Console",
      "Plots",
    ]) {
      await open(page, panel);
      await capture(page, `13-${width}-${panel.replaceAll(" ", "-")}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await open(page, "Editor");
  await page
    .getByRole("textbox", { name: "Code editor: analysis.py", exact: true })
    .fill("print('my local work')");
  await ui.emit({
    type: "document",
    document: {
      ...initialSnapshot.documents[0],
      content: "print('edited elsewhere')",
      version: 50,
    },
  });
  await capture(page, "14-document-conflict");
  await open(page, "Research context");
  await page
    .getByRole("textbox", { name: "Research context", exact: true })
    .fill("A local observation in progress.");
  await ui.emit({
    type: "context",
    context: { text: "Notes updated in another window.", version: 4, updatedAt: createdAt },
  });
  await capture(page, "15-context-conflict");
  await page.getByRole("button", { name: "Expand panel", exact: true }).click();
  await page.getByText("Review saved notes · version 4").click();
  await capture(page, "15-context-conflict-expanded");
  await page.keyboard.press("Escape");
  const notRun: Execution = {
    ...execution,
    id: "not-run",
    status: "not_executed",
    startedAt: undefined,
    finishedAt: undefined,
    error:
      "The measurements changed after your last inspection. Review the updated data before retrying.",
  };
  ui.handle(async (request) =>
    request.path === "/executions/not-run" ? { body: notRun } : undefined,
  );
  await ui.emit({
    type: "execution",
    execution: notRun,
  });
  await open(page, "Console");
  await page.locator("#execution-not-run > details > summary").click();
  await page.getByRole("button", { name: "Expand panel", exact: true }).click();
  await page.locator("#execution-not-run").scrollIntoViewIfNeeded();
  await capture(page, "16-code-not-run");
  await open(page, "Conversation");
  ui.handle(async (request) =>
    request.path === "/permissions/review-permission"
      ? { status: 503, body: { error: "Couldn’t save this decision. Try again." } }
      : undefined,
  );
  await page.getByRole("button", { name: "Expand proposed code", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run once", exact: true }).click();
  await capture(page, "16-approval-error");
  await page.close();
  await empty.close();

  const resources = await newPage();
  const table = {
    ...execution,
    id: "table",
    status: "succeeded" as const,
    purpose: "inspection" as const,
    inspection: "table" as const,
  };
  const inventory = { ...table, id: "inventory", inspection: "environment" as const };
  const resourceUi = await fixture(resources, { executions: [table, inventory] });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  resourceUi.handle(async (request) => {
    if (
      !["/executions/table/result", "/executions/inventory/result", "/outputs"].includes(
        request.path,
      )
    )
      return;
    await wait;
    if (fail) return { status: 503, body: { error: "Stored result temporarily unavailable." } };
    return {
      body: request.path.includes("/table/")
        ? { kind: "table", columns: ["condition", "area"], rows: [["control", 2.4]] }
        : request.path.includes("/inventory/")
          ? {
              kind: "environment",
              rows: [{ name: "measurements", type: "DataFrame", preview: "24 rows × 4 columns" }],
              next: 100,
            }
          : { items: [] },
    };
  });
  await resources.goto("http://127.0.0.1:5174");
  for (const panel of ["Data", "Environment", "Plots"]) {
    await open(resources, panel);
    await capture(resources, `17-loading-${panel}`);
  }
  release();
  for (const panel of ["Data", "Environment", "Plots"]) {
    await open(resources, panel);
    const pane = resources.locator(
      panel === "Data" ? ".data-pane" : panel === "Plots" ? ".plots" : ".environment",
    );
    await expect(pane.getByText(/^Couldn’t load/)).toBeVisible();
    await capture(resources, `18-failed-${panel}`);
  }
  fail = false;
  for (const panel of ["Data", "Environment", "Plots"]) {
    await open(resources, panel);
    const pane = resources.locator(
      panel === "Data" ? ".data-pane" : panel === "Plots" ? ".plots" : ".environment",
    );
    await pane.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(pane.getByText(/^Couldn’t load/)).toHaveCount(0);
  }
  await resources.setViewportSize({ width: 390, height: 844 });
  await open(resources, "Environment");
  await capture(resources, "19-small-object-pagination");
  await resources.close();

  const noFiles = await newPage();
  await fixture(noFiles, { files: [], documents: [] });
  await noFiles.goto("http://127.0.0.1:5174");
  await expect(noFiles.locator(".editor-pane")).toBeVisible();
  await capture(noFiles, "20-no-files");
  await noFiles.close();
} finally {
  await browser.close();
  writeFileSync(`${directory}/findings.json`, JSON.stringify({ errors, findings }, null, 2));
}
console.log(`UI review: ${directory}; ${errors.length} browser errors`);
if (errors.length) process.exitCode = 1;
