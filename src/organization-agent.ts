import { Agent, callable } from "agents";
import { Effect } from "effect";
import * as Schema from "effect/Schema";

import type { ActivityEnvelope, WorkflowProgress } from "@/lib/Activity";
import { WorkflowProgressSchema } from "@/lib/Activity";
import { InvoiceStatus } from "@/lib/Domain";
import { makeLoggerLayer } from "@/lib/LoggerLayer";

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

export class OrganizationAgentError extends Schema.TaggedErrorClass<OrganizationAgentError>()(
  "OrganizationAgentError",
  { message: Schema.String },
) {}

const broadcastActivity = (
  agent: OrganizationAgent,
  input: { level: WorkflowProgress["level"]; text: string },
) =>
  Effect.sync(() => {
    agent.broadcast(
      JSON.stringify({
        type: "activity",
        message: {
          createdAt: new Date().toISOString(),
          level: input.level,
          text: input.text,
        },
      } satisfies ActivityEnvelope),
    );
  });

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

  // Type-only declaration (no runtime initializer); assigned in constructor.
  private declare runEffect: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Promise<A>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No blockConcurrencyWhile needed — everything here is synchronous:
    // - SQLite ops don't yield the event loop (atomic without gating)
    // - Layer construction is lazy (descriptions only, built at runPromise time)
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
    const loggerLayer = makeLoggerLayer(env);
    this.runEffect = (effect) =>
      Effect.runPromise(Effect.provide(effect, loggerLayer));
  }

  @callable()
  getTestMessage() {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logDebug("getTestMessage called");
        return this.state.message;
      }),
    );
  }

  @callable()
  onInvoiceUpload(upload: {
    invoiceId: string;
    r2ActionTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const r2ActionTime = Date.parse(upload.r2ActionTime);
        if (!Number.isFinite(r2ActionTime)) {
          return yield* new OrganizationAgentError({
            message: `Invalid r2ActionTime: ${upload.r2ActionTime}`,
          });
        }
        const existing = decodeInvoiceRow(
          this.sql<InvoiceRow>`select * from Invoice where id = ${upload.invoiceId}`[0] ??
            null,
        );
        if (existing && r2ActionTime < existing.r2ActionTime) return;
        const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
        if (
          trackedWorkflow &&
          activeWorkflowStatuses.has(trackedWorkflow.status)
        )
          return;
        if (
          existing?.idempotencyKey === upload.idempotencyKey &&
          (existing.status === "extracting" ||
            existing.status === "extracted")
        )
          return;
        yield* Effect.try({
          try: () =>
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
            `,
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* broadcastActivity(this, {
          level: "info",
          text: `Invoice uploaded: ${upload.fileName}`,
        });
        yield* Effect.tryPromise({
          try: () =>
            this.runWorkflow(
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
            ),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* Effect.try({
          try: () =>
            void this.sql`
              update Invoice
              set status = 'extracting'
              where id = ${upload.invoiceId} and idempotencyKey = ${upload.idempotencyKey}
            `,
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    r2ActionTime: string;
    r2ObjectKey: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const r2ActionTime = Date.parse(input.r2ActionTime);
        if (!Number.isFinite(r2ActionTime)) {
          return yield* new OrganizationAgentError({
            message: `Invalid r2ActionTime: ${input.r2ActionTime}`,
          });
        }
        const deleted = yield* Effect.try({
          try: () =>
            this.sql<{ id: string }>`
              delete from Invoice
              where id = ${input.invoiceId} and r2ActionTime <= ${r2ActionTime}
              returning id
            `,
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (deleted.length === 0) return;
        yield* broadcastActivity(this, {
          level: "info",
          text: "Invoice deleted",
        });
      }),
    );
  }

  saveExtractedJson(input: {
    invoiceId: string;
    idempotencyKey: string;
    extractedJson: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const updated = yield* Effect.try({
          try: () =>
            this.sql<{ id: string; fileName: string }>`
              update Invoice
              set status = 'extracted',
                  extractedJson = ${input.extractedJson},
                  error = null
              where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
              returning id, fileName
            `,
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          level: "success",
          text: `Invoice extraction completed: ${updated[0].fileName}`,
        });
      }),
    );
  }

  async onWorkflowProgress(
    workflowName: string,
    _workflowId: string,
    progress: unknown,
  ): Promise<void> {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") return;
        const message =
          Schema.decodeUnknownExit(WorkflowProgressSchema)(progress);
        if (message._tag === "Failure") return;
        yield* broadcastActivity(this, message.value);
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW") return;
        const updated = yield* Effect.try({
          try: () =>
            this.sql<{ id: string; fileName: string }>`
              update Invoice
              set status = 'error',
                  error = ${error}
              where idempotencyKey = ${workflowId}
              returning id, fileName
            `,
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          level: "error",
          text: `Invoice extraction failed: ${updated[0].fileName}`,
        });
      }),
    );
  }

  @callable()
  getInvoices() {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        return yield* Effect.try({
          try: () =>
            decodeInvoices(
              this.sql`select * from Invoice order by createdAt desc`,
            ),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    );
  }
}
