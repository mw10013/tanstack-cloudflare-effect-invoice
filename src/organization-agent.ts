import type { Connection, ConnectionContext } from "agents";

import type { ActivityMessage } from "@/lib/Activity";
import type { InvoiceExtraction } from "@/lib/InvoiceExtractor";
import type { Invoice } from "@/lib/OrganizationDomain";
import type { MembershipSyncChange } from "@/lib/Q";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { Agent, callable, getCurrentAgent } from "agents";
import { Config, Effect, Layer, Option, Predicate } from "effect";
import * as Schema from "effect/Schema";

import { ActivityAction } from "@/lib/Activity";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import {
  DeleteInvoiceInput,
  GetInvoiceInput,
  UpdateInvoiceInput,
  UploadInvoiceInput,
} from "@/lib/OrganizationAgentSchemas";
import {
  Invoice as InvoiceSchema,
  InvoiceLimitExceededError,
  OrganizationAgentError,
  activeWorkflowStatuses,
} from "@/lib/OrganizationDomain";
import { OrganizationRepository } from "@/lib/OrganizationRepository";
import { enqueue } from "@/lib/Q";
import { R2 } from "@/lib/R2";
import { Repository } from "@/lib/Repository";

const invoiceMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const MAX_BASE64_SIZE = Math.ceil((10_000_000 * 4) / 3) + 4;

const R2ObjectCustomMetadata = Schema.Struct({
  organizationId: Domain.Organization.fields.id,
  invoiceId: InvoiceSchema.fields.id,
  idempotencyKey: InvoiceSchema.fields.idempotencyKey.pipe(
    Schema.refine(Predicate.isNotNull),
  ),
  fileName: InvoiceSchema.fields.fileName.check(Schema.isNonEmpty()),
  contentType: InvoiceSchema.fields.contentType.check(Schema.isNonEmpty()),
});
type R2ObjectCustomMetadata = typeof R2ObjectCustomMetadata.Type;

const makeRunEffect = (ctx: DurableObjectState, env: Env) => {
  const sqliteLayer = SqliteClient.layer({ db: ctx.storage.sql });
  const organizationRepositoryLayer = Layer.provideMerge(
    OrganizationRepository.layer,
    sqliteLayer,
  );
  const envLayer = makeEnvLayer(env);
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const layer = Layer.mergeAll(
    organizationRepositoryLayer,
    r2Layer,
    repositoryLayer,
    makeLoggerLayer(env),
  );
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(Effect.provide(effect, layer));
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

/**
 * Broadcasts activity to connected clients as best-effort telemetry.
 *
 * Broadcast failures are ignored and never fail the caller.
 */
const broadcastActivity = (
  agent: OrganizationAgent,
  input: Pick<ActivityMessage, "action" | "level" | "text">,
) =>
  Effect.try({
    try: () => {
      agent.broadcast(
        JSON.stringify({
          createdAt: new Date().toISOString(),
          action: input.action,
          level: input.level,
          text: input.text,
        } satisfies ActivityMessage),
      );
    },
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));

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

  declare private runEffect: ReturnType<typeof makeRunEffect>;

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
    void this.sql`create table if not exists Member (
      userId text primary key,
      role text not null
    )`;
    void this
      .sql`create index if not exists Invoice_createdAt_idx on Invoice(createdAt)`;
    void this
      .sql`create index if not exists InvoiceItem_invoiceId_order_idx on InvoiceItem(invoiceId, "order")`;
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

  @callable()
  createInvoice() {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* authorizeConnection();
        const invoiceLimit = yield* Config.number("INVOICE_LIMIT");
        const repo = yield* OrganizationRepository;
        const count = yield* repo.countInvoices();
        if (count >= invoiceLimit)
          return yield* new InvoiceLimitExceededError({
            limit: invoiceLimit,
            message: `Invoice limit of ${String(invoiceLimit)} reached`,
          });
        const invoiceId = yield* Schema.decodeUnknownEffect(
          InvoiceSchema.fields.id,
        )(crypto.randomUUID());
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
        yield* authorizeConnection();
        const data =
          yield* Schema.decodeUnknownEffect(UpdateInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        const invoice = yield* repo
          .updateInvoice(data)
          .pipe(Effect.map(Option.getOrNull));
        if (!invoice)
          return yield* new OrganizationAgentError({
            message: "Invoice not found after update",
          });
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
   *   dedupe skips only active workflow or terminal states, so first delivery and
   *   recoverable retries can still upsert to "extracting" and start extraction.
   */
  @callable()
  uploadInvoice(input: typeof UploadInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const data =
          yield* Schema.decodeUnknownEffect(UploadInvoiceInput)(input);
        yield* authorizeConnection();
        const invoiceLimit = yield* Config.number("INVOICE_LIMIT");
        const repo = yield* OrganizationRepository;
        const count = yield* repo.countInvoices();
        if (count >= invoiceLimit)
          return yield* new InvoiceLimitExceededError({
            limit: invoiceLimit,
            message: `Invoice limit of ${String(invoiceLimit)} reached`,
          });
        if (data.base64.length > MAX_BASE64_SIZE)
          return yield* new OrganizationAgentError({
            message: "File too large",
          });
        if (
          !invoiceMimeTypes.includes(
            data.contentType as (typeof invoiceMimeTypes)[number],
          )
        )
          return yield* new OrganizationAgentError({
            message: "Invalid file type",
          });
        const organizationId = yield* Schema.decodeUnknownEffect(
          Domain.Organization.fields.id,
        )(this.name);
        const invoiceId = yield* Schema.decodeUnknownEffect(
          InvoiceSchema.fields.id,
        )(crypto.randomUUID());
        const idempotencyKey = crypto.randomUUID();
        const key = `${organizationId}/invoices/${invoiceId}`;
        const bytes = Uint8Array.from(
          atob(data.base64),
          (c) => c.codePointAt(0) ?? 0,
        );
        const r2 = yield* R2;
        yield* r2.put(key, bytes, {
          httpMetadata: { contentType: data.contentType },
          customMetadata: {
            organizationId,
            invoiceId,
            idempotencyKey,
            fileName: data.fileName,
            contentType: data.contentType,
          } satisfies R2ObjectCustomMetadata,
        });
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        if (environment === "local") {
          yield* enqueue({
            action: "PutObject",
            object: { key },
            eventTime: new Date().toISOString(),
          });
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

  /**
   * Handles Cloudflare R2 `PutObject` event notifications forwarded from the queue consumer.
   *
   * Queue delivery is at-least-once, so dedupe uses three guards:
   * stale `r2ActionTime` is ignored, active workflow instances are ignored, and
   * same-key terminal rows (`ready`/`error`) are ignored. A same-key `extracting`
   * row without an active workflow is retried to recover from partial failures.
   */
  onInvoiceUpload(upload: {
    r2ObjectKey: Invoice["r2ObjectKey"];
    r2ActionTime: string;
  }) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        const r2 = yield* R2;
        const head = yield* r2.head(upload.r2ObjectKey);
        if (Option.isNone(head)) {
          yield* Effect.logWarning(
            "R2 object deleted before notification processed",
            { key: upload.r2ObjectKey },
          );
          return;
        }
        const metadata = yield* Schema.decodeUnknownEffect(
          R2ObjectCustomMetadata,
        )(head.value.customMetadata);
        if (metadata.organizationId !== this.name) {
          yield* Effect.logWarning("onInvoiceUpload.organizationMismatch", {
            r2ObjectKey: upload.r2ObjectKey,
            organizationId: metadata.organizationId,
            agentName: this.name,
          });
          return;
        }
        const r2ActionTime = Date.parse(upload.r2ActionTime);
        if (!Number.isFinite(r2ActionTime)) {
          return yield* new OrganizationAgentError({
            message: `Invalid r2ActionTime: ${upload.r2ActionTime}`,
          });
        }
        const repo = yield* OrganizationRepository;
        const existing = yield* repo.findInvoice(metadata.invoiceId);
        if (
          Option.isSome(existing) &&
          existing.value.r2ActionTime !== null &&
          r2ActionTime < existing.value.r2ActionTime
        )
          return;
        const trackedWorkflow = this.getWorkflow(metadata.idempotencyKey);
        if (
          trackedWorkflow &&
          activeWorkflowStatuses.has(trackedWorkflow.status)
        )
          return;
        if (
          Option.isSome(existing) &&
          existing.value.idempotencyKey !== null &&
          existing.value.idempotencyKey === metadata.idempotencyKey &&
          (existing.value.status === "ready" ||
            existing.value.status === "error")
        )
          return;
        const name = metadata.fileName.replace(/\.[^.]+$/, "");
        yield* repo.upsertInvoice({
          invoiceId: metadata.invoiceId,
          idempotencyKey: metadata.idempotencyKey,
          r2ObjectKey: upload.r2ObjectKey,
          fileName: metadata.fileName,
          contentType: metadata.contentType,
          name,
          r2ActionTime,
          status: "extracting",
        });
        yield* Effect.tryPromise({
          try: () =>
            this.runWorkflow(
              "INVOICE_EXTRACTION_WORKFLOW",
              {
                invoiceId: metadata.invoiceId,
                idempotencyKey: metadata.idempotencyKey,
                r2ObjectKey: upload.r2ObjectKey,
                fileName: metadata.fileName,
                contentType: metadata.contentType,
              },
              {
                id: metadata.idempotencyKey,
                metadata: { invoiceId: metadata.invoiceId },
              },
            ),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* broadcastActivity(this, {
          action: "invoice.uploaded",
          level: "info",
          text: `Invoice uploaded: ${metadata.fileName}`,
        });
      }),
    );
  }

  /**
   * Deletes a terminal invoice with queue-backed completion guarantees.
   *
   * For terminal invoices (`ready` or `error`), this method first enqueues a
   * `FinalizeInvoiceDeletion` message with `r2ObjectKey`, then deletes the
   * invoice row immediately so reads stop returning the invoice.
   *
   * Enqueue-first means if execution fails after enqueue but before local delete,
   * queue processing still calls `onFinalizeInvoiceDeletion` and completes deletion.
   */
  @callable()
  deleteInvoice(input: typeof DeleteInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* authorizeConnection();
        const { invoiceId } =
          yield* Schema.decodeUnknownEffect(DeleteInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        const invoice = yield* repo.findInvoice(invoiceId);
        if (Option.isNone(invoice)) return;
        if (
          invoice.value.status !== "ready" &&
          invoice.value.status !== "error"
        )
          return yield* new OrganizationAgentError({
            message: `Invoice cannot be deleted in status=${invoice.value.status}`,
          });
        const { Q: queue } = yield* CloudflareEnv;
        yield* Effect.tryPromise({
          try: () =>
            queue.send({
              action: "FinalizeInvoiceDeletion",
              organizationId: this.name,
              invoiceId,
              r2ObjectKey: invoice.value.r2ObjectKey,
            }),
          catch: (cause) =>
            new OrganizationAgentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* repo.deleteInvoice(invoiceId);
      }),
    );
  }

  /**
   * Finalizes deletion from the `FinalizeInvoiceDeletion` queue message.
   *
   * `deleteInvoice()` already enqueues this work and deletes the DB row immediately.
   * Queue delivery is at-least-once, so this handler re-applies the DB delete
   * idempotently to ensure the invoice row is actually removed, then deletes the
   * R2 object for eventual consistency of storage cleanup.
   */
  onFinalizeInvoiceDeletion(input: {
    invoiceId: Invoice["id"];
    r2ObjectKey: Invoice["r2ObjectKey"];
  }) {
    return this.runEffect(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        yield* repo.deleteInvoice(input.invoiceId);
        if (!input.r2ObjectKey) return;
        const r2 = yield* R2;
        yield* r2.delete(input.r2ObjectKey);
      }),
    );
  }

  /**
   * Eagerly syncs a single membership change into the DO-local Member table.
   *
   * Callers invoke this **directly** (not via queue) immediately after the
   * corresponding better-auth API call mutates D1, so the user gains (or
   * loses) access to the organization agent without waiting for queue
   * delivery.  Failures are **non-fatal** — callers should catch errors and
   * fall through to the already-enqueued {@link onFinalizeMembershipSync}
   * which will reconcile later.
   *
   * Expected call order in server functions:
   * 1. `enqueue(FinalizeMembershipSync)` — durable safety net
   * 2. `auth.api.<mutation>()` — D1 updated
   * 3. `stub.syncMembership()` — eager sync (best-effort)
   */
  syncMembership(input: {
    userId: Domain.User["id"];
    change: MembershipSyncChange;
  }) {
    return this.runEffect(
      syncMembershipImpl("syncMembership", this, input),
    );
  }

  /**
   * Queue-delivered finalization handler that verifies D1 and the DO-local
   * Member table are aligned for a specific membership change.
   *
   * Enqueued **before** the better-auth API call to guarantee the message is
   * durable even if the process crashes mid-mutation. Because D1 is
   * validated on every invocation, this is safe under at-least-once delivery,
   * reordering, and race conditions with {@link syncMembership}:
   *
   * - If eager sync already succeeded, finalization is a no-op.
   * - If eager sync failed or was skipped (crash between API call and eager
   *   sync), finalization applies the change.
   * - If the API call itself failed (D1 unchanged), finalization detects the
   *   mismatch and rejects the stale event.
   */
  onFinalizeMembershipSync(input: {
    userId: Domain.User["id"];
    change: MembershipSyncChange;
  }) {
    return this.runEffect(
      syncMembershipImpl("onFinalizeMembershipSync", this, input),
    );
  }

  saveInvoiceExtraction(input: {
    invoiceId: Invoice["id"];
    idempotencyKey: string;
    invoiceExtraction: InvoiceExtraction;
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
          Schema.Struct({
            action: ActivityAction,
            level: Schema.Literals(["info", "success", "error"]),
            text: Schema.String,
          }),
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
        yield* authorizeConnection();
        const repo = yield* OrganizationRepository;
        return yield* repo.getInvoices();
      }),
    );
  }

  @callable()
  getInvoice(input: typeof GetInvoiceInput.Type) {
    return this.runEffect(
      Effect.gen(function* () {
        yield* authorizeConnection();
        const { invoiceId } =
          yield* Schema.decodeUnknownEffect(GetInvoiceInput)(input);
        const repo = yield* OrganizationRepository;
        return yield* repo
          .getInvoice(invoiceId)
          .pipe(Effect.map(Option.getOrNull));
      }),
    );
  }
}

/**
 * Shared implementation for {@link OrganizationAgent.syncMembership} and
 * {@link OrganizationAgent.onFinalizeMembershipSync}.
 *
 * Reads the member's current state from D1 (authoritative) and aligns the
 * DO-local Member table accordingly. The `change` hint is validated against
 * D1 to guard against stale or reordered events:
 *
 * - `added` / `role_changed`: D1 must contain the member → upsert locally.
 * - `removed`: D1 must **not** contain the member → delete locally.
 *
 * If D1 contradicts the requested change the effect fails with
 * {@link OrganizationAgentError}, which causes queue retries when called
 * from `onFinalizeMembershipSync` and is safely caught when called from
 * `syncMembership`.
 */
const syncMembershipImpl = Effect.fn("OrganizationAgent.syncMembership")(
  function* (
    caller: string,
    agent: OrganizationAgent,
    input: { userId: Domain.User["id"]; change: MembershipSyncChange },
  ) {
    const organizationId = yield* Schema.decodeUnknownEffect(
      Domain.Organization.fields.id,
    )(agent.name);
    yield* Effect.logInfo(caller, {
      organizationId,
      userId: input.userId,
      change: input.change,
    });
    const repository = yield* Repository;
    const d1Member = yield* repository.getMemberByUserAndOrg({
      userId: input.userId,
      organizationId,
    });
    yield* Effect.logInfo(`${caller}.d1Check`, {
      d1MemberFound: Option.isSome(d1Member),
      change: input.change,
    });
    const repo = yield* OrganizationRepository;
    switch (input.change) {
      case "added":
      case "role_changed": {
        if (Option.isNone(d1Member))
          return yield* new OrganizationAgentError({
            message: `D1 has no member for userId=${input.userId} organizationId=${organizationId} (change=${input.change})`,
          });
        return yield* repo.upsertMember({
          userId: input.userId,
          role: d1Member.value.role,
        });
      }
      case "removed": {
        if (Option.isSome(d1Member))
          return yield* new OrganizationAgentError({
            message: `D1 still has member for userId=${input.userId} organizationId=${organizationId} (change=removed)`,
          });
        yield* repo.deleteMember(input.userId);
        yield* Effect.forEach(
          agent.getConnections<OrganizationAgentConnectionState>(),
          (conn) =>
            conn.state?.userId === input.userId
              ? Effect.try({
                  try: () => { conn.close(4003, "Membership revoked"); },
                  catch: (error) => new OrganizationAgentError({ message: error instanceof Error ? error.message : String(error) }),
                }).pipe(Effect.catch((error) => Effect.logWarning("conn.close failed", error)))
              : Effect.void,
          { discard: true },
        );
      }
    }
  },
);

const getConnectionIdentity = Effect.fn(
  "OrganizationAgent.getConnectionIdentity",
)(function* () {
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
});

const authorizeConnection = Effect.fn("OrganizationAgent.authorizeConnection")(
  function* () {
    const { connection } = getCurrentAgent<OrganizationAgent>();
    if (!connection) return;
    const identity = yield* getConnectionIdentity();
    const repo = yield* OrganizationRepository;
    const authorized = yield* repo.isMember(
      identity.userId as Domain.User["id"],
    );
    if (!authorized) {
      yield* Effect.logWarning("authorizeConnection.forbidden", {
        userId: identity.userId,
      });
      return yield* new OrganizationAgentError({
        message: `Forbidden: userId=${identity.userId} not in Member table`,
      });
    }
    return identity;
  },
);
