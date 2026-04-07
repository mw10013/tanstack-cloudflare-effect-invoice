import { Effect, Layer } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { R2 } from "@/lib/R2";
import { Repository } from "@/lib/Repository";

const r2QueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["PutObject"]),
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

const invoiceDeleteQueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["DeleteInvoice"]),
  organizationId: Domain.Organization.fields.id,
  invoiceId: OrganizationDomain.Invoice.fields.id,
  r2ObjectKey: OrganizationDomain.Invoice.fields.r2ObjectKey,
});

const membershipSyncChangeValues = [
  "added",
  "removed",
  "role_changed",
] as const;

export const membershipSyncQueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["MembershipSync"]),
  organizationId: Domain.Organization.fields.id,
  userId: Domain.User.fields.id,
  change: Schema.Literals(membershipSyncChangeValues),
});

const queueMessageSchema = Schema.Union([
  r2QueueMessageSchema,
  invoiceDeleteQueueMessageSchema,
  membershipSyncQueueMessageSchema,
]);

const r2ObjectCustomMetadataSchema = Schema.Struct({
  organizationId: Domain.Organization.fields.id,
  invoiceId: OrganizationDomain.Invoice.fields.id,
  idempotencyKey: OrganizationDomain.InvoiceIdempotencyKey,
  fileName: OrganizationDomain.Invoice.fields.fileName.check(Schema.isNonEmpty()),
  contentType: OrganizationDomain.Invoice.fields.contentType.check(
    Schema.isNonEmpty(),
  ),
});

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
 * `eventTime`, so this handler reads object custom metadata via `R2.head()`
 * before forwarding the upload event to the organization Durable Object.
 */
const processInvoiceUpload = Effect.fn("processInvoiceUpload")(function* (
  notification: typeof r2QueueMessageSchema.Type,
) {
  const r2 = yield* R2;
  const head = yield* r2.head(notification.object.key);
  if (Option.isNone(head)) {
    yield* Effect.logWarning(
      "R2 object deleted before notification processed",
      { key: notification.object.key },
    );
    return;
  }
  const metadata = yield* Schema.decodeUnknownEffect(
    r2ObjectCustomMetadataSchema,
  )(head.value.customMetadata ?? {});
  const stub = yield* getOrganizationAgentStub(metadata.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onInvoiceUpload({
      invoiceId: metadata.invoiceId,
      r2ActionTime: notification.eventTime,
      idempotencyKey: metadata.idempotencyKey,
      r2ObjectKey: notification.object.key,
      fileName: metadata.fileName,
      contentType: metadata.contentType,
    }),
  );
});

const processInvoiceDelete = Effect.fn("processInvoiceDelete")(function* (
  message: typeof invoiceDeleteQueueMessageSchema.Type,
) {
  const stub = yield* getOrganizationAgentStub(message.organizationId);
  yield* Effect.tryPromise(() =>
    stub.deleteInvoiceById(message.invoiceId),
  );
  if (!message.r2ObjectKey) return;
  const r2 = yield* R2;
  yield* r2.delete(message.r2ObjectKey);
});

const processMembershipSync = Effect.fn("processMembershipSync")(function* (
  notification: typeof membershipSyncQueueMessageSchema.Type,
) {
  yield* Effect.logInfo("processMembershipSync", {
    organizationId: notification.organizationId,
    userId: notification.userId,
    change: notification.change,
  });
  const repository = yield* Repository;
  const d1Member = yield* repository.getMemberByUserAndOrg({
    userId: notification.userId,
    organizationId: notification.organizationId,
  });
  yield* Effect.logInfo("processMembershipSync.d1Check", {
    d1MemberFound: Option.isSome(d1Member),
    change: notification.change,
  });
  switch (notification.change) {
    case "added":
    case "role_changed": {
      if (Option.isNone(d1Member)) {
        return yield* new MembershipSyncNotAlignedError({
          message: `D1 has no member for userId=${notification.userId} organizationId=${notification.organizationId} (change=${notification.change})`,
        });
      }
      const stub = yield* getOrganizationAgentStub(notification.organizationId);
      yield* Effect.tryPromise(() =>
        stub.onMembershipChanged({
          userId: notification.userId,
          role: d1Member.value.role,
          change: notification.change,
        }),
      );
      break;
    }
    case "removed": {
      if (Option.isSome(d1Member)) {
        return yield* new MembershipSyncNotAlignedError({
          message: `D1 still has member for userId=${notification.userId} organizationId=${notification.organizationId} (change=removed)`,
        });
      }
      const stub = yield* getOrganizationAgentStub(notification.organizationId);
      yield* Effect.tryPromise(() =>
        stub.onMembershipChanged({
          userId: notification.userId,
          role: "member",
          change: "removed",
        }),
      );
    }
  }
});

class MembershipSyncNotAlignedError extends Schema.TaggedErrorClass<MembershipSyncNotAlignedError>()(
  "MembershipSyncNotAlignedError",
  { message: Schema.String },
) {}

const processQueueMessage = Effect.fn("processQueueMessage")(function* (
  messageBody: unknown,
) {
  const notification =
    yield* Schema.decodeUnknownEffect(queueMessageSchema)(messageBody);
  switch (notification.action) {
    case "DeleteInvoice": {
      return yield* processInvoiceDelete(notification);
    }
    case "PutObject": {
      return yield* processInvoiceUpload(notification);
    }
    case "MembershipSync": {
      return yield* processMembershipSync(notification);
    }
  }
});

const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  return Layer.mergeAll(r2Layer, repositoryLayer, makeLoggerLayer(env));
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
