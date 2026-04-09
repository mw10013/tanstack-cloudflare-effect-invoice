import { expect, test } from "@playwright/test";

import { scopeEmail } from "./utils";

const email = scopeEmail("debug-create-invoice@e2e.com");

test.beforeAll(async ({ request }) => {
  await request.post(`/api/e2e/delete/user/${email}`);
});

test("login and create invoice", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
  await page.getByRole("link", { name: /magic-link/ }).click();
  await page.waitForURL(/\/app\//);

  console.log("Logged in, URL:", page.url());
  await page.screenshot({ path: "test-results/debug-1-logged-in.png" });

  await page.getByRole("link", { name: /^Invoices$/ }).click();
  await page.waitForURL(/\/invoices/);
  console.log("Navigated to invoices, URL:", page.url());
  await page.screenshot({ path: "test-results/debug-2-invoices.png" });

  const hasError = await page.getByText("Something went wrong").isVisible().catch(() => false);
  if (hasError) {
    console.log("ERROR on page:", await page.locator("main").textContent());

    await page.goto(page.url());
    await page.waitForLoadState("domcontentloaded");
    await page.screenshot({ path: "test-results/debug-3-hard-reload.png" });
    console.log("After hard reload - error?", await page.getByText("Something went wrong").isVisible().catch(() => false));
  }

  await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "New Invoice" }).click();
  await page.waitForURL(/\/invoices\/[^/?]+$/, { timeout: 15_000 });
  console.log("Created invoice, URL:", page.url());
  await page.screenshot({ path: "test-results/debug-4-created.png" });
});
