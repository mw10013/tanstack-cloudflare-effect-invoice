import type { Browser, Page } from "@playwright/test";

import { invariant } from "@epic-web/invariant";
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { scopeEmail } from "./utils";

const callableScenario = {
  ownerEmail: scopeEmail("agent-auth-callables-owner@e2e.com"),
  memberEmail: scopeEmail("agent-auth-callables-member@e2e.com"),
};

const neverMemberScenario = {
  ownerEmail: scopeEmail("agent-auth-never-member-owner@e2e.com"),
  outsiderEmail: scopeEmail("agent-auth-never-member-outsider@e2e.com"),
};

const revokedScenario = {
  ownerEmail: scopeEmail("agent-auth-revoked-owner@e2e.com"),
  memberEmail: scopeEmail("agent-auth-revoked-member@e2e.com"),
};

const allUsers = [
  callableScenario.ownerEmail,
  callableScenario.memberEmail,
  neverMemberScenario.ownerEmail,
  neverMemberScenario.outsiderEmail,
  revokedScenario.ownerEmail,
  revokedScenario.memberEmail,
];

const uploadFileName = "cloudflare-invoice-2026-03-04-redacted.pdf";
const uploadInvoiceListName = uploadFileName.replace(/\.pdf$/, "");
const uploadFilePath = fileURLToPath(
  new URL(`../invoices/${uploadFileName}`, import.meta.url),
);

const getOrganizationName = (email: string) =>
  `${email.charAt(0).toUpperCase() + email.slice(1)}'s Organization`;

const getOrganizationIdFromUrl = (url: string) => {
  const organizationId = new URL(url).pathname.split("/")[2];
  invariant(organizationId, `Could not parse organizationId from URL: ${url}`);
  return organizationId;
};

const getFieldInput = (page: Page, label: string) =>
  page
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::*[@role="group"][1]')
    .getByRole("textbox");

const login = async (page: Page, email: string) => {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
  await page.getByRole("link", { name: /magic-link/ }).click();
  await page.waitForURL(/\/app\//);
};

const inviteMember = async ({
  page,
  email,
}: {
  page: Page;
  email: string;
}) => {
  await page.getByTestId("sidebar-invitations").click();
  await page.waitForURL(/invitations/);
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: /^member$/i }).click();
  await page.getByRole("textbox", { name: "Email Addresses" }).fill(email);
  await page.locator("main").getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("textbox", { name: "Email Addresses" })).toHaveValue(
    "",
  );
};

const acceptInvitationFrom = async ({
  page,
  inviterEmail,
}: {
  page: Page;
  inviterEmail: string;
}) => {
  const acceptButton = page.getByRole("button", {
    name: new RegExp(`accept.*${inviterEmail}`, "i"),
  });
  await expect(acceptButton).toBeVisible();
  await acceptButton.click();
  await expect(acceptButton).not.toBeVisible();
};

const switchOrganization = async ({
  page,
  currentName,
  targetName,
}: {
  page: Page;
  currentName: string;
  targetName: string;
}) => {
  await page.getByRole("button", { name: currentName }).click();
  await page
    .getByRole("menuitem", { name: new RegExp(`^${targetName}$`, "i") })
    .click();
  await expect(page.getByRole("button", { name: targetName })).toBeVisible();
};

const setupInvitedMember = async ({
  ownerPage,
  memberPage,
  ownerEmail,
  memberEmail,
}: {
  ownerPage: Page;
  memberPage: Page;
  ownerEmail: string;
  memberEmail: string;
}) => {
  await login(ownerPage, ownerEmail);
  await inviteMember({ page: ownerPage, email: memberEmail });
  await login(memberPage, memberEmail);
  await acceptInvitationFrom({ page: memberPage, inviterEmail: ownerEmail });
  await switchOrganization({
    page: memberPage,
    currentName: getOrganizationName(memberEmail),
    targetName: getOrganizationName(ownerEmail),
  });
};

const goToInvoices = async (page: Page) => {
  await page.getByRole("link", { name: /^Invoices$/ }).click();
  await page.waitForURL(/\/invoices/);
};

const openInvoicesPage = async ({
  page,
  organizationId,
}: {
  page: Page;
  organizationId: string;
}) => {
  await page.goto(`/app/${organizationId}/invoices`);
  await page.waitForURL(new RegExp(`/app/${organizationId}/invoices(?:\\?.*)?$`));
};

const createInvoice = async ({
  page,
  organizationId,
}: {
  page: Page;
  organizationId: string;
}) => {
  await openInvoicesPage({ page, organizationId });
  await page.screenshot({ path: `test-results/debug-create-invoice-before-click.png` });
  await page.getByRole("button", { name: "New Invoice" }).click();
  await page.waitForURL(/\/app\/[^/]+\/invoices\/[^/?]+$/, { timeout: 15_000 });
  await page.screenshot({ path: `test-results/debug-create-invoice-after-nav.png` });
  const invoiceId = page.url().split("/").at(-1) ?? "";
  invariant(invoiceId, "Could not parse invoiceId from URL");
  return invoiceId;
};

const uploadInvoice = async (page: Page) => {
  await page.locator('input[type="file"]').setInputFiles(uploadFilePath);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(
    page.locator("tbody tr").filter({ hasText: uploadInvoiceListName }).first(),
  ).toBeVisible();
};

const saveInvoice = async (page: Page, invoiceId: string) => {
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.waitForURL(/selectedInvoiceId=/);
  const selectedInvoiceId = new URL(page.url()).searchParams.get(
    "selectedInvoiceId",
  );
  expect(selectedInvoiceId).toBe(invoiceId);
};

const removeMember = async ({
  ownerPage,
  memberEmail,
}: {
  ownerPage: Page;
  memberEmail: string;
}) => {
  await ownerPage.getByRole("link", { name: /^Members$/ }).click();
  await ownerPage.waitForURL(/\/members$/);
  const memberRow = ownerPage
    .getByTestId("members-list")
    .locator("[data-slot='item']")
    .filter({ hasText: memberEmail })
    .first();
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole("button", { name: "Remove" }).click();
  await expect(memberRow).toBeHidden();
};

const expectSaveForbidden = async (page: Page) => {
  await getFieldInput(page, "Invoice Name").fill("Revoked Member Probe");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await expect(page.getByText("Save failed")).toBeVisible();
};

const withTwoPages = async (
  browser: Browser,
  testFn: (pages: { ownerPage: Page; memberPage: Page }) => Promise<void>,
) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  try {
    await testFn({ ownerPage, memberPage });
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
};

test.describe("organization-agent authorization", () => {
  test.beforeAll(async ({ request }) => {
    for (const email of allUsers) {
      await request.post(`/api/e2e/delete/user/${email}`);
    }
  });

  test("invited member is authorized for all invoice callables", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    invariant(baseURL, "Missing baseURL");
    await withTwoPages(browser, async ({ ownerPage, memberPage }) => {
      await setupInvitedMember({
        ownerPage,
        memberPage,
        ownerEmail: callableScenario.ownerEmail,
        memberEmail: callableScenario.memberEmail,
      });

      await goToInvoices(memberPage);
      const organizationId = getOrganizationIdFromUrl(memberPage.url());
      const createdInvoiceId = await createInvoice({
        page: memberPage,
        organizationId,
      });
      await getFieldInput(memberPage, "Invoice Name").fill("Agent Auth Invoice");
      await getFieldInput(memberPage, "Invoice Number").fill("AUTH-001");
      await saveInvoice(memberPage, createdInvoiceId);

      const selectedRow = memberPage
        .locator("tbody tr[data-state='selected']")
        .filter({ hasText: "Agent Auth Invoice" })
        .first();
      await expect(selectedRow).toBeVisible();
      await expect(memberPage.getByText("Invoice #AUTH-001")).toBeVisible();

      await uploadInvoice(memberPage);

      await selectedRow
        .getByRole("button")
        .filter({ has: memberPage.locator("svg") })
        .click();
      await expect(
        memberPage.locator("tbody tr").filter({ hasText: "Agent Auth Invoice" }),
      ).toHaveCount(0);
    });
  });

  test("never-member is blocked by worker gate", async ({
    browser,
    baseURL,
  }) => {
    invariant(baseURL, "Missing baseURL");
    await withTwoPages(browser, async ({ ownerPage, memberPage }) => {
      await login(ownerPage, neverMemberScenario.ownerEmail);
      const ownerOrganizationId = getOrganizationIdFromUrl(ownerPage.url());

      await login(memberPage, neverMemberScenario.outsiderEmail);
      const response = await memberPage.request.get(
        `/agents/organization-agent/${ownerOrganizationId}`,
      );

      expect(response.status()).toBe(403);
      expect(await response.text()).toContain("Forbidden");
    });
  });

  test("removed member is immediately forbidden from callables", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    invariant(baseURL, "Missing baseURL");
    await withTwoPages(browser, async ({ ownerPage, memberPage }) => {
      await setupInvitedMember({
        ownerPage,
        memberPage,
        ownerEmail: revokedScenario.ownerEmail,
        memberEmail: revokedScenario.memberEmail,
      });

      await goToInvoices(memberPage);
      const organizationId = getOrganizationIdFromUrl(memberPage.url());
      await createInvoice({ page: memberPage, organizationId });

      await removeMember({ ownerPage, memberEmail: revokedScenario.memberEmail });
      await expectSaveForbidden(memberPage);
    });
  });
});
