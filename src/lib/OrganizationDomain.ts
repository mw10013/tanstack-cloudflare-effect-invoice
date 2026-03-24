import * as Schema from "effect/Schema";

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
  invoiceNumber: Schema.String,
  invoiceDate: Schema.String,
  dueDate: Schema.String,
  currency: Schema.String,
  vendorName: Schema.String,
  vendorEmail: Schema.String,
  vendorAddress: Schema.String,
  billToName: Schema.String,
  billToEmail: Schema.String,
  billToAddress: Schema.String,
  subtotal: Schema.String,
  tax: Schema.String,
  total: Schema.String,
  amountDue: Schema.String,
});

export const InvoiceItemFields = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
});

export const Invoice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  r2ActionTime: Schema.NullOr(Schema.Number),
  idempotencyKey: Schema.NullOr(Schema.String),
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  ...InvoiceExtractionFields.fields,
  extractedJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
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
