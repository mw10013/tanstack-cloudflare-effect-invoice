import type { Locator, Page } from "@playwright/test";

import { invariant } from "@epic-web/invariant";
import { expect, test } from "@playwright/test";

import { scopeEmail } from "./utils";

const invoiceData = {
  name: "April 2026 Retainer",
  invoiceNumber: "INV-2026-04-001",
  invoiceDate: "2026-04-06",
  dueDate: "2026-04-20",
  currency: "USD",
  vendorName: "Northwind Studio",
  vendorEmail: "billing@northwind.studio",
  vendorAddress: "123 Market Street, Suite 400, San Francisco, CA 94105",
  billToName: "Acme Corp",
  billToEmail: "ap@acme.example",
  billToAddress: "500 Howard Street, Floor 9, San Francisco, CA 94105",
  subtotal: "$2,100.00",
  tax: "$210.00",
  total: "$2,310.00",
  amountDue: "$2,310.00",
  invoiceItems: [
    {
      description: "Product design sprint",
      quantity: "10",
      unitPrice: "$200.00",
      amount: "$2,000.00",
      period: "Apr 1, 2026 - Apr 5, 2026",
    },
    {
      description: "Workshop facilitation",
      quantity: "1",
      unitPrice: "$100.00",
      amount: "$100.00",
      period: "Apr 6, 2026",
    },
  ],
} as const;

const getFieldInput = (scope: Page | Locator, label: string) =>
  scope
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::*[@role="group"][1]')
    .getByRole("textbox");

const getSummaryRow = (page: Page, label: string) =>
  page.locator("div.flex.gap-8").filter({
    has: page.getByText(label, { exact: true }),
  });

test.describe("new invoice", () => {
  const email = scopeEmail("new-invoice@e2e.com");

  test.beforeAll(async ({ request }) => {
    await request.post(`/api/e2e/delete/user/${email}`);
  });

  test("creates and verifies a manual invoice", async ({ page, baseURL }) => {
    invariant(baseURL, "Missing baseURL");
    const pom = createNewInvoicePom({ page, baseURL });

    await pom.login({ email });
    await pom.goToInvoices();
    await pom.createInvoice();
    await pom.fillInvoiceForm(invoiceData);
    await pom.saveInvoice();
    await pom.expectInvoiceSelected(invoiceData);
  });
});

const createNewInvoicePom = ({
  page,
  baseURL,
}: {
  readonly page: Page;
  readonly baseURL: string;
}) => {
  invariant(baseURL.endsWith("/"), "baseURL must have a trailing slash");

  let createdInvoiceId = "";

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

  const createInvoice = async () => {
    await page.getByRole("button", { name: "New Invoice" }).click();
    await page.waitForURL(/\/app\/[^/]+\/invoices\/[^/?]+$/);
    createdInvoiceId = page.url().split("/").at(-1) ?? "";
    expect(createdInvoiceId).not.toBe("");
  };

  const fillInvoiceForm = async ({
    name,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency,
    vendorName,
    vendorEmail,
    vendorAddress,
    billToName,
    billToEmail,
    billToAddress,
    subtotal,
    tax,
    total,
    amountDue,
    invoiceItems,
  }: typeof invoiceData) => {
    await getFieldInput(page, "Invoice Name").fill(name);
    await getFieldInput(page, "Invoice Number").fill(invoiceNumber);
    await getFieldInput(page, "Invoice Date").fill(invoiceDate);
    await getFieldInput(page, "Due Date").fill(dueDate);
    await getFieldInput(page, "Currency").fill(currency);
    await getFieldInput(page, "Vendor Name").fill(vendorName);
    await getFieldInput(page, "Vendor Email").fill(vendorEmail);
    await getFieldInput(page, "Vendor Address").fill(vendorAddress);
    await getFieldInput(page, "Bill To Name").fill(billToName);
    await getFieldInput(page, "Bill To Email").fill(billToEmail);
    await getFieldInput(page, "Bill To Address").fill(billToAddress);
    await getFieldInput(page, "Subtotal").fill(subtotal);
    await getFieldInput(page, "Tax").fill(tax);
    await getFieldInput(page, "Total").fill(total);
    await getFieldInput(page, "Amount Due").fill(amountDue);

    for (let index = 0; index < invoiceItems.length; index++) {
      await page.getByRole("button", { name: "Add item" }).click();
      const itemNumber = String(index + 1);
      const itemCard = page
        .locator("div.rounded-lg.border.p-4")
        .filter({ hasText: `Item ${itemNumber}` })
        .first();
      const item = invoiceItems[index];
      await expect(itemCard).toBeVisible();
      await getFieldInput(itemCard, "Description").fill(item.description);
      await getFieldInput(itemCard, "Quantity").fill(item.quantity);
      await getFieldInput(itemCard, "Unit Price").fill(item.unitPrice);
      await getFieldInput(itemCard, "Amount").fill(item.amount);
      await getFieldInput(itemCard, "Period").fill(item.period);
    }
  };

  const saveInvoice = async () => {
    await page.getByRole("button", { name: "Save invoice" }).click();
    await page.waitForURL(/selectedInvoiceId=/);
    const url = new URL(page.url());
    expect(url.searchParams.get("selectedInvoiceId")).toBe(createdInvoiceId);
  };

  const expectInvoiceSelected = async ({
    name,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency,
    vendorName,
    vendorEmail,
    vendorAddress,
    billToName,
    billToEmail,
    billToAddress,
    subtotal,
    tax,
    total,
    amountDue,
    invoiceItems,
  }: typeof invoiceData) => {
    const selectedRow = page
      .locator("tbody tr[data-state='selected']")
      .filter({ hasText: name });

    await expect(selectedRow).toBeVisible();
    await expect(selectedRow).toContainText("ready");

    await expect(page.getByRole("link", { name: "Edit invoice" })).toBeVisible();
    await expect(page.getByText(`Invoice #${invoiceNumber}`)).toBeVisible();
    await expect(page.getByText(`Date: ${invoiceDate}`)).toBeVisible();
    await expect(page.getByText(`Due: ${dueDate}`)).toBeVisible();
    await expect(page.getByText(`Currency: ${currency}`)).toBeVisible();
    await expect(page.getByText(vendorName)).toBeVisible();
    await expect(page.getByText(vendorEmail)).toBeVisible();
    await expect(page.getByText(vendorAddress)).toBeVisible();
    await expect(page.getByText(billToName)).toBeVisible();
    await expect(page.getByText(billToEmail)).toBeVisible();
    await expect(page.getByText(billToAddress)).toBeVisible();
    await expect(getSummaryRow(page, "Subtotal").getByText(subtotal, { exact: true })).toBeVisible();
    await expect(getSummaryRow(page, "Tax").getByText(tax, { exact: true })).toBeVisible();
    await expect(getSummaryRow(page, "Total").getByText(total, { exact: true })).toBeVisible();
    await expect(getSummaryRow(page, "Amount Due").getByText(amountDue, { exact: true })).toBeVisible();

    for (const item of invoiceItems) {
      const itemRow = page.getByRole("row").filter({ hasText: item.description }).first();
      await expect(itemRow).toBeVisible();
      await expect(itemRow).toContainText(item.period);
      await expect(itemRow.getByRole("cell").nth(1)).toHaveText(item.quantity);
      await expect(itemRow.getByRole("cell").nth(2)).toHaveText(item.unitPrice);
      await expect(itemRow.getByRole("cell").nth(3)).toHaveText(item.amount);
    }
  };

  return {
    login,
    goToInvoices,
    createInvoice,
    fillInvoiceForm,
    saveInvoice,
    expectInvoiceSelected,
  };
};
