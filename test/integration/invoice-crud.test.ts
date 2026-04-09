import { Config, ConfigProvider, Effect, Layer, Schedule, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { assertInclude } from "@effect/vitest/utils";
import { env } from "cloudflare:workers";
import { expect } from "vitest";

import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { getLoaderData as getInvoiceLoaderData } from "@/routes/app.$organizationId.invoices.$invoiceId";
import { getLoaderData as getInvoicesLoaderData } from "@/routes/app.$organizationId.invoices.index";
import {
  agentWebSocket,
  assertAgentRpcFailure,
  assertAgentRpcSuccess,
  callAgentRpc,
  callServerFn,
  login,
} from "../TestUtils";

const InvoiceIdResult = Schema.Struct({
  invoiceId: OrganizationDomain.Invoice.fields.id,
});

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

layer(configLayer, { excludeTestServices: true })("invoice-crud", (it) => {
  it.effect("creates a blank invoice and retrieves it", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-create@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const createResult = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(createResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(createResult.result);

      const { invoice } = yield* callServerFn({
        serverFn: getInvoiceLoaderData,
        data: { organizationId, invoiceId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoice.id).toBe(invoiceId);
      expect(invoice.name).toBe("Untitled Invoice");
      expect(invoice.status).toBe("ready");
      expect(invoice.invoiceItems).toHaveLength(0);
    }));

  it.effect("getInvoices includes created invoice", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-list@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const createResult = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(createResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(createResult.result);

      const { invoices } = yield* callServerFn({
        serverFn: getInvoicesLoaderData,
        data: { organizationId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoices.some((i) => i.id === invoiceId)).toBe(true);
    }));

  it.effect("invoice detail loader returns undefined for non-existent id", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-get-null@test.com");
      const result = yield* callServerFn({
        serverFn: getInvoiceLoaderData,
        data: { organizationId, invoiceId: "nonexistent-id" },
        headers: { Cookie: sessionCookie },
      });
      expect(result).toBeUndefined();
    }));

  it.effect("getInvoices returns empty for fresh user", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-empty@test.com");
      const { invoices } = yield* callServerFn({
        serverFn: getInvoicesLoaderData,
        data: { organizationId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoices).toHaveLength(0);
    }));

  it.effect("getInvoices orders by createdAt DESC", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-order@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const r1 = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(r1);
      const first = Schema.decodeUnknownSync(InvoiceIdResult)(r1.result).invoiceId;

      const r2 = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(r2);
      const second = Schema.decodeUnknownSync(InvoiceIdResult)(r2.result).invoiceId;

      const { invoices } = yield* callServerFn({
        serverFn: getInvoicesLoaderData,
        data: { organizationId },
        headers: { Cookie: sessionCookie },
      });
      const idx1 = invoices.findIndex((i) => i.id === first);
      const idx2 = invoices.findIndex((i) => i.id === second);
      expect(idx2).toBeLessThan(idx1);
    }));

  it.effect("updates invoice fields", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-update@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const createResult = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(createResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(createResult.result);

      const updateData = {
        invoiceId,
        name: "Test Invoice",
        invoiceNumber: "INV-001",
        invoiceDate: "2026-01-15",
        dueDate: "2026-02-15",
        currency: "USD",
        vendorName: "Acme Corp",
        vendorEmail: "billing@acme.com",
        vendorAddress: "123 Main St",
        billToName: "Client Inc",
        billToEmail: "ap@client.com",
        billToAddress: "456 Oak Ave",
        subtotal: "100.00",
        tax: "10.00",
        total: "110.00",
        amountDue: "110.00",
        invoiceItems: [],
      };

      const updateResult = yield* callAgentRpc(ws, "updateInvoice", [updateData]);
      assertAgentRpcSuccess(updateResult);

      const { invoice } = yield* callServerFn({
        serverFn: getInvoiceLoaderData,
        data: { organizationId, invoiceId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoice.name).toBe("Test Invoice");
      expect(invoice.invoiceNumber).toBe("INV-001");
      expect(invoice.invoiceDate).toBe("2026-01-15");
      expect(invoice.dueDate).toBe("2026-02-15");
      expect(invoice.currency).toBe("USD");
      expect(invoice.vendorName).toBe("Acme Corp");
      expect(invoice.vendorEmail).toBe("billing@acme.com");
      expect(invoice.vendorAddress).toBe("123 Main St");
      expect(invoice.billToName).toBe("Client Inc");
      expect(invoice.billToEmail).toBe("ap@client.com");
      expect(invoice.billToAddress).toBe("456 Oak Ave");
      expect(invoice.subtotal).toBe("100.00");
      expect(invoice.tax).toBe("10.00");
      expect(invoice.total).toBe("110.00");
      expect(invoice.amountDue).toBe("110.00");
    }));

  it.effect("updates invoice with line items", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-items@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const createResult = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(createResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(createResult.result);

      const updateData = {
        invoiceId,
        name: "Items Invoice",
        invoiceNumber: "",
        invoiceDate: "",
        dueDate: "",
        currency: "",
        vendorName: "",
        vendorEmail: "",
        vendorAddress: "",
        billToName: "",
        billToEmail: "",
        billToAddress: "",
        subtotal: "300.00",
        tax: "0.00",
        total: "300.00",
        amountDue: "300.00",
        invoiceItems: [
          { description: "Widget A", quantity: "2", unitPrice: "50.00", amount: "100.00", period: "" },
          { description: "Widget B", quantity: "1", unitPrice: "200.00", amount: "200.00", period: "2026-Q1" },
        ],
      };

      const updateResult = yield* callAgentRpc(ws, "updateInvoice", [updateData]);
      assertAgentRpcSuccess(updateResult);

      const { invoice } = yield* callServerFn({
        serverFn: getInvoiceLoaderData,
        data: { organizationId, invoiceId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoice.invoiceItems).toHaveLength(2);
      expect(invoice.invoiceItems[0].description).toBe("Widget A");
      expect(invoice.invoiceItems[0].quantity).toBe("2");
      expect(invoice.invoiceItems[0].unitPrice).toBe("50.00");
      expect(invoice.invoiceItems[0].amount).toBe("100.00");
      expect(invoice.invoiceItems[1].description).toBe("Widget B");
      expect(invoice.invoiceItems[1].period).toBe("2026-Q1");
    }));

  it.effect("deletes an invoice", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-delete@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const createResult = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(createResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(createResult.result);

      const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [{ invoiceId }]);
      assertAgentRpcSuccess(deleteResult);

      const { invoices } = yield* callServerFn({
        serverFn: getInvoicesLoaderData,
        data: { organizationId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoices.some((invoice) => invoice.id === invoiceId)).toBe(false);
    }));

  it.effect("getInvoices excludes deleted invoice", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-del-list@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const r1 = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(r1);
      const keep = Schema.decodeUnknownSync(InvoiceIdResult)(r1.result).invoiceId;

      const r2 = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcSuccess(r2);
      const remove = Schema.decodeUnknownSync(InvoiceIdResult)(r2.result).invoiceId;

      const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [{ invoiceId: remove }]);
      assertAgentRpcSuccess(deleteResult);

      const { invoices } = yield* callServerFn({
        serverFn: getInvoicesLoaderData,
        data: { organizationId },
        headers: { Cookie: sessionCookie },
      });
      expect(invoices).toHaveLength(1);
      expect(invoices[0].id).toBe(keep);
    }));

  it.effect("delete is idempotent for non-existent id", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-del-noop@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const result = yield* callAgentRpc(ws, "deleteInvoice", [{ invoiceId: "nonexistent-id" }]);
      assertAgentRpcSuccess(result);
    }));

  it.effect("createInvoice enforces INVOICE_LIMIT", () =>
    Effect.gen(function* () {
      const { sessionCookie, organizationId } = yield* login("crud-limit@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);
      const invoiceLimit = yield* Config.number("INVOICE_LIMIT");

      yield* Effect.repeat(
        Effect.gen(function* () {
          const result = yield* callAgentRpc(ws, "createInvoice", []);
          assertAgentRpcSuccess(result);
        }),
        Schedule.recurs(invoiceLimit - 1),
      );

      const result = yield* callAgentRpc(ws, "createInvoice", []);
      assertAgentRpcFailure(result);
      assertInclude(result.error, "Invoice limit");
    }));
});
