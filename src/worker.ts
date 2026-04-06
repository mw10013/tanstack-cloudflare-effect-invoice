import { isNotFound, isRedirect } from "@tanstack/react-router";
import serverEntry from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";
import {
  Cause,
  ConfigProvider,
  Effect,
  Layer,
  ServiceMap,
} from "effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { KV } from "@/lib/KV";
import { makeLoggerLayer } from "@/lib/LoggerLayer";
import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { R2 } from "@/lib/R2";
import { Repository } from "@/lib/Repository";
import { Request as AppRequest } from "@/lib/Request";
import { Stripe } from "@/lib/Stripe";
import {
  extractAgentInstanceName,
  organizationAgentAuthHeaders,
} from "./organization-agent";

export { InvoiceExtractionWorkflow } from "./invoice-extraction-workflow";
export { OrganizationAgent } from "./organization-agent";

const makeEnvLayer = (env: Env) =>
  Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );

/**
 * Runs an Effect within the full app layer for HTTP request handlers (fetch,
 * server functions), converting failures to throwable values compatible with
 * TanStack Start's server function error serialization.
 *
 * Uses `runPromiseExit` instead of `runPromise` to inspect the `Exit` and
 * ensure the thrown value is always an `Error` instance (which TanStack Start
 * can serialize via seroval). Raw non-Error values from `Effect.fail` would
 * otherwise pass through `causeSquash` unboxed and fail the client-side
 * `instanceof Error` check, producing an opaque "unexpected error" message.
 *
 * TanStack `redirect`/`notFound` objects placed in the defect channel via
 * `Effect.die` are detected and re-thrown as-is so TanStack's control flow
 * (HTTP 307 redirects, 404 not-found handling) works from within Effect
 * pipelines.
 *
 * **Error message preservation:** TanStack Router's `ShallowErrorPlugin`
 * (seroval plugin used during SSR dehydration) serializes ONLY `.message`
 * from Error objects — `.name`, `._tag`, `.stack`, and all custom properties
 * are stripped. On the client it reconstructs `new Error(message)`. Effect v4
 * errors like `NoSuchElementError` set `.name` on the prototype and often
 * have `.message = undefined` (own property via `Object.assign`), so after
 * dehydration the client receives a bare `Error` with an empty message.
 * To ensure the error boundary always has something meaningful to display,
 * we normalize the thrown Error to always carry a non-empty `.message`,
 * using `Cause.pretty` which includes the error name and server-side stack
 * trace. This causes some duplication in the browser (the client-generated
 * `.stack` echoes `.message` in V8 environments) but preserves the full
 * server context that would otherwise be lost after `ShallowErrorPlugin`
 * strips everything except `.message`.
 */
const makeRunEffect = (env: Env, request: Request) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const kvLayer = Layer.provideMerge(KV.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const d1KvLayer = Layer.merge(d1Layer, kvLayer);
  const stripeLayer = Layer.provideMerge(
    Stripe.layer,
    Layer.merge(repositoryLayer, d1KvLayer),
  );
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
  const requestLayer = Layer.succeedServices(
    ServiceMap.make(AppRequest, request),
  );
  const authRequestLayer = Layer.merge(authLayer, requestLayer);
  const authRequestR2Layer = Layer.merge(authRequestLayer, r2Layer);
  const runtimeLayer = Layer.merge(authRequestR2Layer, makeLoggerLayer(env));
  return async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ): Promise<A> => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(effect, runtimeLayer),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
    // oxlint-disable-next-line @typescript-eslint/only-throw-error -- redirect is a Response, notFound is a plain object; TanStack expects these thrown as-is
    if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
    const pretty = Cause.pretty(exit.cause);
    if (squashed instanceof Error) {
      if (!squashed.message) squashed.message = pretty;
      throw squashed;
    }
    throw new Error(pretty);
  };
};

/**
 * Per-request context injected by `serverEntry.fetch` and typed via Start's
 * `Register.server.requestContext`.
 *
 * Server functions consume this through `context` in handlers
 * (`createServerFn(...).handler(({ context }) => ...)`), so per-request
 * runtime data is available without importing
 * `@tanstack/react-start/server`.
 *
 * Why avoid that import in route modules: `@tanstack/react-start/server` is a
 * barrel that re-exports SSR stream/runtime modules, which pull Node builtins
 * (`node:stream`, `node:stream/web`, `node:async_hooks`) into the client build
 * graph and can trigger Rollup errors like:
 * `"Readable" is not exported by "__vite-browser-external"`.
 *
 * References:
 * - Import Protection (why imports can stay alive):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/import-protection#common-pitfall-why-some-imports-stay-alive
 * - Server Entry Point request context (this pattern):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point#request-context
 */
export interface ServerContext {
  env: Env;
  runEffect: ReturnType<typeof makeRunEffect>;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: ServerContext };
  }
}

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

const membershipSyncChangeValues = ["added", "removed", "role_changed"] as const;

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
  idempotencyKey: Schema.NonEmptyString,
  fileName: Schema.optionalKey(Schema.NonEmptyString),
  contentType: Schema.optionalKey(Schema.NonEmptyString),
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
      fileName: metadata.fileName ?? "unknown",
      contentType: metadata.contentType ?? "application/octet-stream",
    }),
  );
});

const processInvoiceDelete = Effect.fn("processInvoiceDelete")(function* (
  notification: typeof invoiceDeleteQueueMessageSchema.Type,
) {
  const stub = yield* getOrganizationAgentStub(notification.organizationId);
  yield* Effect.tryPromise(() => stub.deleteInvoiceRecord(notification.invoiceId));
  if (!notification.r2ObjectKey) return;
  const r2 = yield* R2;
  yield* r2.delete(notification.r2ObjectKey);
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
  const notification = yield* Schema.decodeUnknownEffect(queueMessageSchema)(messageBody);
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

const authorizeAgentRequest = Effect.fn("authorizeAgentRequest")(function* (
  request: Request,
) {
  const auth = yield* Auth;
  const session = yield* auth.getSession(request.headers);
  if (Option.isNone(session)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const agentName = extractAgentInstanceName(request);
  const activeOrganizationId = session.value.session.activeOrganizationId;
  if (!activeOrganizationId || agentName !== activeOrganizationId) {
    return new Response("Forbidden", { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set(organizationAgentAuthHeaders.userId, session.value.user.id);
  return new Request(request, { headers });
});

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    console.log(`[${new Date().toISOString()}] fetch: ${request.url}`);
    const isMagicLinkRequest =
      (url.pathname === "/login" && request.method === "POST") ||
      url.pathname === "/api/auth/magic-link/verify";
    if (isMagicLinkRequest) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
    }
    const runEffect = makeRunEffect(env, request);
    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: (req) => runEffect(authorizeAgentRequest(req)),
      onBeforeRequest: (req) => runEffect(authorizeAgentRequest(req)),
    });
    if (routed) {
      return routed;
    }
    return serverEntry.fetch(request, {
      context: {
        env,
        runEffect,
      },
    });
  },

  async scheduled(scheduledEvent, env, _ctx) {
    const envLayer = makeEnvLayer(env);
    const d1Layer = Layer.provideMerge(D1.layer, envLayer);
    const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
    const runtimeLayer = Layer.merge(repositoryLayer, makeLoggerLayer(env));
    await Effect.gen(function* () {
      switch (scheduledEvent.cron) {
        case "0 0 * * *": {
          const repository = yield* Repository;
          const deletedCount = yield* repository.deleteExpiredSessions();
          yield* Effect.logInfo("session.cleanup.expired", {
            deletedCount,
          });
          break;
        }
        default: {
          yield* Effect.logWarning(
            "session.cleanup.unexpectedCronSchedule",
            { cron: scheduledEvent.cron },
          );
          break;
        }
      }
    }).pipe(Effect.provide(runtimeLayer), Effect.runPromise);
  },

  async queue(batch, env) {
    const envLayer = makeEnvLayer(env);
    const d1Layer = Layer.provideMerge(D1.layer, envLayer);
    const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
    const r2Layer = Layer.provideMerge(R2.layer, envLayer);
    const runtimeLayer = Layer.mergeAll(r2Layer, repositoryLayer, makeLoggerLayer(env));
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
    ).pipe(Effect.provide(runtimeLayer), Effect.runPromise);
  },
} satisfies ExportedHandler<Env>;
