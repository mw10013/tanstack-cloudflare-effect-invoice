import { isNotFound, isRedirect } from "@tanstack/react-router";
import serverEntry from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";
import {
  Cause,
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  References,
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
import { R2 } from "@/lib/R2";
import { Repository } from "@/lib/Repository";
import { Request as AppRequest } from "@/lib/Request";
import { Stripe } from "@/lib/Stripe";
import { extractAgentInstanceName } from "./organization-agent";

export { GeminiInvoiceExtractionWorkflow, InvoiceExtractionWorkflow, OrganizationAgent } from "./organization-agent";

const makeEnvLayer = (env: Env) =>
  Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );

const makeLoggerLayer = (env: Env) => {
  const environment = Schema.decodeUnknownSync(Domain.Environment)(
    env.ENVIRONMENT,
  );
  return Layer.merge(
    Logger.layer(
      environment === "production"
        ? [Logger.consoleJson, Logger.tracerLogger]
        : [Logger.consolePretty(), Logger.tracerLogger],
      { mergeWithExisting: false },
    ),
    Layer.succeed(
      References.MinimumLogLevel,
      environment === "production" ? "Info" : "Debug",
    ),
  );
};

const makeScheduledRunEffect = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const runtimeLayer = Layer.merge(repositoryLayer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ) => Effect.runPromise(Effect.provide(effect, runtimeLayer));
};

/**
 * Runs an HTTP Effect within the app layer, converting failures to throwable
 * values compatible with TanStack Start's server function error serialization.
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
const makeHttpRunEffect = (env: Env, request: Request) => {
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
  runEffect: ReturnType<typeof makeHttpRunEffect>;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: ServerContext };
  }
}

const r2QueueMessageSchema = Schema.Struct({
  action: Schema.NonEmptyString,
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

const r2ObjectCustomMetadataSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
  invoiceId: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  fileName: Schema.optionalKey(Schema.NonEmptyString),
  contentType: Schema.optionalKey(Schema.NonEmptyString),
});

const parseInvoiceObjectKey = (key: string) => {
  const [organizationId, collection, invoiceId] = key.split("/");
  if (!organizationId || collection !== "invoices" || !invoiceId) return;
  return { organizationId, invoiceId };
};

const formatQueueError = (error: unknown) =>
  error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);

const getOrganizationAgentStub = async (env: Env, organizationId: string) => {
  const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
  const stub = env.ORGANIZATION_AGENT.get(id);
  // Queue handlers create stubs directly. Unlike routeAgentRequest(), that path
  // does not populate the Agents SDK instance name, so name-dependent features
  // like workflows can throw until we set it explicitly. See
  // https://github.com/cloudflare/workerd/issues/2240.
  await stub.setName(organizationId);
  return stub;
};

const handleInvoiceDelete = async ({
  env,
  message,
  notification,
}: {
  env: Env;
  message: MessageBatch["messages"][number];
  notification: typeof r2QueueMessageSchema.Type;
}) => {
  const parsed = parseInvoiceObjectKey(notification.object.key);
  if (!parsed) {
    console.error("Invalid invoice delete object key:", {
      key: notification.object.key,
    });
    message.ack();
    return;
  }
  try {
    const stub = await getOrganizationAgentStub(env, parsed.organizationId);
    await stub.onInvoiceDelete({
      invoiceId: parsed.invoiceId,
      eventTime: notification.eventTime,
      r2ObjectKey: notification.object.key,
    });
    message.ack();
  } catch (error) {
    console.error("queue onInvoiceDelete failed", {
      key: notification.object.key,
      organizationId: parsed.organizationId,
      invoiceId: parsed.invoiceId,
      error: formatQueueError(error),
    });
    message.retry();
  }
};

const handleInvoiceUpload = async ({
  env,
  message,
  notification,
}: {
  env: Env;
  message: MessageBatch["messages"][number];
  notification: typeof r2QueueMessageSchema.Type;
}) => {
  const head = await env.R2.head(notification.object.key);
  if (!head) {
    console.warn(
      "R2 object deleted before notification processed:",
      notification.object.key,
    );
    message.ack();
    return;
  }
  const metadataResult = Schema.decodeUnknownExit(r2ObjectCustomMetadataSchema)(
    head.customMetadata ?? {},
  );
  if (Exit.isFailure(metadataResult)) {
    console.error("Invalid customMetadata on R2 object:", {
      key: notification.object.key,
      cause: String(metadataResult.cause),
      customMetadata: head.customMetadata,
    });
    message.ack();
    return;
  }
  const {
    organizationId,
    invoiceId,
    idempotencyKey,
    fileName,
    contentType,
  } = metadataResult.value;
  try {
    const stub = await getOrganizationAgentStub(env, organizationId);
    await stub.onInvoiceUpload({
      invoiceId,
      eventTime: notification.eventTime,
      idempotencyKey,
      r2ObjectKey: notification.object.key,
      fileName: fileName ?? "unknown",
      contentType: contentType ?? "application/octet-stream",
    });
    message.ack();
  } catch (error) {
    console.error("queue onInvoiceUpload failed", {
      key: notification.object.key,
      organizationId,
      invoiceId,
      idempotencyKey,
      error: formatQueueError(error),
    });
    message.retry();
  }
};

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
    const runEffect = makeHttpRunEffect(env, request);
    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: async (req) => {
        const session = await runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            return yield* auth.getSession(req.headers);
          }),
        );
        if (Option.isNone(session)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const agentName = extractAgentInstanceName(req);
        const activeOrganizationId = session.value.session.activeOrganizationId;
        if (!activeOrganizationId || agentName !== activeOrganizationId) {
          return new Response("Forbidden", { status: 403 });
        }
      },
      onBeforeRequest: async (req) => {
        const session = await runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            return yield* auth.getSession(req.headers);
          }),
        );
        if (Option.isNone(session)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const agentName = extractAgentInstanceName(req);
        const activeOrganizationId = session.value.session.activeOrganizationId;
        if (!activeOrganizationId || agentName !== activeOrganizationId) {
          return new Response("Forbidden", { status: 403 });
        }
      },
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
    const runEffect = makeScheduledRunEffect(env);
    switch (scheduledEvent.cron) {
      case "0 0 * * *": {
        await runEffect(
          Effect.gen(function* () {
            const repository = yield* Repository;
            const deletedCount = yield* repository.deleteExpiredSessions();
            yield* Effect.logInfo("session.cleanup.expired", { deletedCount });
          }),
        );
        break;
      }
      default: {
        await runEffect(
          Effect.logWarning("session.cleanup.unexpectedCronSchedule", {
            cron: scheduledEvent.cron,
          }),
        );
        break;
      }
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const result = Schema.decodeUnknownExit(r2QueueMessageSchema)(
        message.body,
      );
      if (Exit.isFailure(result)) {
        console.error("Invalid R2 queue message body", {
          messageId: message.id,
          cause: String(result.cause),
          body: message.body,
        });
        message.ack();
      } else {
        const notification = result.value;
        if (
          notification.action !== "PutObject" &&
          notification.action !== "DeleteObject"
        ) {
          message.ack();
        } else if (notification.action === "DeleteObject") {
          await handleInvoiceDelete({ env, message, notification });
        } else {
          await handleInvoiceUpload({ env, message, notification });
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
