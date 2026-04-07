import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import * as OrganizationDomain from "@/lib/OrganizationDomain";

const R2PutObjectNotificationSchema = Schema.Struct({
  action: Schema.Literals(["PutObject"]),
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

const FinalizeInvoiceDeletionQueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["FinalizeInvoiceDeletion"]),
  organizationId: Domain.Organization.fields.id,
  invoiceId: OrganizationDomain.Invoice.fields.id,
  r2ObjectKey: OrganizationDomain.Invoice.fields.r2ObjectKey,
});

const membershipSyncChangeValues = [
  "added",
  "removed",
  "role_changed",
] as const;

export const MembershipSyncQueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["MembershipSync"]),
  organizationId: Domain.Organization.fields.id,
  userId: Domain.User.fields.id,
  change: Schema.Literals(membershipSyncChangeValues),
});

export const sendMembershipSync = Effect.fn("sendMembershipSync")(function* (
  input: Omit<typeof MembershipSyncQueueMessageSchema.Type, "action">,
) {
  const env = yield* CloudflareEnv;
  const message: typeof MembershipSyncQueueMessageSchema.Type = {
    action: "MembershipSync",
    organizationId: input.organizationId,
    userId: input.userId,
    change: input.change,
  };
  yield* Effect.tryPromise(() => env.Q.send(message));
});

const QueueMessageSchema = Schema.Union([
  R2PutObjectNotificationSchema,
  FinalizeInvoiceDeletionQueueMessageSchema,
  MembershipSyncQueueMessageSchema,
]);

// Queue handlers create stubs directly. Unlike routeAgentRequest(), that path
// does not populate the Agents SDK instance name, so name-dependent features
// like workflows can throw until we set it explicitly. See
// https://github.com/cloudflare/workerd/issues/2240.
const getOrganizationAgentStub = Effect.fn("getOrganizationAgentStub")(
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
  notification: typeof R2PutObjectNotificationSchema.Type,
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
)(function* (message: typeof FinalizeInvoiceDeletionQueueMessageSchema.Type) {
  const stub = yield* getOrganizationAgentStub(message.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onDeleteInvoice({
      invoiceId: message.invoiceId,
      r2ObjectKey: message.r2ObjectKey,
    }),
  );
});

const processMembershipSync = Effect.fn("processMembershipSync")(function* (
  message: typeof MembershipSyncQueueMessageSchema.Type,
) {
  const stub = yield* getOrganizationAgentStub(message.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onMembershipSync({
      userId: message.userId,
      change: message.change,
    }),
  );
});

const processQueueMessage = Effect.fn("processQueueMessage")(function* (
  messageBody: unknown,
) {
  const message =
    yield* Schema.decodeUnknownEffect(QueueMessageSchema)(messageBody);
  switch (message.action) {
    case "FinalizeInvoiceDeletion": {
      return yield* processFinalizeInvoiceDeletion(message);
    }
    case "PutObject": {
      return yield* processInvoiceUpload(message);
    }
    case "MembershipSync": {
      return yield* processMembershipSync(message);
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
    (message) =>
      processQueueMessage(message.body).pipe(
        Effect.andThen(() =>
          Effect.sync(() => {
            message.ack();
          }),
        ),
        Effect.catchTag("SchemaError", () =>
          Effect.sync(() => {
            message.ack();
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            message.retry();
          }),
        ),
      ),
  ).pipe(Effect.provide(makeRuntimeLayer(env)), Effect.runPromise);
};
