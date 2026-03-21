import * as Schema from "effect/Schema";

import { InvoiceStatus } from "./Domain";

export const InvoiceRow = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  r2ActionTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  extractedJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type InvoiceRow = typeof InvoiceRow.Type;

export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

export const activeWorkflowStatuses = new Set<InstanceStatus["status"]>(["queued", "running", "waiting"]);
