import { Agent, callable } from "agents";
import * as Schema from "effect/Schema";

export interface OrganizationAgentState {
  readonly message: string;
}

export const extractAgentInstanceName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

const InvoiceRow = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  eventTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: Schema.String,
  processedAt: Schema.NullOr(Schema.Number),
});

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
      eventTime integer not null,
      idempotencyKey text not null unique,
      r2ObjectKey text not null,
      status text not null default 'uploaded',
      processedAt integer
    )`;
  }

  @callable()
  getTestMessage() {
    return this.state.message;
  }

  @callable()
  onInvoiceUpload(upload: {
    invoiceId: string;
    eventTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    const eventTime = Date.parse(upload.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${upload.eventTime}`);
    }
    void this.sql`
      insert into Invoice (id, fileName, contentType, createdAt, eventTime, idempotencyKey, r2ObjectKey, status, processedAt)
      values (${upload.invoiceId}, ${upload.fileName}, ${upload.contentType}, ${eventTime}, ${eventTime}, ${upload.idempotencyKey}, ${upload.r2ObjectKey}, 'uploaded', null)
      on conflict(id) do update set
        eventTime = excluded.eventTime,
        idempotencyKey = excluded.idempotencyKey,
        status = 'uploaded',
        processedAt = null
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_uploaded",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    eventTime: string;
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(input.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${input.eventTime}`);
    }
    const deleted = this.sql<{ id: string }>`
      delete from Invoice
      where id = ${input.invoiceId} and eventTime <= ${eventTime}
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

  @callable()
  getInvoices() {
    return Schema.decodeUnknownSync(Schema.Array(InvoiceRow))(
      this.sql`select * from Invoice order by createdAt desc`,
    );
  }
}
