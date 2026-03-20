# Queue Handler → Effect v4 Migration Research

## Current State

`worker.ts` queue handler (lines 384–410) is raw async/await with manual `Schema.decodeUnknownExit`, `console.error`/`console.warn`, and direct `env.R2.head()` calls. The `fetch` and `scheduled` handlers already use Effect v4 via `makeHttpRunEffect` / `makeScheduledRunEffect`.

## Key Decisions

### 1. No Queue service

The queue handler is a top-level entry point (like `fetch`/`scheduled`), not a reusable service dependency. Follow the existing pattern: build layers, `Effect.provide`, `Effect.runPromise`.

### 2. Layer stack

Queue handler accesses:
- `env.R2.head()` → **R2 service**
- `env.ORGANIZATION_AGENT` → **CloudflareEnv** binding
- `console.error/warn` → **Effect.logError / Effect.logWarning**

```
CloudflareEnv (env)
├── R2 (for head() call in handleInvoiceUpload)
└── Logger (env-aware pretty/json)
```

No D1, KV, Auth, Stripe, Repository, or Request needed.

### 3. Single Effect, no runEffect helper

Unlike `fetch` which needs to kick off individual effects per server function, the queue handler is a single batch operation. One `Effect.gen` that iterates over all messages using `Effect.forEach`. No `makeQueueRunEffect` helper needed — just build the layer and `Effect.runPromise(Effect.provide(effect, layer))`.

### 4. Ack/retry inside Effect

Each message is processed inside the Effect pipeline. Per-message logic:
- `processQueueMessage` succeeds → `message.ack()` via `Effect.sync`
- `SchemaError` (bad body or bad metadata) → catch with `Effect.catchTag("SchemaError", ...)`, ack
- Any other error (stub call failed, R2 error) → catch-all, `message.retry()` via `Effect.sync`

This keeps all control flow (including ack/retry) within Effect.

Pattern per message using `Effect.matchEffect` on `Effect.exit`:
```ts
yield* Effect.forEach(batch.messages, (message) =>
  processQueueMessage(message.body).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => message.ack()),
      onFailure: (error) =>
        Schema.isSchemaError(error)
          ? Effect.sync(() => message.ack())
          : Effect.sync(() => message.retry()),
    }),
  ),
);
```

Wait — `matchEffect` receives the typed error `E`, not `unknown`. `processQueueMessage` error type is `SchemaError | UnknownException | R2Error`. So `SchemaError` check works via `_tag` match. But using `Effect.catchTag` + `Effect.catch` is more idiomatic:

```ts
yield* Effect.forEach(batch.messages, (message) =>
  processQueueMessage(message.body).pipe(
    Effect.andThen(() => Effect.sync(() => message.ack())),
    Effect.catchTag("SchemaError", () => Effect.sync(() => message.ack())),
    Effect.catch(() => Effect.sync(() => message.retry())),
  ),
);
```

This is cleaner: success → ack, schema error → ack, everything else → retry.

### 5. `getOrganizationAgentStub` via CloudflareEnv

Access `ORGANIZATION_AGENT` binding through `CloudflareEnv` service. No typed error — let failures be defects (untyped `UnknownException` from `Effect.tryPromise`).

### 6. No string env var changes needed

Queue handler doesn't read string env vars. Only bindings.

### 7. No `ParseError` distinction

Don't distinguish bad-queue-body from bad-R2-metadata. Both ack (not retryable). Same as current behavior.

### 8. `formatQueueError` removed

`Cause.pretty` via Effect's structured logging replaces it.

## Implementation Plan

### `getOrganizationAgentStub`

```ts
// Queue handlers create stubs directly. Unlike routeAgentRequest(), that path
// does not populate the Agents SDK instance name, so name-dependent features
// like workflows can throw until we set it explicitly. See
// https://github.com/cloudflare/workerd/issues/2240.
const getOrganizationAgentStub = Effect.fn("getOrganizationAgentStub")(
  function* (organizationId: string) {
    const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
    const id = ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = ORGANIZATION_AGENT.get(id);
    yield* Effect.tryPromise(() => stub.setName(organizationId));
    return stub;
  },
);
```

### Effectified message processors

```ts
const processInvoiceDelete = Effect.fn("processInvoiceDelete")(function* (
  notification: typeof r2QueueMessageSchema.Type,
) {
  const parsed = parseInvoiceObjectKey(notification.object.key);
  if (!parsed) {
    yield* Effect.logError("Invalid invoice delete object key", {
      key: notification.object.key,
    });
    return;
  }
  const stub = yield* getOrganizationAgentStub(parsed.organizationId);
  yield* Effect.tryPromise(() =>
    stub.onInvoiceDelete({
      invoiceId: parsed.invoiceId,
      r2ActionTime: notification.eventTime,
      r2ObjectKey: notification.object.key,
    }),
  );
});

const processInvoiceUpload = Effect.fn("processInvoiceUpload")(function* (
  notification: typeof r2QueueMessageSchema.Type,
) {
  const r2 = yield* R2;
  const head = yield* r2.head(notification.object.key);
  if (Option.isNone(head)) {
    yield* Effect.logWarning("R2 object deleted before notification processed", {
      key: notification.object.key,
    });
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

const processQueueMessage = Effect.fn("processQueueMessage")(function* (
  messageBody: unknown,
) {
  const notification =
    yield* Schema.decodeUnknownEffect(r2QueueMessageSchema)(messageBody);
  if (
    notification.action !== "PutObject" &&
    notification.action !== "DeleteObject"
  )
    return;
  yield* notification.action === "DeleteObject"
    ? processInvoiceDelete(notification)
    : processInvoiceUpload(notification);
});
```

### Queue handler entry point

```ts
async queue(batch, env) {
  const envLayer = makeEnvLayer(env);
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const runtimeLayer = Layer.merge(r2Layer, makeLoggerLayer(env));
  await Effect.runPromise(
    Effect.provide(
      Effect.forEach(batch.messages, (message) =>
        processQueueMessage(message.body).pipe(
          Effect.andThen(() => Effect.sync(() => message.ack())),
          Effect.catchTag("SchemaError", () =>
            Effect.sync(() => message.ack()),
          ),
          Effect.catch(() => Effect.sync(() => message.retry())),
        ),
      ),
      runtimeLayer,
    ),
  );
},
```

## What gets removed

- `makeQueueRunEffect` helper
- `handleInvoiceDelete` function (replaced by `processInvoiceDelete`)
- `handleInvoiceUpload` function (replaced by `processInvoiceUpload`)
- `getOrganizationAgentStub` async function (replaced by Effect.fn version)
- `formatQueueError` helper
- `Exit` / `Cause` inspection in queue handler (moved into Effect pipeline)
