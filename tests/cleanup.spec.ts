import { test, expect } from "@playwright/test";
import { fixture } from "./ui-fixture.ts";

test("Enter sends, Shift+Enter inserts a line, and IME Enter does not send", async ({ page }) => {
  const ui = await fixture(page, {
    agent: { enabled: true, model: "gpt-6-luna", provider: "openai-codex" },
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await input.fill("First line");
  await input.press("Shift+Enter");
  await input.press("a");
  await expect(input).toHaveValue("First line\na");
  await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    ),
  );
  expect(ui.requests.filter((req) => req.path === "/agent/runs")).toHaveLength(0);
  await input.press("Enter");
  await expect.poll(() => ui.requests.filter((req) => req.path === "/agent/runs").length).toBe(1);
  expect(ui.requests.find((req) => req.path === "/agent/runs")!.body.text).toBe("First line\na");
  await expect(input).toHaveValue("");
  await expect(page.locator(".context-link, .conversation-empty, .conversation-hint")).toHaveCount(
    0,
  );
});

test("model and thinking selections use the available catalog and update the composer", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent: { enabled: true, provider: "openai-codex", model: "gpt-6-luna", thinking: "medium" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("openai-codex/gpt-6-astra");
  await expect(page.getByRole("button", { name: "Agent settings", exact: true })).toContainText(
    "gpt-6-astra",
  );
  await page.getByRole("combobox", { name: "Thinking level", exact: true }).selectOption("max");
  await expect.poll(() => ui.state.conversations[0].settings?.thinking).toBe("max");
  await page.screenshot({ path: "test-results/cleanup-model-settings.png" });
});

test("Data opens a named table directly, with no Environment detour", async ({ page }) => {
  const ui = await fixture(page);
  ui.handle(async (req) =>
    req.path === "/table"
      ? {
          body: {
            id: "table-preview",
            actor: "human",
            purpose: "inspection",
            inspection: "table",
            language: "python",
            status: "queued",
            createdAt: new Date().toISOString(),
          },
        }
      : undefined,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Focus Data", exact: true }).click();
  await page.getByRole("combobox", { name: "Table object", exact: true }).fill("measurements");
  await page.locator(".data-picker").getByRole("button", { name: "Open", exact: true }).click();
  await expect.poll(() => ui.requests.filter((req) => req.path === "/table").length).toBe(1);
  expect(ui.requests.find((req) => req.path === "/table")!.body).toEqual({
    language: "python",
    name: "measurements",
  });
  await expect(page.getByRole("button", { name: "Open environment", exact: true })).toHaveCount(0);
});
