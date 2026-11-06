import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_FULFILLMENT_SYNC !== "on", "Run with E2E_FULFILLMENT_SYNC=on.");

test("with the workflow on, the approved order reaches the warehouse before the snapshot", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByTestId("fulfillment-list")).toContainText("No shipment lines", { timeout: 15_000 });
  await page.getByTestId("create-order").click();
  const order = page.locator("[data-testid^='order-']");
  await expect(order).toHaveCount(1, { timeout: 20_000 });
  const orderNumber = (await order.getAttribute("data-testid"))!.replace("order-", "");
  const schedule = await (await page.request.get("/api/lab")).json();
  const nextSnapshot = schedule.schedule.nextShipmentSnapshotAt as number;
  const approvedAt = Date.now();
  await page.getByTestId(`approve-${orderNumber}`).click();
  await expect(page.getByTestId("fulfillment-list")).toContainText(`Order ${orderNumber}`, { timeout: 40_000 });
  const visibleAt = Date.now();
  expect(visibleAt, "must arrive before the next scheduled snapshot").toBeLessThan(nextSnapshot);
  await expect(page.getByTestId(`sync-${orderNumber}`)).toContainText("DeliveryVerified", { timeout: 10_000 });
  console.log(`approve to visible: ${visibleAt - approvedAt}ms`);
});
