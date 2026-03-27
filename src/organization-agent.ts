import { Agent, callable, getCurrentAgent } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { Config, ConfigProvider, Effect, Layer, Option, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { SqliteClient } from "@effect/sql-sqlite-do";

import type { ActivityEnvelope, WorkflowProgress } from "@/lib/Activity";
import { WorkflowProgressSchema } from "@/lib/Activity";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { makeLoggerLayer } from "@/lib/LoggerLayer";
import type { InvoiceExtractionFields, InvoiceItemFields } from "@/lib/OrganizationDomain";
import {
  OrganizationAgentError,
  activeWorkflowStatuses,
} from "@/lib/OrganizationDomain";
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

  private declare runEffect: ReturnType<typeof makeRunEffect>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No blockConcurrencyWhile needed — everything here is synchronous:
    // - SQLite ops don't yield the event loop (atomic without gating)
    // - Layer construction is lazy (descriptions only, built at runPromise time)
    void this.sql`create table if not exists Invoice (
      id text primary key,
      name text not null default '',
      fileName text not null default '',
      contentType text not null default '',
      createdAt integer not null default (unixepoch() * 1000),
      r2ActionTime integer,
      idempotencyKey text unique,
      r2ObjectKey text not null default '',
      status text not null,
      invoiceConfidence real not null default 0,
      invoiceNumber text not null default '',
      invoiceDate text not null default '',
      dueDate text not null default '',
      currency text not null default '',
      vendorName text not null default '',
      vendorEmail text not null default '',
      vendorAddress text not null default '',
      billToName text not null default '',
      billToEmail text not null default '',
      billToAddress text not null default '',
      subtotal text not null default '',
      tax text not null default '',
      total text not null default '',
      amountDue text not null default '',
      extractedJson text,
      error text
    )`;
    void this.sql`create table if not exists InvoiceItem (
      id text primary key,
      invoiceId text not null references Invoice(id) on delete cascade,
      "order" real not null,
      description text not null default '',
      quantity text not null default '',
      unitPrice text not null default '',
      amount text not null default '',
      period text not null default ''
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
        const repo = yield* OrganizationRepository;
        const invoiceId: string = crypto.randomUUID();
        yield* repo.createInvoice(invoiceId);
        yield* broadcastActivity(this, {
          level: "info",
          text: "Invoice created",
        });
        return { invoiceId };
      }),
    );
  }

  @callable()
  updateInvoice(input: {
    invoiceId: string;
    name: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    currency: string;
    vendorName: string;
    vendorEmail: string;
    vendorAddress: string;
    billToName: string;
    billToEmail: string;
    billToAddress: string;
    subtotal: string;
    tax: string;
    total: string;
    amountDue: string;
    invoiceItems: readonly (typeof InvoiceItemFields.Type)[];
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const repo = yield* OrganizationRepository;
        const invoice = yield* repo.updateInvoice(input).pipe(
          Effect.map(Option.getOrNull),
        );
        if (!invoice) return yield* new OrganizationAgentError({ message: "Invoice not found after update" });
        yield* broadcastActivity(this, {
          level: "success",
          text: `Invoice updated: ${invoice.name ?? invoice.fileName ?? invoice.id}`,
        });
        return invoice;
      }),
    );
  }

  @callable()
  uploadInvoice(input: { fileName: string; contentType: string; base64: string }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* getConnectionIdentity();
        if (input.base64.length > MAX_BASE64_SIZE)
          return yield* new OrganizationAgentError({ message: "File too large" });
        if (!invoiceMimeTypes.includes(input.contentType as (typeof invoiceMimeTypes)[number]))
          return yield* new OrganizationAgentError({ message: "Invalid file type" });
        const invoiceId = crypto.randomUUID();
        const idempotencyKey = crypto.randomUUID();
        const key = `${this.name}/invoices/${invoiceId}`;
        const bytes = Uint8Array.from(atob(input.base64), (c) => c.codePointAt(0) ?? 0);
        const r2 = yield* R2;
        yield* r2.put(key, bytes, {
          httpMetadata: { contentType: input.contentType },
          customMetadata: {
            organizationId: this.name,
            invoiceId,
            idempotencyKey,
            fileName: input.fileName,
            contentType: input.contentType,
          },
        });
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        if (environment === "local") {
          const env = yield* CloudflareEnv;
          const queue = yield* Effect.fromNullishOr(env.INVOICE_INGEST_Q);
          yield* Effect.tryPromise(() =>
            queue.send({
              account: "local",
              action: "PutObject",
              bucket: "tcei-r2-local",
              object: { key, size: bytes.byteLength, eTag: "local" },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        return { invoiceId };
      }),
    );
  }

  @callable()
  softDeleteInvoice(invoiceId: string) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const repo = yield* OrganizationRepository;
        const deleted = yield* repo.softDeleteInvoice(invoiceId);
        if (deleted.length === 0) return;
        yield* broadcastActivity(this, {
          level: "info",
          text: "Invoice deleted",
        });
      }),
    );
  }

  saveExtraction(input: {
    invoiceId: string;
    idempotencyKey: string;
    extracted: typeof InvoiceExtractionFields.Type;
    invoiceItems: readonly (typeof InvoiceItemFields.Type)[];
    extractedJson: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.saveExtraction(input);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
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
        const repo = yield* OrganizationRepository;
        const updated = yield* repo.setError(workflowId, error);
        if (updated.length === 0) return;
        yield* broadcastActivity(this, {
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
  getInvoiceWithItems(invoiceId: string) {
    return this.runEffect(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        return yield* repo.getInvoiceWithItems(invoiceId).pipe(
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
