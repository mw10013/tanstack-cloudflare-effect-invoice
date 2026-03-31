import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { trimFields } from "./SchemaEx";

export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
export const InvoiceStatus = Schema.Literals(InvoiceStatusValues);
export type InvoiceStatus = typeof InvoiceStatus.Type;

export const Invoice = Schema.Struct({
  id: Schema.String,
  name: Schema.String.check(Schema.isMaxLength(500)),
  fileName: Schema.String.check(Schema.isMaxLength(500)),
  contentType: Schema.String.check(Schema.isMaxLength(100)),
  createdAt: Schema.Number,
  r2ActionTime: Schema.NullOr(Schema.Number),
  idempotencyKey: Schema.NullOr(Schema.String),
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  invoiceConfidence: Schema.Number,
  invoiceNumber: Schema.String.check(Schema.isMaxLength(100)),
  invoiceDate: Schema.String.check(Schema.isMaxLength(50)),
  dueDate: Schema.String.check(Schema.isMaxLength(50)),
  currency: Schema.String.check(Schema.isMaxLength(10)),
  vendorName: Schema.String.check(Schema.isMaxLength(500)),
  vendorEmail: Schema.String.check(Schema.isMaxLength(254)),
  vendorAddress: Schema.String.check(Schema.isMaxLength(2000)),
  billToName: Schema.String.check(Schema.isMaxLength(500)),
  billToEmail: Schema.String.check(Schema.isMaxLength(254)),
  billToAddress: Schema.String.check(Schema.isMaxLength(2000)),
  subtotal: Schema.String.check(Schema.isMaxLength(50)),
  tax: Schema.String.check(Schema.isMaxLength(50)),
  total: Schema.String.check(Schema.isMaxLength(50)),
  amountDue: Schema.String.check(Schema.isMaxLength(50)),
  extractedJson: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100_000))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type Invoice = typeof Invoice.Type;

export const InvoiceItem = Schema.Struct({
  id: Schema.String,
  invoiceId: Schema.String,
  order: Schema.Number,
  description: Schema.String.check(Schema.isMaxLength(2000)),
  quantity: Schema.String.check(Schema.isMaxLength(50)),
  unitPrice: Schema.String.check(Schema.isMaxLength(50)),
  amount: Schema.String.check(Schema.isMaxLength(50)),
  period: Schema.String.check(Schema.isMaxLength(50)),
});
export type InvoiceItem = typeof InvoiceItem.Type;

export const InvoiceWithItems = Schema.Struct({
  ...Invoice.fields,
  invoiceItems: Schema.Array(InvoiceItem),
});
export type InvoiceWithItems = typeof InvoiceWithItems.Type;

export const InvoiceItemFormSchema = Schema.Struct(
  trimFields(
    Struct.pick(InvoiceItem.fields, [
      "description",
      "quantity",
      "unitPrice",
      "amount",
      "period",
    ]),
  ),
);

export const InvoiceFormSchema = Schema.Struct({
  ...trimFields(
    Struct.pick(Invoice.fields, [
      "name",
      "invoiceNumber",
      "invoiceDate",
      "dueDate",
      "currency",
      "vendorName",
      "vendorEmail",
      "vendorAddress",
      "billToName",
      "billToEmail",
      "billToAddress",
      "subtotal",
      "tax",
      "total",
      "amountDue",
    ]),
  ),
  invoiceItems: Schema.mutable(Schema.Array(InvoiceItemFormSchema)),
});

export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

export const activeWorkflowStatuses = new Set<InstanceStatus["status"]>(["queued", "running", "waiting"]);
