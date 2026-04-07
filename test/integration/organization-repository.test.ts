import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Layer, Option } from "effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { SqliteClient } from "@effect/sql-sqlite-do";

import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { OrganizationRepository } from "@/lib/OrganizationRepository";
import type { OrganizationAgent } from "@/organization-agent";

const makeInvoiceId = (value: string = crypto.randomUUID()) =>
  Schema.decodeSync(OrganizationDomain.InvoiceId)(value);

const makeInvoiceItemId = (value: string = crypto.randomUUID()) =>
  Schema.decodeSync(OrganizationDomain.InvoiceItemId)(value);

const runInOrg = <A>(
  name: string,
  effect: Effect.Effect<A, unknown, OrganizationRepository | SqlClient.SqlClient>,
) => {
  const id = env.ORGANIZATION_AGENT.idFromName(name);
  const stub = env.ORGANIZATION_AGENT.get(id);
  return runInDurableObject(stub, async (_instance: OrganizationAgent, state) => {
    const sqliteLayer = SqliteClient.layer({ db: state.storage.sql });
    const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
    return Effect.runPromise(Effect.provide(effect, repoLayer));
  });
};

const seedInvoice = Effect.fn("seed.invoice")(function* (overrides?: {
  id?: OrganizationDomain.Invoice["id"];
  name?: OrganizationDomain.Invoice["name"];
  fileName?: OrganizationDomain.Invoice["fileName"];
  contentType?: OrganizationDomain.Invoice["contentType"];
  status?: OrganizationDomain.Invoice["status"];
  r2ObjectKey?: OrganizationDomain.Invoice["r2ObjectKey"];
  r2ActionTime?: OrganizationDomain.Invoice["r2ActionTime"];
  idempotencyKey?: OrganizationDomain.Invoice["idempotencyKey"];
  invoiceConfidence?: OrganizationDomain.Invoice["invoiceConfidence"];
  invoiceNumber?: OrganizationDomain.Invoice["invoiceNumber"];
}) {
  const sql = yield* SqlClient.SqlClient;
  const id = overrides?.id ?? makeInvoiceId();
  yield* sql`
    insert into Invoice (id, name, fileName, contentType, status, r2ObjectKey, r2ActionTime, idempotencyKey, invoiceConfidence, invoiceNumber)
    values (
      ${id},
      ${overrides?.name ?? "Test Invoice"},
      ${overrides?.fileName ?? "test.pdf"},
      ${overrides?.contentType ?? "application/pdf"},
      ${overrides?.status ?? "ready"},
      ${overrides?.r2ObjectKey ?? ""},
      ${overrides?.r2ActionTime ?? null},
      ${overrides?.idempotencyKey ?? null},
      ${overrides?.invoiceConfidence ?? 0},
      ${overrides?.invoiceNumber ?? ""}
    )
  `;
  return { id };
});

const seedInvoiceItem = Effect.fn("seed.invoiceItem")(function* (input: {
  invoiceId: OrganizationDomain.InvoiceItem["invoiceId"];
  order: OrganizationDomain.InvoiceItem["order"];
  description?: OrganizationDomain.InvoiceItem["description"];
  quantity?: OrganizationDomain.InvoiceItem["quantity"];
  unitPrice?: OrganizationDomain.InvoiceItem["unitPrice"];
  amount?: OrganizationDomain.InvoiceItem["amount"];
  period?: OrganizationDomain.InvoiceItem["period"];
}) {
  const sql = yield* SqlClient.SqlClient;
  const id = makeInvoiceItemId();
  yield* sql`
    insert into InvoiceItem (id, invoiceId, "order", description, quantity, unitPrice, amount, period)
    values (
      ${id},
      ${input.invoiceId},
      ${input.order},
      ${input.description ?? "Item"},
      ${input.quantity ?? "1"},
      ${input.unitPrice ?? "100"},
      ${input.amount ?? "100"},
      ${input.period ?? ""}
    )
  `;
  return { id };
});

describe("OrganizationRepository", () => {
  it("countInvoices — empty", async () => {
    await runInOrg(`count-empty-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      expect(yield* repo.countInvoices()).toBe(0);
    }));
  });

  it("countInvoices — after inserts", async () => {
    await runInOrg(`count-inserts-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      yield* seedInvoice();
      yield* seedInvoice();
      expect(yield* repo.countInvoices()).toBe(2);
    }));
  });

  it("findInvoice — found", async () => {
    await runInOrg(`find-found-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ name: "Found Me" });
      const result = yield* repo.findInvoice(inv.id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.id).toBe(inv.id);
      expect(invoice.name).toBe("Found Me");
    }));
  });

  it("findInvoice — not found", async () => {
    await runInOrg(`find-notfound-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const result = yield* repo.findInvoice(makeInvoiceId("nonexistent"));
      expect(Option.isNone(result)).toBe(true);
    }));
  });

  it("getInvoices — empty", async () => {
    await runInOrg(`invoices-empty-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const invoices = yield* repo.getInvoices();
      expect(invoices).toHaveLength(0);
    }));
  });

  it("getInvoices — returns all ordered by createdAt desc", async () => {
    await runInOrg(`invoices-ordered-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into Invoice (id, name, status, createdAt) values ('a', 'First', 'ready', 1000)`;
      yield* sql`insert into Invoice (id, name, status, createdAt) values ('b', 'Second', 'ready', 2000)`;
      yield* sql`insert into Invoice (id, name, status, createdAt) values ('c', 'Third', 'ready', 3000)`;
      const invoices = yield* repo.getInvoices();
      expect(invoices).toHaveLength(3);
      expect(invoices[0]?.name).toBe("Third");
      expect(invoices[1]?.name).toBe("Second");
      expect(invoices[2]?.name).toBe("First");
    }));
  });

  it("getInvoice — with items", async () => {
    await runInOrg(`getinvoice-items-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ name: "With Items" });
      yield* seedInvoiceItem({ invoiceId: inv.id, order: 2, description: "Second item" });
      yield* seedInvoiceItem({ invoiceId: inv.id, order: 1, description: "First item" });
      const result = yield* repo.getInvoice(inv.id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.name).toBe("With Items");
      expect(invoice.invoiceItems).toHaveLength(2);
      expect(invoice.invoiceItems[0]?.description).toBe("First item");
      expect(invoice.invoiceItems[1]?.description).toBe("Second item");
    }));
  });

  it("getInvoice — without items", async () => {
    await runInOrg(`getinvoice-noitems-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice();
      const result = yield* repo.getInvoice(inv.id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.id).toBe(inv.id);
      expect(invoice.invoiceItems).toHaveLength(0);
    }));
  });

  it("getInvoice — not found", async () => {
    await runInOrg(`getinvoice-notfound-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const result = yield* repo.getInvoice(makeInvoiceId("nonexistent"));
      expect(Option.isNone(result)).toBe(true);
    }));
  });

  it("createInvoice — creates with defaults", async () => {
    await runInOrg(`create-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const id = makeInvoiceId();
      yield* repo.createInvoice(id);
      const result = yield* repo.findInvoice(id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.id).toBe(id);
      expect(invoice.name).toBe("Untitled Invoice");
      expect(invoice.status).toBe("ready");
    }));
  });

  it("upsertInvoice — insert new", async () => {
    await runInOrg(`upsert-new-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const invoiceId = makeInvoiceId();
      const idempotencyKey = crypto.randomUUID();
      yield* repo.upsertInvoice({
        invoiceId,
        name: "Upserted",
        fileName: "upsert.pdf",
        contentType: "application/pdf",
        r2ObjectKey: "org/invoices/key",
        r2ActionTime: Date.now(),
        idempotencyKey,
        status: "extracting",
      });
      const result = yield* repo.findInvoice(invoiceId);
      const invoice = Option.getOrThrow(result);
      expect(invoice.name).toBe("Upserted");
      expect(invoice.status).toBe("extracting");
      expect(invoice.idempotencyKey).toBe(idempotencyKey);
    }));
  });

  it("upsertInvoice — update existing resets extraction fields", async () => {
    await runInOrg(`upsert-update-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const invoiceId = makeInvoiceId();
      const key1 = crypto.randomUUID();
      yield* repo.upsertInvoice({
        invoiceId,
        name: "Original",
        fileName: "orig.pdf",
        contentType: "application/pdf",
        r2ObjectKey: "org/invoices/key1",
        r2ActionTime: 1000,
        idempotencyKey: key1,
        status: "extracting",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`update Invoice set vendorName = 'Old Vendor', invoiceConfidence = 0.95 where id = ${invoiceId}`;
      const key2 = crypto.randomUUID();
      yield* repo.upsertInvoice({
        invoiceId,
        name: "Updated",
        fileName: "updated.pdf",
        contentType: "application/pdf",
        r2ObjectKey: "org/invoices/key2",
        r2ActionTime: 2000,
        idempotencyKey: key2,
        status: "extracting",
      });
      const result = yield* repo.findInvoice(invoiceId);
      const invoice = Option.getOrThrow(result);
      expect(invoice.name).toBe("Updated");
      expect(invoice.idempotencyKey).toBe(key2);
      expect(invoice.vendorName).toBe("");
      expect(invoice.invoiceConfidence).toBe(0);
    }));
  });

  it("insertUploadingInvoice — insert new", async () => {
    await runInOrg(`uploading-new-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const invoiceId = makeInvoiceId();
      yield* repo.insertUploadingInvoice({
        invoiceId,
        name: "Uploading",
        fileName: "upload.pdf",
        contentType: "application/pdf",
        idempotencyKey: crypto.randomUUID(),
        r2ObjectKey: "org/invoices/key",
      });
      const result = yield* repo.findInvoice(invoiceId);
      const invoice = Option.getOrThrow(result);
      expect(invoice.status).toBe("uploading");
    }));
  });

  it("insertUploadingInvoice — conflict does nothing", async () => {
    await runInOrg(`uploading-conflict-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const invoiceId = makeInvoiceId();
      yield* repo.insertUploadingInvoice({
        invoiceId,
        name: "First",
        fileName: "first.pdf",
        contentType: "application/pdf",
        idempotencyKey: crypto.randomUUID(),
        r2ObjectKey: "org/invoices/key",
      });
      yield* repo.insertUploadingInvoice({
        invoiceId,
        name: "Second",
        fileName: "second.pdf",
        contentType: "application/pdf",
        idempotencyKey: crypto.randomUUID(),
        r2ObjectKey: "org/invoices/key2",
      });
      const result = yield* repo.findInvoice(invoiceId);
      expect(Option.getOrThrow(result).name).toBe("First");
    }));
  });

  it("deleteInvoice — deletes ready invoice", async () => {
    await runInOrg(`delete-ready-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "ready" });
      const deleted = yield* repo.deleteInvoice(inv.id);
      expect(deleted).toHaveLength(1);
      expect(Option.isNone(yield* repo.findInvoice(inv.id))).toBe(true);
    }));
  });

  it("deleteInvoice — deletes error invoice", async () => {
    await runInOrg(`delete-error-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "error" });
      const deleted = yield* repo.deleteInvoice(inv.id);
      expect(deleted).toHaveLength(1);
    }));
  });

  it("deleteInvoice — deletes extracting invoice", async () => {
    await runInOrg(`delete-extracting-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "extracting" });
      const deleted = yield* repo.deleteInvoice(inv.id);
      expect(deleted).toHaveLength(1);
      expect(Option.isNone(yield* repo.findInvoice(inv.id))).toBe(true);
    }));
  });

  it("deleteInvoice — deletes uploading invoice", async () => {
    await runInOrg(`delete-uploading-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "uploading" });
      const deleted = yield* repo.deleteInvoice(inv.id);
      expect(deleted).toHaveLength(1);
    }));
  });

  it("saveInvoiceExtraction — saves fields and items", async () => {
    await runInOrg(`extract-save-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const idempotencyKey = crypto.randomUUID();
      const inv = yield* seedInvoice({ status: "extracting", idempotencyKey });
      const extractedInvoice = {
        invoiceConfidence: 0.92,
        invoiceNumber: "INV-001",
        invoiceDate: "2024-01-15",
        dueDate: "2024-02-15",
        currency: "USD",
        vendorName: "Acme Corp",
        vendorEmail: "billing@acme.com",
        vendorAddress: "123 Main St",
        billToName: "Client Inc",
        billToEmail: "pay@client.com",
        billToAddress: "456 Oak Ave",
        subtotal: "200.00",
        tax: "20.00",
        total: "220.00",
        amountDue: "220.00",
        invoiceItems: [
          { description: "Widget A", quantity: "2", unitPrice: "50.00", amount: "100.00", period: "Jan 2024" },
          { description: "Widget B", quantity: "1", unitPrice: "100.00", amount: "100.00", period: "" },
        ],
      };
      const extractedJson = JSON.stringify(extractedInvoice);
      const updated = yield* repo.saveInvoiceExtraction({
        invoiceId: inv.id,
        idempotencyKey,
        extractedInvoice,
        extractedJson,
      });
      expect(updated).toHaveLength(1);
      const result = yield* repo.getInvoice(inv.id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.status).toBe("ready");
      expect(invoice.invoiceConfidence).toBe(0.92);
      expect(invoice.vendorName).toBe("Acme Corp");
      expect(invoice.extractedJson).toBe(extractedJson);
      expect(invoice.invoiceItems).toHaveLength(2);
      expect(invoice.invoiceItems[0]?.description).toBe("Widget A");
      expect(invoice.invoiceItems[0]?.order).toBe(1);
      expect(invoice.invoiceItems[1]?.description).toBe("Widget B");
      expect(invoice.invoiceItems[1]?.order).toBe(2);
    }));
  });

  it("saveInvoiceExtraction — idempotency key mismatch returns empty", async () => {
    await runInOrg(`extract-mismatch-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "extracting", idempotencyKey: crypto.randomUUID() });
      const updated = yield* repo.saveInvoiceExtraction({
        invoiceId: inv.id,
        idempotencyKey: "wrong-key",
        extractedInvoice: {
          invoiceConfidence: 0.5,
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
          subtotal: "",
          tax: "",
          total: "",
          amountDue: "",
          invoiceItems: [],
        },
        extractedJson: "{}",
      });
      expect(updated).toHaveLength(0);
      const result = yield* repo.findInvoice(inv.id);
      expect(Option.getOrThrow(result).status).toBe("extracting");
    }));
  });

  it("saveInvoiceExtraction — replaces existing items", async () => {
    await runInOrg(`extract-replace-items-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const idempotencyKey = crypto.randomUUID();
      const inv = yield* seedInvoice({ status: "extracting", idempotencyKey });
      yield* seedInvoiceItem({ invoiceId: inv.id, order: 1, description: "Old item" });
      const extractedInvoice = {
        invoiceConfidence: 0.8,
        invoiceNumber: "INV-002",
        invoiceDate: "",
        dueDate: "",
        currency: "",
        vendorName: "",
        vendorEmail: "",
        vendorAddress: "",
        billToName: "",
        billToEmail: "",
        billToAddress: "",
        subtotal: "",
        tax: "",
        total: "",
        amountDue: "",
        invoiceItems: [{ description: "New item", quantity: "1", unitPrice: "50", amount: "50", period: "" }],
      };
      yield* repo.saveInvoiceExtraction({
        invoiceId: inv.id,
        idempotencyKey,
        extractedInvoice,
        extractedJson: JSON.stringify(extractedInvoice),
      });
      const result = yield* repo.getInvoice(inv.id);
      const invoice = Option.getOrThrow(result);
      expect(invoice.invoiceItems).toHaveLength(1);
      expect(invoice.invoiceItems[0]?.description).toBe("New item");
    }));
  });

  it("setError — sets error status", async () => {
    await runInOrg(`seterror-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const idempotencyKey = crypto.randomUUID();
      yield* seedInvoice({ status: "extracting", idempotencyKey });
      const updated = yield* repo.setError(idempotencyKey, "Something went wrong");
      expect(updated).toHaveLength(1);
      const id = (updated[0] as { id: string }).id;
      const result = yield* repo.findInvoice(makeInvoiceId(id));
      const invoice = Option.getOrThrow(result);
      expect(invoice.status).toBe("error");
      expect(invoice.error).toBe("Something went wrong");
    }));
  });

  it("setError — no match returns empty", async () => {
    await runInOrg(`seterror-nomatch-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const updated = yield* repo.setError("nonexistent-key", "error");
      expect(updated).toHaveLength(0);
    }));
  });

  it("updateInvoice — updates ready invoice with items", async () => {
    await runInOrg(`update-ready-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "ready" });
      const result = yield* repo.updateInvoice({
        invoiceId: inv.id,
        name: "Updated Name",
        invoiceNumber: "INV-100",
        invoiceDate: "2024-03-01",
        dueDate: "2024-04-01",
        currency: "EUR",
        vendorName: "New Vendor",
        vendorEmail: "v@v.com",
        vendorAddress: "789 Elm St",
        billToName: "New Client",
        billToEmail: "c@c.com",
        billToAddress: "012 Pine Rd",
        subtotal: "300.00",
        tax: "30.00",
        total: "330.00",
        amountDue: "330.00",
        invoiceItems: [
          { description: "Service A", quantity: "3", unitPrice: "100.00", amount: "300.00", period: "Q1" },
        ],
      });
      const invoice = Option.getOrThrow(result);
      expect(invoice.name).toBe("Updated Name");
      expect(invoice.vendorName).toBe("New Vendor");
      expect(invoice.invoiceItems).toHaveLength(1);
      expect(invoice.invoiceItems[0]?.description).toBe("Service A");
    }));
  });

  it("updateInvoice — updates error invoice", async () => {
    await runInOrg(`update-error-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "error" });
      const result = yield* repo.updateInvoice({
        invoiceId: inv.id,
        name: "Fixed",
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
        subtotal: "",
        tax: "",
        total: "",
        amountDue: "",
        invoiceItems: [],
      });
      const invoice = Option.getOrThrow(result);
      expect(invoice.name).toBe("Fixed");
      expect(invoice.status).toBe("ready");
      expect(invoice.error).toBeNull();
    }));
  });

  it("updateInvoice — rejects extracting invoice", async () => {
    await runInOrg(`update-reject-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "extracting" });
      const exit = yield* Effect.exit(repo.updateInvoice({
        invoiceId: inv.id,
        name: "Nope",
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
        subtotal: "",
        tax: "",
        total: "",
        amountDue: "",
        invoiceItems: [],
      }));
      expect(exit._tag).toBe("Failure");
    }));
  });

  it("updateInvoice — replaces existing items", async () => {
    await runInOrg(`update-replace-${crypto.randomUUID()}`, Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      const inv = yield* seedInvoice({ status: "ready" });
      yield* seedInvoiceItem({ invoiceId: inv.id, order: 1, description: "Old" });
      yield* seedInvoiceItem({ invoiceId: inv.id, order: 2, description: "Also old" });
      const result = yield* repo.updateInvoice({
        invoiceId: inv.id,
        name: "Replaced",
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
        subtotal: "",
        tax: "",
        total: "",
        amountDue: "",
        invoiceItems: [
          { description: "New only", quantity: "1", unitPrice: "10", amount: "10", period: "" },
        ],
      });
      const invoice = Option.getOrThrow(result);
      expect(invoice.invoiceItems).toHaveLength(1);
      expect(invoice.invoiceItems[0]?.description).toBe("New only");
    }));
  });
});
