import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import * as OrganizationDomain from "@/lib/OrganizationDomain";

const R2PutObjectNotification = Schema.Struct({
  action: Schema.Literals(["PutObject"]),
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

const FinalizeInvoiceDeletionQueueMessage = Schema.Struct({
  action: Schema.Literals(["FinalizeInvoiceDeletion"]),
  organizationId: Domain.Organization.fields.id,
  invoiceId: OrganizationDomain.Invoice.fields.id,
  r2ObjectKey: OrganizationDomain.Invoice.fields.r2ObjectKey,
});

export const membershipSyncChangeValues = [
  "added",
  "removed",
  "role_changed",
] as const;

export const MembershipSyncChange = Schema.Literals(membershipSyncChangeValues);

export type MembershipSyncChange = typeof MembershipSyncChange.Type;

export const FinalizeMembershipSyncQueueMessage = Schema.Struct({
  action: Schema.Literals(["FinalizeMembershipSync"]),
  organizationId: Domain.Organization.fields.id,
  userId: Domain.User.fields.id,
  change: MembershipSyncChange,
});

export const QueueMessage = Schema.Union([
  R2PutObjectNotification,
  FinalizeInvoiceDeletionQueueMessage,
  FinalizeMembershipSyncQueueMessage,
]);

export type QueueMessage = typeof QueueMessage.Type;

export const enqueue = Effect.fn("enqueue")(function* (message: QueueMessage) {
  const env = yield* CloudflareEnv;
  yield* Effect.tryPromise(() => env.Q.send(message));
});

// Queue handlers create stubs directly. Unlike routeAgentRequest(), that path
// does not populate the Agents SDK instance name, so name-dependent features
// like workflows can throw until we set it explicitly. See
// https://github.com/cloudflare/workerd/issues/2240.
export const getOrganizationAgentStub = Effect.fn("getOrganizationAgentStub")(
  function* (organizationId: Domain.Organization["id"]) {
    const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
    const id = ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = ORGANIZATION_AGENT.get(id);
    yield* Effect.tryPromise(() => stub.setName(organizationId));
    return stub;
  },
);

/**
 * Handles Cloudflare R2 event notification messages for object uploads.
 *
 * This function processes queue messages where `action` is `PutObject`.
 * Cloudflare's R2 notification payload includes `action`, `object.key`, and
 * `eventTime`, so this handler routes the event to the organization Durable
 * Object and leaves R2 metadata reads to `onInvoiceUpload`.
 */
const processInvoiceUpload = Effect.fn("processInvoiceUpload")(function* (
  notification: typeof R2PutObjectNotification.Type,
) {
  const [organizationId] = notification.object.key.split("/", 1);
  const stub = yield* getOrganizationAgentStub(
    yield* Schema.decodeUnknownEffect(Domain.Organization.fields.id)(
      organizationId,
    ),
  );
  yield* Effect.tryPromise(() =>
    stub.onInvoiceUpload({
      r2ActionTime: notification.eventTime,
      r2ObjectKey: notification.object.key,
    }),
  );
});

const processFinalizeInvoiceDeletion = Effect.fn(
  "processFinalizeInvoiceDeletion",
)(function* (message: typeof FinalizeInvoiceDeletionQueueMessage.Type) {
  const stub = yield* getOrganizationAgentStub(message.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onFinalizeInvoiceDeletion({
      invoiceId: message.invoiceId,
      r2ObjectKey: message.r2ObjectKey,
    }),
  );
});

const processFinalizeMembershipSync = Effect.fn(
  "processFinalizeMembershipSync",
)(function* (message: typeof FinalizeMembershipSyncQueueMessage.Type) {
  const stub = yield* getOrganizationAgentStub(message.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onFinalizeMembershipSync({
      userId: message.userId,
      change: message.change,
    }),
  );
});

const processMessage = Effect.fn("processMessage")(function* (
  rawMessage: unknown,
) {
  const message = yield* Schema.decodeUnknownEffect(QueueMessage)(rawMessage);
  switch (message.action) {
    case "FinalizeInvoiceDeletion": {
      return yield* processFinalizeInvoiceDeletion(message);
    }
    case "PutObject": {
      return yield* processInvoiceUpload(message);
    }
    case "FinalizeMembershipSync": {
      return yield* processFinalizeMembershipSync(message);
    }
  }
});

const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  return Layer.mergeAll(envLayer, makeLoggerLayer(env));
};

export const queue: ExportedHandler<Env>["queue"] = async (batch, env) => {
  await Effect.forEach(
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is not Array.prototype.forEach
    batch.messages,
    (queueMessage) =>
      processMessage(queueMessage.body).pipe(
        Effect.andThen(() =>
          Effect.sync(() => {
            queueMessage.ack();
          }),
        ),
        Effect.catchTag("SchemaError", () =>
          Effect.sync(() => {
            queueMessage.ack();
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            queueMessage.retry();
          }),
        ),
      ),
  ).pipe(Effect.provide(makeRuntimeLayer(env)), Effect.runPromise);
};
