import type { Page } from "@playwright/test";

import { invariant } from "@epic-web/invariant";
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { scopeEmail } from "./utils";

const invoiceFileName = "cloudflare-invoice-2026-03-04-redacted.pdf";
const invoiceListName = invoiceFileName.replace(/\.pdf$/, "");
const invoiceFilePath = fileURLToPath(
  new URL(`../invoices/${invoiceFileName}`, import.meta.url),
);

test.describe("invoice upload", () => {
  const email = scopeEmail("upload@e2e.com");

  test.beforeAll(async ({ request }) => {
    await request.post(`/api/e2e/delete/user/${email}`);
  });

  test("uploads an invoice to ready state", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    invariant(baseURL, "Missing baseURL");
    const pom = createUploadPom({ page, baseURL });

    await pom.login({ email });
    await pom.goToInvoices();
    await pom.uploadInvoice();
    await pom.expectInvoiceReady();
  });
});

const createUploadPom = ({
  page,
  baseURL,
}: {
  readonly page: Page;
  readonly baseURL: string;
}) => {
  invariant(baseURL.endsWith("/"), "baseURL must have a trailing slash");

  const invoiceRow = page.locator("tbody tr").filter({ hasText: invoiceListName });

  const login = async ({ email }: { email: string }) => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Send magic link" }).click();
    await page.getByRole("link", { name: /magic-link/ }).click();
    await page.waitForURL(/\/app\//);
  };

  const goToInvoices = async () => {
    await page.getByRole("link", { name: /^Invoices$/ }).click();
    await page.waitForURL(/\/invoices/);
  };

  const uploadInvoice = async () => {
    await page.locator('input[type="file"]').setInputFiles(invoiceFilePath);
    await page.getByRole("button", { name: /^Upload$/ }).click();
    await expect(invoiceRow).toBeVisible();
  };

  const expectInvoiceReady = async () => {
    await expect(invoiceRow).toContainText("ready", { timeout: 90_000 });
    await expect(invoiceRow).not.toContainText("error");
    await expect(page.getByRole("link", { name: "Edit invoice" })).toBeVisible();
  };

  return {
    login,
    goToInvoices,
    uploadInvoice,
    expectInvoiceReady,
  };
};
