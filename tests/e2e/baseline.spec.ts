import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_FULFILLMENT_SYNC === "on", "Baseline runs with the workflow off.");

test("baseline browser run records the gap and the later visibility", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByTestId("fulfillment-list")).toContainText("No shipment lines", { timeout: 15_000 });
  await page.getByTestId("create-order").click();
  const order = page.locator("[data-testid^='order-']");
  await expect(order).toHaveCount(1, { timeout: 20_000 });
  const orderNumber = (await order.getAttribute("data-testid"))!.replace("order-", "");
  await page.getByTestId(`approve-${orderNumber}`).click();
  await expect(page.getByTestId("gap-banner")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("fulfillment-list")).not.toContainText(`Order ${orderNumber}`);
  await expect(page.getByTestId("fulfillment-list")).toContainText(`Order ${orderNumber}`, { timeout: 90_000 });
});
