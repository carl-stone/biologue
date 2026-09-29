import { test, expect } from "@playwright/test";

test("a scientist can run code, reuse objects, inspect data, and retain context and drafts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What are you trying to understand?" }),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Synthetic measurements");
  await page.screenshot({ path: "test-results/workspace-empty.png", fullPage: true });
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.getByRole("img", { name: /^Plot from human/ })).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("textbox", { name: "Console code", exact: true })
    .fill("print(len(measurements))");
  await page.getByRole("button", { name: "Run console code" }).click();
  await expect(page.locator(".execution").last().locator(".output-text")).toHaveText("6\n");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.locator(".object code", { hasText: "measurements" })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Preview in Data" }).click();
  await expect(page.getByRole("columnheader", { name: "signal", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "2.4", exact: true })).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy table", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("sample\tsignal\nA\t2.4");
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Research context", exact: true })
    .fill("These measurements are synthetic. No biological interpretation has been established.");
  await page.getByRole("button", { name: "Save context", exact: true }).click();
  await expect(page.getByText("Version 1 · authored by you")).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n# A retained unsaved buffer\n");
  await expect(page.locator(".save-file .unsaved-dot")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/snapshot")).json()).documents.find(
          (doc: { path: string }) => doc.path === "analysis.py",
        ).version,
    )
    .toBeGreaterThan(1);
  await expect(page.getByText("The working document changed.", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("A retained unsaved buffer");
  await page.getByRole("button", { name: "Focus Research context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Research context", exact: true })).toHaveValue(
    "These measurements are synthetic. No biological interpretation has been established.",
  );
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".dirty-dot")).toHaveCount(0);
  await page.getByRole("button", { name: "Focus Plots", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download figure", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^biologue-python-figure-.*\.png$/);
  await page.getByRole("button", { name: "Focus Environment", exact: true }).click();
  await page.getByRole("textbox", { name: "Filter objects", exact: true }).fill("no_such_object");
  await expect(page.getByText("No matching objects", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  if (await page.getByRole("button", { name: "Dismiss notification" }).count())
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.mouse.move(800, 30);
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("textbox", { name: "File name", exact: true }).fill("selection_test.py");
  await page.getByRole("dialog").getByRole("button", { name: "Save file", exact: true }).click();
  const selectedEditor = page.getByRole("textbox", {
    name: "Code editor: selection_test.py",
    exact: true,
  });
  const selectedCode = "print(len(measurements))";
  await selectedEditor.fill(`${selectedCode}\nraise RuntimeError('not selected')\n`);
  await selectedEditor.press("ControlOrMeta+Home");
  await selectedEditor.press("Shift+End");
  const count = await page.locator(".execution").count();
  await selectedEditor.press("ControlOrMeta+Enter");
  await expect(page.locator(".execution")).toHaveCount(count + 1);
  await expect(page.locator(".execution").last().locator(".output-text")).toHaveText("6\n");
  await page.locator(".execution").last().locator(":scope > details > summary").click();
  await expect(page.locator(".execution").last().locator(".console-code")).toContainText(
    selectedCode,
  );
  await page.locator(".execution").last().locator(".provenance > summary").click();
  await expect(page.locator(".execution").last()).toContainText("selection_test.py · revision");
  await expect(page.locator(".execution").last()).toContainText("selection");
  expect(errors).toEqual([]);
});
