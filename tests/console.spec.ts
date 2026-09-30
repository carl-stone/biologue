import { test, expect } from "@playwright/test";
import { fixture } from "./ui-fixture.ts";
import type { Execution } from "../packages/protocol/src/index.ts";

for (const language of ["python", "r"] as const) {
  test(`${language} console shows exact editor and agent code, including silent and failed runs`, async ({
    page,
  }) => {
    const code =
      language === "python"
        ? "values = [2, 4, 6]\nprint(sum(values))"
        : "values <- c(2, 4, 6)\nprint(sum(values))";
    const base: Execution = {
      id: "from-editor",
      actor: "human",
      purpose: "analysis",
      language,
      status: "succeeded",
      code,
      codePreview: code.split("\n")[0],
      codeHash: "fixture",
      createdAt: "2026-09-30T10:00:00Z",
      document: {
        path: language === "r" ? "analysis.R" : "analysis.py",
        version: 1,
        selection: { from: 0, to: code.length },
      },
    };
    const ui = await fixture(page, {
      executions: [
        base,
        {
          ...base,
          id: "from-agent",
          actor: "agent",
          document: undefined,
          code: "missing_name",
          status: "failed",
          error: "NameError: missing_name is not defined",
        },
      ],
    });
    await page.goto("/");
    await page.getByRole("combobox", { name: "Session language" }).selectOption(language);
    await expect(page.locator("#execution-from-editor .console-code")).toContainText(code);
    await expect(page.locator("#execution-from-agent .console-code")).toContainText("missing_name");
    await expect(page.locator("#execution-from-agent")).toContainText("Biologue");
    await expect(page.locator("#execution-from-agent .output-error")).toContainText("NameError");
    const input = page.getByRole("textbox", { name: "Console code", exact: true });
    await input.press("ArrowUp");
    await expect(input).toHaveValue(code);
    await page.getByRole("button", { name: "Clear console", exact: true }).click();
    await expect(page.locator(".execution")).toHaveCount(0);
    await page.getByLabel("Console options", { exact: true }).click();
    await page.getByRole("button", { name: "Show cleared output", exact: true }).click();
    await expect(page.locator(".execution")).toHaveCount(2);
    expect(
      ui.requests.filter((req) => req.method !== "GET" && req.path.startsWith("/executions")),
    ).toHaveLength(0);
  });
}
