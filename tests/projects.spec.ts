import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

test("folder picker switches scoped APIs and retains unsaved work on return", async ({ page }) => {
  const initial = await (await page.request.get("/api/snapshot")).json();
  const folder = join(initial.project, "second-project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "other.py"), "print('second project')\n");
  await page.goto("/");
  await expect(page.locator(".cm-content")).toBeVisible();
  const baseline = await (await page.request.get("/api/snapshot")).json();
  await page.getByRole("button", { name: "Open project folder", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "second-project", exact: true })
    .click();
  await page.screenshot({ path: "test-results/cleanup-folder-picker.png" });
  await page.getByRole("dialog").getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(page).toHaveURL(/\?project=[a-f0-9]{24}/);
  const childUrl = page.url();
  const editor = page.getByRole("textbox", { name: "Code editor: other.py", exact: true });
  await expect(editor).toContainText("second project");
  await editor.fill("print('unsaved second project')");
  await page.getByRole("button", { name: "Open project folder", exact: true }).click();
  await page.getByRole("button", { name: "Parent folder", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue(
    initial.project,
  );
  await page.getByRole("dialog").getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(page).not.toHaveURL(/\?project=/);
  await expect(
    page.getByRole("button", { name: "Open project folder", exact: true }),
  ).toContainText(basename(initial.project));
  const after = await (await page.request.get("/api/snapshot")).json();
  expect(after.documents).toEqual(baseline.documents);
  await page.goto(childUrl);
  await expect(editor).toContainText("unsaved second project");
  await page.getByRole("button", { name: "Focus Environment", exact: true }).click();
  await expect(page.locator(".error-banner")).toHaveCount(0);
});
