import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

async function resetAndApprove(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByTestId("sales-list")).toContainText("No sales orders", { timeout: 15_000 });
  await page.getByTestId("create-order").click();
  const order = page.locator("[data-testid^='order-']");
  await expect(order).toHaveCount(1, { timeout: 20_000 });
  const orderNumber = (await order.getAttribute("data-testid"))!.replace("order-", "");
  const approvedAt = Date.now();
  await page.getByTestId(`approve-${orderNumber}`).click();
  await expect(page.getByTestId("gap-banner")).toBeVisible({ timeout: 20_000 });
  const gapAt = Date.now();
  await expect(page.getByTestId("fulfillment-list")).not.toContainText(`Order ${orderNumber}`);
  return { orderNumber, approvedAt, gapAt };
}

test.skip(process.env.E2E_FULFILLMENT_SYNC === "on", "Baseline runs with the workflow off.");

test("warehouse stays empty after oracle is ready until the snapshot", async ({ page }) => {
  mkdirSync("artifacts/baseline/latest", { recursive: true });
  const browserUrls: string[] = [];
  page.on("request", (request) => browserUrls.push(request.url()));
  const { orderNumber, approvedAt, gapAt } = await resetAndApprove(page);
  await page.screenshot({ path: "artifacts/baseline/latest/gap.png", fullPage: true });
  const lab = await (await page.request.get("/api/lab")).json();
  const fulfillmentReads = (lab.traces as { source: string; target: string; url: string }[]).filter((trace) => trace.source === "fulfillment-read");
  expect(fulfillmentReads.length).toBeGreaterThan(0);
  expect(fulfillmentReads.every((trace) => trace.target === "foundry" && trace.url.includes("ShipmentLine"))).toBe(true);
  expect(browserUrls.some((url) => url.includes("/api/fulfillment"))).toBe(true);
  const appOrigin = new URL(page.url()).origin;
  expect(browserUrls.every((url) => url.startsWith(appOrigin))).toBe(true);
  await expect(page.getByTestId("fulfillment-list")).toContainText(`Order ${orderNumber}`, { timeout: 90_000 });
  const visibleAt = Date.now();
  await page.screenshot({ path: "artifacts/baseline/latest/visible.png", fullPage: true });
  writeFileSync(
    "artifacts/baseline/latest/browser-timings.json",
    JSON.stringify(
      {
        gapAfterApproveMs: gapAt - approvedAt,
        visibleAfterApproveMs: visibleAt - approvedAt,
        snapshotWaitAfterGapMs: visibleAt - gapAt,
      },
      null,
      2,
    ),
  );
  expect(gapAt - approvedAt).toBeGreaterThan(2_000);
  expect(visibleAt - gapAt).toBeGreaterThan(10_000);
});
