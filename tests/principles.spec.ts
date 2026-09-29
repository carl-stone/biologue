import { test, expect } from "@playwright/test";
import type {
  PermissionRequest,
  PermissionDecisionSummary,
} from "../packages/protocol/src/index.ts";
import { fixture } from "./ui-fixture.ts";

const request: PermissionRequest = {
  id: "request-1",
  runId: "run-1",
  conversationId: "conversation-2",
  tool: "execute_code",
  language: "python",
  description: "Compare donors separately before pooling the measurements.",
  code: "print(measurements.groupby('donor').mean())",
  createdAt: "2026-09-29T10:00:01Z",
};
const run = {
  id: "run-1",
  conversationId: "conversation-2",
  status: "running" as const,
  contextVersion: 1,
  startedAt: "2026-09-29T10:00:00Z",
};
function resolution(
  value: PermissionRequest,
  decision: PermissionDecisionSummary["decision"],
  feedback?: string,
): PermissionDecisionSummary {
  const { code: _code, before: _before, ...summary } = value;
  return {
    ...summary,
    decision,
    resolvedAt: "2026-09-29T10:00:02Z",
    ...(feedback ? { feedback } : {}),
  };
}

test("a review notification opens the correct conversation and the decision remains there after reload", async ({
  page,
}) => {
  const ui = await fixture(page, {
    agent: { enabled: true, model: "test" },
    permissions: [request],
    runs: [run],
    messages: [
      {
        id: "proposal",
        conversationId: "conversation-2",
        role: "assistant",
        runId: run.id,
        text: "First check whether each donor contributes to both groups.",
        createdAt: run.startedAt,
      },
    ],
  });
  ui.handle(async (req) => {
    if (req.path === `/permissions/${request.id}` && req.method === "POST") {
      await ui.emit({
        type: "permission-resolved",
        id: request.id,
        resolution: resolution(request, "allow"),
      });
      return { body: { ok: true } };
    }
  });
  await page.goto("/");
  await expect(page.locator(".permission-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await expect(page.locator(".controls .permission-card")).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 760 });
  await page.getByRole("button", { name: "1 request awaiting review", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue(
    "conversation-2",
  );
  await expect(page.locator("#permission-request-1")).toBeFocused();
  await expect(page.locator(".chat .permission-card")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator(".chat-messages > .message")).toContainText("First check whether");
  await page.screenshot({ path: "test-results/principles-inline-review.png" });
  await page.getByRole("button", { name: "Expand panel", exact: true }).click();
  await expect
    .poll(() => page.locator(".conversation-request").evaluate((el) => el.clientWidth))
    .toBeLessThanOrEqual(720);
  await page.screenshot({ path: "test-results/principles-expanded-conversation.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Run once", exact: true }).click();
  await expect(page.locator(".permission-card")).toHaveCount(0);
  await expect(page.locator(".permission-decision summary")).toHaveText(
    "Approved · Run Python code",
  );
  expect(
    ui.requests.filter((req) => req.path.startsWith("/permissions/") && req.method === "GET"),
  ).toHaveLength(0);
  await page.reload();
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption("conversation-2");
  await expect(page.locator(".permission-decision summary")).toHaveText(
    "Approved · Run Python code",
  );
  await page.locator(".permission-decision summary").click();
  await expect(page.locator(".permission-decision pre")).toHaveText(request.code!);
  await expect(page.locator(".permission-decision")).toContainText("This records your approval.");
  await page.screenshot({ path: "test-results/principles-decision-history.png" });
  expect(
    ui.requests.filter((req) => req.path === `/permissions/${request.id}` && req.method === "POST"),
  ).toHaveLength(1);
});

test("requesting changes keeps exact document versions and feedback together, including after a failed submission", async ({
  page,
}) => {
  const edit: PermissionRequest = {
    ...request,
    conversationId: "conversation-1",
    tool: "edit_document",
    language: undefined,
    document: { path: "analysis.py", version: 3 },
    before: "group_by(donor, condition)",
    code: "group_by(condition)",
    description: "Update the shared working document. Save writes it to the project file.",
  };
  const ui = await fixture(page, {
    permissions: [edit],
    runs: [{ ...run, conversationId: "conversation-1" }],
    agent: { enabled: true, model: "test" },
  });
  let fail = true;
  ui.handle(async (req) => {
    if (req.path === `/permissions/${edit.id}` && req.method === "POST") {
      if (fail) return { status: 503, body: { error: "Could not send changes. Try again." } };
      await ui.emit({
        type: "permission-resolved",
        id: edit.id,
        resolution: resolution(edit, "deny", req.body.feedback),
      });
      return { body: { ok: true } };
    }
  });
  await page.goto("/");
  await expect(page.locator(".proposal-target")).toContainText("analysis.py · revision 3");
  await expect(page.locator(".permission-card pre")).toHaveText([edit.before!, edit.code!]);
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  const feedback = "The donor pairing must remain in the analysis.";
  await page
    .getByRole("textbox", { name: "What should Biologue change?", exact: true })
    .fill(feedback);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Focus Conversation", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "What should Biologue change?", exact: true }),
  ).toHaveValue(feedback);
  await page.getByRole("button", { name: "Send changes", exact: true }).click();
  await expect(page.locator(".permission-card [role=alert]")).toHaveText(
    "Could not send changes. Try again.",
  );
  await page.screenshot({ path: "test-results/principles-feedback-recovery.png" });
  await expect(
    page.getByRole("textbox", { name: "What should Biologue change?", exact: true }),
  ).toHaveValue(feedback);
  fail = false;
  await page.getByRole("button", { name: "Send changes", exact: true }).click();
  await page.locator(".permission-decision summary").click();
  await expect(page.locator(".permission-decision")).toContainText("Changes requested");
  await expect(page.locator(".permission-decision blockquote")).toContainText(feedback);
  expect(
    ui.requests
      .filter((req) => req.path === `/permissions/${edit.id}` && req.method === "POST")
      .at(-1)!.body,
  ).toEqual({ allow: false, feedback });
  expect(
    ui.requests.filter(
      (req) => req.path === "/executions" || (req.path === "/documents" && req.method === "PUT"),
    ),
  ).toHaveLength(0);
});

test("new requests preserve reading and typing until the scientist explicitly opens review", async ({
  page,
}) => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `message-${i}`,
    conversationId: "conversation-1",
    role: "assistant" as const,
    text: `Discussion ${i}.\n\n${"Keep observations separate from interpretation. ".repeat(7)}`,
    createdAt: run.startedAt,
  }));
  const ui = await fixture(page, {
    messages,
    runs: [{ ...run, conversationId: "conversation-1" }],
    agent: { enabled: true, model: "test" },
  });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Biologue", exact: true });
  await composer.fill("These donors are paired.");
  await page.locator(".chat-messages").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await ui.emit({ type: "permission", request: { ...request, conversationId: "conversation-1" } });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("These donors are paired.");
  await expect.poll(() => page.locator(".chat-messages").evaluate((el) => el.scrollTop)).toBe(0);
  const jump = await page
    .getByRole("button", { name: "Latest messages", exact: true })
    .boundingBox();
  const transcript = await page.locator(".chat-messages").boundingBox();
  expect(jump!.y).toBeGreaterThanOrEqual(transcript!.y + transcript!.height);
  await expect(page.locator(".composer-bottom")).toContainText("Sent after your decision");
  await page.getByRole("button", { name: "Review request", exact: true }).click();
  await expect(page.locator("#permission-request-1")).toBeFocused();
  await expect(page.getByRole("button", { name: "Run once", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 1024, height: 768 });
  const send = page.getByRole("button", { name: "Send context", exact: true });
  await expect(send).toHaveText("Queue message");
  await expect
    .poll(() => send.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run once", exact: true })).toBeInViewport();
});
