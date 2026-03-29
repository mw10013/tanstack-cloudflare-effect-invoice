import * as Schema from "effect/Schema";

const maxLength = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
export const InvoiceStatus = Schema.Literals(InvoiceStatusValues);
export type InvoiceStatus = typeof InvoiceStatus.Type;

export const InvoiceExtractionFields = Schema.Struct({
  invoiceConfidence: Schema.Number,
  invoiceNumber: maxLength(100),
  invoiceDate: maxLength(50),
  dueDate: maxLength(50),
  currency: maxLength(10),
  vendorName: maxLength(500),
  vendorEmail: maxLength(254),
  vendorAddress: maxLength(2000),
  billToName: maxLength(500),
  billToEmail: maxLength(254),
  billToAddress: maxLength(2000),
  subtotal: maxLength(50),
  tax: maxLength(50),
  total: maxLength(50),
  amountDue: maxLength(50),
});

export const InvoiceItemFields = Schema.Struct({
  description: maxLength(2000),
  quantity: maxLength(50),
  unitPrice: maxLength(50),
  amount: maxLength(50),
  period: maxLength(50),
});

export const Invoice = Schema.Struct({
  id: Schema.String,
  name: maxLength(500),
  fileName: maxLength(500),
  contentType: maxLength(100),
  createdAt: Schema.Number,
  r2ActionTime: Schema.NullOr(Schema.Number),
  idempotencyKey: Schema.NullOr(Schema.String),
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  ...InvoiceExtractionFields.fields,
  extractedJson: Schema.NullOr(maxLength(100_000)),
  error: Schema.NullOr(maxLength(10_000)),
});
export type Invoice = typeof Invoice.Type;

export const InvoiceItem = Schema.Struct({
  id: Schema.String,
  invoiceId: Schema.String,
  order: Schema.Number,
  ...InvoiceItemFields.fields,
});
export type InvoiceItem = typeof InvoiceItem.Type;

export const InvoiceWithItems = Schema.Struct({
  ...Invoice.fields,
  items: Schema.Array(InvoiceItem),
});
export type InvoiceWithItems = typeof InvoiceWithItems.Type;

export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

export const activeWorkflowStatuses = new Set<InstanceStatus["status"]>(["queued", "running", "waiting"]);
