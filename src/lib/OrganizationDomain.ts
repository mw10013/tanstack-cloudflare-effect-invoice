import * as Schema from "effect/Schema";

export const InvoiceStatusValues = [
  "uploading",
  "extracting",
  "ready",
  "error",
] as const;
export const InvoiceStatus = Schema.Literals(InvoiceStatusValues);
export type InvoiceStatus = typeof InvoiceStatus.Type;

export const InvoiceId = Schema.NonEmptyString.pipe(Schema.brand("InvoiceId"));
export type InvoiceId = typeof InvoiceId.Type;

export const InvoiceItemId = Schema.NonEmptyString.pipe(
  Schema.brand("InvoiceItemId"),
);
export type InvoiceItemId = typeof InvoiceItemId.Type;

export const InvoiceIdempotencyKey = Schema.NonEmptyString;
export type InvoiceIdempotencyKey = typeof InvoiceIdempotencyKey.Type;

export const Invoice = Schema.Struct({
  id: InvoiceId,
  name: Schema.String.check(Schema.isMaxLength(500)),
  fileName: Schema.String.check(Schema.isMaxLength(500)),
  contentType: Schema.String.check(Schema.isMaxLength(100)),
  createdAt: Schema.Number,
  r2ActionTime: Schema.NullOr(Schema.Number),
  idempotencyKey: Schema.NullOr(InvoiceIdempotencyKey),
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
  id: InvoiceItemId,
  invoiceId: InvoiceId,
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


export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

export class InvoiceLimitExceededError extends Schema.TaggedErrorClass<InvoiceLimitExceededError>()(
  "InvoiceLimitExceededError",
  { limit: Schema.Number, message: Schema.String },
) {}

export const activeWorkflowStatuses = new Set<InstanceStatus["status"]>(["queued", "running", "waiting"]);
