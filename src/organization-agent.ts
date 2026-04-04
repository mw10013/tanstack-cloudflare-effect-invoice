import { Agent, callable, getCurrentAgent } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { Config, ConfigProvider, Effect, Layer, Option, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { SqliteClient } from "@effect/sql-sqlite-do";

import type { ActivityMessage } from "@/lib/Activity";
import { ActivityAction } from "@/lib/Activity";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { makeLoggerLayer } from "@/lib/LoggerLayer";
import type { InvoiceExtractionSchema } from "@/lib/InvoiceExtraction";
import type { Invoice } from "@/lib/OrganizationDomain";
import {
  InvoiceId,
  InvoiceLimitExceededError,
  OrganizationAgentError,
  activeWorkflowStatuses,
} from "@/lib/OrganizationDomain";
import {
  DeleteInvoiceInput,
  GetInvoiceInput,
  UpdateInvoiceInput,
  UploadInvoiceInput,
} from "@/lib/OrganizationAgentSchemas";
import { OrganizationRepository } from "@/lib/OrganizationRepository";
import { R2 } from "@/lib/R2";

const invoiceMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const MAX_BASE64_SIZE = Math.ceil(10_000_000 * 4 / 3) + 4;

const makeRunEffect = (ctx: DurableObjectState, env: Env) => {
  const sqliteLayer = SqliteClient.layer({ db: ctx.storage.sql });
  const repoLayer = Layer.provideMerge(
    OrganizationRepository.layer,
    sqliteLayer,
  );
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const layer = Layer.mergeAll(repoLayer, r2Layer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ) => Effect.runPromise(Effect.provide(effect, layer));
};

export interface OrganizationAgentState {
  readonly message: string;
}

export interface OrganizationAgentConnectionState {
  readonly userId: string;
}

export const organizationAgentAuthHeaders = {
  userId: "x-organization-agent-user-id",
} as const;

const broadcastActivity = (
  agent: OrganizationAgent,
  input: Pick<ActivityMessage, "action" | "level" | "text">,
) =>
  Effect.sync(() => {
    agent.broadcast(
      JSON.stringify({
        createdAt: new Date().toISOString(),
        action: input.action,
        level: input.level,
        text: input.text,
      } satisfies ActivityMessage),
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

  private declare runEffect: ReturnType<typeof makeRunEffect>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No blockConcurrencyWhile needed — everything here is synchronous:
    // - SQLite ops don't yield the event loop (atomic without gating)
    // - Layer construction is lazy (descriptions only, built at runPromise time)
    void this.sql`create table if not exists Invoice (
      id text primary key,
      name text not null default '' check(length(name) <= 500),
      fileName text not null default '' check(length(fileName) <= 500),
      contentType text not null default '' check(length(contentType) <= 100),
      createdAt integer not null default (unixepoch() * 1000),
      r2ActionTime integer,
      idempotencyKey text unique,
      r2ObjectKey text not null default '' check(length(r2ObjectKey) <= 200),
      status text not null,
      invoiceConfidence real not null default 0,
      invoiceNumber text not null default '' check(length(invoiceNumber) <= 100),
      invoiceDate text not null default '' check(length(invoiceDate) <= 50),
      dueDate text not null default '' check(length(dueDate) <= 50),
      currency text not null default '' check(length(currency) <= 10),
      vendorName text not null default '' check(length(vendorName) <= 500),
      vendorEmail text not null default '' check(length(vendorEmail) <= 254),
      vendorAddress text not null default '' check(length(vendorAddress) <= 2000),
      billToName text not null default '' check(length(billToName) <= 500),
      billToEmail text not null default '' check(length(billToEmail) <= 254),
      billToAddress text not null default '' check(length(billToAddress) <= 2000),
      subtotal text not null default '' check(length(subtotal) <= 50),
      tax text not null default '' check(length(tax) <= 50),
      total text not null default '' check(length(total) <= 50),
      amountDue text not null default '' check(length(amountDue) <= 50),
      extractedJson text check(length(extractedJson) <= 100000),
      error text check(length(error) <= 10000)
    )`;
    void this.sql`create table if not exists InvoiceItem (
      id text primary key,
      invoiceId text not null references Invoice(id) on delete cascade,
      "order" real not null,
      description text not null default '' check(length(description) <= 2000),
      quantity text not null default '' check(length(quantity) <= 50),
      unitPrice text not null default '' check(length(unitPrice) <= 50),
      amount text not null default '' check(length(amount) <= 50),
      period text not null default '' check(length(period) <= 50)
    )`;
    this.runEffect = makeRunEffect(ctx, env);
  }

  onConnect(
    connection: Connection<OrganizationAgentConnectionState>,
    ctx: ConnectionContext,
  ) {
    const userId = ctx.request.headers.get(organizationAgentAuthHeaders.userId);
    if (!userId) {
      connection.close(4001, "Unauthorized");
      return;
    }
    connection.setState({ userId });
  }

  onInvoiceUpload(upload: {
    invoiceId: Invoice["id"];
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
        const repo = yield* OrganizationRepository;
        const existing = yield* repo.findInvoice(upload.invoiceId);
        if (
          Option.isSome(existing) &&
          existing.value.r2ActionTime !== null &&
          r2ActionTime < existing.value.r2ActionTime
        )
          return;
        const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
        if (
          trackedWorkflow &&
          activeWorkflowStatuses.has(trackedWorkflow.status)
        )
          return;
        if (
          Option.isSome(existing) &&
          existing.value.idempotencyKey !== null &&
          existing.value.idempotencyKey === upload.idempotencyKey &&
          (existing.value.status === "extracting" ||
            existing.value.status === "ready")
        )
          return;
        const name = upload.fileName.replace(/\.[^.]+$/, "");
        yield* repo.upsertInvoice({ ...upload, name, r2ActionTime, status: "extracting" });
        yield* broadcastActivity(this, {
          action: "invoice.uploaded",
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
      }),
    );
  }

  @callable()
  createInvoice() {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const invoiceLimit = yield* Config.number("INVOICE_LIMIT");
        const repo = yield* OrganizationRepository;
        const count = yield* repo.countInvoices();
        if (count >= invoiceLimit)
          return yield* new InvoiceLimitExceededError({ limit: invoiceLimit, message: `Invoice limit of ${String(invoiceLimit)} reached` });
        const invoiceId = yield* Schema.decodeUnknownEffect(InvoiceId)(
          crypto.randomUUID(),
        );
        yield* repo.createInvoice(invoiceId);
        yield* broadcastActivity(this, {
          action: "invoice.created",
          level: "info",
          text: "Invoice created",
        });
        return { invoiceId };
      }),
    );
  }

  @callable()
  updateInvoice(input: typeof UpdateInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const data = yield* Schema.decodeUnknownEffect(UpdateInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        const invoice = yield* repo.updateInvoice(data).pipe(
          Effect.map(Option.getOrNull),
        );
        if (!invoice) return yield* new OrganizationAgentError({ message: "Invoice not found after update" });
        return invoice;
      }),
    );
  }

  /**
   * Uploads an invoice file to R2, then inserts a DB row with status "uploading"
   * so the UI has something to display before {@link onInvoiceUpload} runs.
   *
   * Fault tolerance:
   * - If R2 put fails, no DB row is created — no dangling records.
   * - The insert uses ON CONFLICT DO NOTHING: if {@link onInvoiceUpload} already
   *   ran (possible because r2.put yields the event loop), the existing
   *   "extracting" row is preserved and the insert is a no-op.
   * - {@link onInvoiceUpload} handles a pre-existing "uploading" row correctly —
   *   its idempotency guards skip only "extracting"/"ready", so it proceeds to
   *   upsert the row to "extracting" and start the workflow.
   */
  @callable()
  uploadInvoice(input: typeof UploadInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const data = yield* Schema.decodeUnknownEffect(UploadInvoiceInput)(input);
        yield* getConnectionIdentity();
        const invoiceLimit = yield* Config.number("INVOICE_LIMIT");
        const repo = yield* OrganizationRepository;
        const count = yield* repo.countInvoices();
        if (count >= invoiceLimit)
          return yield* new InvoiceLimitExceededError({ limit: invoiceLimit, message: `Invoice limit of ${String(invoiceLimit)} reached` });
        if (data.base64.length > MAX_BASE64_SIZE)
          return yield* new OrganizationAgentError({ message: "File too large" });
        if (!invoiceMimeTypes.includes(data.contentType as (typeof invoiceMimeTypes)[number]))
          return yield* new OrganizationAgentError({ message: "Invalid file type" });
        const invoiceId = yield* Schema.decodeUnknownEffect(InvoiceId)(
          crypto.randomUUID(),
        );
        const idempotencyKey = crypto.randomUUID();
        const key = `${this.name}/invoices/${invoiceId}`;
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.codePointAt(0) ?? 0);
        const r2 = yield* R2;
        yield* r2.put(key, bytes, {
          httpMetadata: { contentType: data.contentType },
          customMetadata: {
            organizationId: this.name,
            invoiceId,
            idempotencyKey,
            fileName: data.fileName,
            contentType: data.contentType,
          },
        });
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        if (environment === "local") {
          const env = yield* CloudflareEnv;
          const queue = yield* Effect.fromNullishOr(env.Q);
          yield* Effect.tryPromise(() =>
            queue.send({
              // Local dev uses placeholder account/bucket names because the consumer only reads action/object/eventTime.
              account: "local",
              action: "PutObject",
              bucket: "tcei-r2-local",
              object: { key, size: bytes.byteLength, eTag: "local" },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        yield* repo.insertUploadingInvoice({
          invoiceId,
          name: data.fileName.replace(/\.[^.]+$/, ""),
          fileName: data.fileName,
          contentType: data.contentType,
          idempotencyKey,
          r2ObjectKey: key,
        });
        return { invoiceId };
      }),
    );
  }

  @callable()
  deleteInvoice(input: typeof DeleteInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const { invoiceId } = yield* Schema.decodeUnknownEffect(DeleteInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        const invoice = yield* repo.findInvoice(invoiceId);
        if (Option.isNone(invoice)) return;
        if (invoice.value.status !== "ready" && invoice.value.status !== "error") return;
        const { Q: queue } = yield* CloudflareEnv;
        if (!queue)
          return yield* new OrganizationAgentError({
            message: "Invoice delete queue unavailable",
          });
        yield* Effect.tryPromise({
          try: () =>
            queue.send({
              action: "DeleteInvoice",
              organizationId: this.name,
              invoiceId,
              r2ObjectKey: invoice.value.r2ObjectKey,
            }),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* repo.deleteInvoiceRecord(invoiceId);
      }),
    );
  }

  deleteInvoiceRecord(invoiceId: Invoice["id"]) {
    return this.runEffect(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        yield* repo.deleteInvoiceRecord(invoiceId);
      }),
    );
  }

  saveInvoiceExtraction(input: {
    invoiceId: Invoice["id"];
    idempotencyKey: string;
    extractedInvoice: typeof InvoiceExtractionSchema.Type;
    extractedJson: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.saveInvoiceExtraction(input);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          action: "invoice.extraction.completed",
          level: "success",
          text: `Invoice extraction completed: ${(updated[0] as { fileName: string }).fileName}`,
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
        const result = Schema.decodeUnknownExit(
          Schema.Struct({ action: ActivityAction, level: Schema.Literals(["info", "success", "error"]), text: Schema.String }),
        )(progress);
        if (result._tag === "Failure") return;
        yield* broadcastActivity(this, result.value);
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
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.setError(workflowId, error);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
          action: "invoice.extraction.failed",
          level: "error",
          text: `Invoice extraction failed: ${(updated[0] as { fileName: string }).fileName}`,
        });
      }),
    );
  }

  @callable()
  getInvoices() {
    return this.runEffect(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        return yield* repo.getInvoices();
      }),
    );
  }

  @callable()
  getInvoice(input: typeof GetInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen(function* () {
        const { invoiceId } = yield* Schema.decodeUnknownEffect(GetInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        return yield* repo.getInvoice(invoiceId).pipe(
          Effect.map(Option.getOrNull),
        );
      }),
    );
  }
}

const getConnectionIdentity = Effect.fn("OrganizationAgent.getConnectionIdentity")(
  function* () {
    const { agent, connection } = getCurrentAgent<OrganizationAgent>();
    const identity = connection?.state as
      | OrganizationAgentConnectionState
      | null
      | undefined;
    if (!agent || !identity?.userId) {
      return yield* new OrganizationAgentError({
        message: "Unauthorized",
      });
    }
    return identity;
  },
);
