import { Agent, callable } from "agents";
import * as Schema from "effect/Schema";

import { InvoiceStatus } from "@/lib/Domain";

export interface OrganizationAgentState {
  readonly message: string;
}

const InvoiceRowSchema = Schema.Struct({
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

const activeWorkflowStatuses = new Set(["queued", "running", "waiting"]);
type InvoiceRow = typeof InvoiceRowSchema.Type;
const decodeInvoiceRow = Schema.decodeUnknownSync(
  Schema.NullOr(InvoiceRowSchema),
);
const decodeInvoices = Schema.decodeUnknownSync(Schema.Array(InvoiceRowSchema));

export const extractAgentInstanceName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  initialState: OrganizationAgentState = {
    message: "Organization agent ready",
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.sql`create table if not exists Invoice (
      id text primary key,
      fileName text not null,
      contentType text not null,
      createdAt integer not null,
      r2ActionTime integer not null,
      idempotencyKey text not null unique,
      r2ObjectKey text not null,
      status text not null,
      extractedJson text,
      error text
    )`;
  }

  @callable()
  getTestMessage() {
    return this.state.message;
  }

  @callable()
  async onInvoiceUpload(upload: {
    invoiceId: string;
    r2ActionTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    const r2ActionTime = Date.parse(upload.r2ActionTime);
    if (!Number.isFinite(r2ActionTime)) {
      throw new TypeError(`Invalid r2ActionTime: ${upload.r2ActionTime}`);
    }
    const existing = decodeInvoiceRow(
      this
        .sql<InvoiceRow>`select * from Invoice where id = ${upload.invoiceId}`[0] ??
        null,
    );
    if (existing && r2ActionTime < existing.r2ActionTime) {
      return;
    }
    const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      return;
    }
    if (
      existing?.idempotencyKey === upload.idempotencyKey &&
      (existing.status === "extracting" ||
        existing.status === "extracted")
    ) {
      return;
    }
    void this.sql`
      insert into Invoice (
        id, fileName, contentType, createdAt, r2ActionTime,
        idempotencyKey, r2ObjectKey, status,
        extractedJson, error
      ) values (
        ${upload.invoiceId}, ${upload.fileName}, ${upload.contentType},
        ${r2ActionTime}, ${r2ActionTime}, ${upload.idempotencyKey},
        ${upload.r2ObjectKey}, 'uploaded',
        null, null
      )
      on conflict(id) do update set
        fileName = excluded.fileName,
        contentType = excluded.contentType,
        r2ActionTime = excluded.r2ActionTime,
        idempotencyKey = excluded.idempotencyKey,
        r2ObjectKey = excluded.r2ObjectKey,
        status = 'uploaded',
        extractedJson = null,
        error = null
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_uploaded",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
    await this.runWorkflow(
      "INVOICE_EXTRACTION_WORKFLOW",
      {
        invoiceId: upload.invoiceId,
        idempotencyKey: upload.idempotencyKey,
        r2ObjectKey: upload.r2ObjectKey,
        fileName: upload.fileName,
        contentType: upload.contentType,
      },
      {
        id: upload.idempotencyKey,
        metadata: { invoiceId: upload.invoiceId },
      },
    );
    void this.sql`
      update Invoice
      set status = 'extracting'
      where id = ${upload.invoiceId} and idempotencyKey = ${upload.idempotencyKey}
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_started",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    r2ActionTime: string;
    r2ObjectKey: string;
  }) {
    const r2ActionTime = Date.parse(input.r2ActionTime);
    if (!Number.isFinite(r2ActionTime)) {
      throw new TypeError(`Invalid r2ActionTime: ${input.r2ActionTime}`);
    }
    const deleted = this.sql<{ id: string }>`
      delete from Invoice
      where id = ${input.invoiceId} and r2ActionTime <= ${r2ActionTime}
      returning id
    `;
    if (deleted.length === 0) return;
    this.broadcast(
      JSON.stringify({
        type: "invoice_deleted",
        invoiceId: input.invoiceId,
      }),
    );
  }

  saveExtractedJson(input: {
    invoiceId: string;
    idempotencyKey: string;
    extractedJson: string;
  }) {
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'extracted',
          extractedJson = ${input.extractedJson},
          error = null
      where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
      returning id, fileName
    `;
    if (updated.length === 0) return;
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_complete",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") {
      return;
    }
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'error',
          error = ${error}
      where idempotencyKey = ${workflowId}
      returning id, fileName
    `;
    if (updated.length === 0) {
      return;
    }
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_error",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
        error,
      }),
    );
  }

  @callable()
  getInvoices() {
    return decodeInvoices(
      this.sql`select * from Invoice order by createdAt desc`,
    );
  }
}
