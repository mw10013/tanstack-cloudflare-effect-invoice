# Queue Handler → Effect v4 Migration Research

## Current State

`worker.ts` queue handler (lines 384–410) is raw async/await with manual `Schema.decodeUnknownExit`, `console.error`/`console.warn`, and direct `env.R2.head()` calls. The `fetch` and `scheduled` handlers already use Effect v4 via `makeHttpRunEffect` / `makeScheduledRunEffect`.

## Key Decisions

### 1. Should we create a Queue Effect v4 service?

**No.** The queue handler is a top-level entry point (like `fetch`/`scheduled`), not a reusable service dependency. The existing pattern is:

- `makeHttpRunEffect(env, request)` → builds layers, returns `runEffect` helper
- `makeScheduledRunEffect(env)` → same pattern, fewer layers

We should follow the same approach: **`makeQueueRunEffect(env)`** that builds the minimal layer stack needed by queue processing and returns a `runEffect` helper.

A `Queue` service would wrap `MessageBatch`/`Message` types, but those are per-invocation values (like `Request` for fetch), not bindings. The `.ack()` / `.retry()` calls are control flow decisions that belong in the handler logic, not behind a service abstraction.

### 2. What services does the queue handler need?

Current queue handler accesses:
- `env.R2.head()` → should use **R2 service** (already exists)
- `env.ORGANIZATION_AGENT` (DO namespace) → binding, stays via **CloudflareEnv**
- `Schema.decodeUnknownExit` → pure, no service needed
- `console.error/warn` → should become **Effect.logError / Effect.logWarning**

Minimal layer stack:
```
CloudflareEnv (env)
├── R2 (for head() call in handleInvoiceUpload)
└── Logger (env-aware pretty/json)
```

No D1, KV, Auth, Stripe, Repository, or Request needed.

### 3. How to handle `message.ack()` / `message.retry()`?

These are imperative side-effects on the CF `Message` object. Two options:

**Option A: Keep ack/retry outside Effect, call after `runPromiseExit`**
```ts
const exit = await runEffect(processMessage(message.body));
if (Exit.isSuccess(exit)) message.ack();
else message.retry();
```

**Option B: Wrap ack/retry as Effects inside the pipeline**
```ts
yield* Effect.sync(() => message.ack());
// or
yield* Effect.sync(() => message.retry());
```

**Recommendation: Option B** — keeps the entire message processing pipeline in Effect, including control flow. Logging, R2 calls, and ack/retry all compose naturally. Errors that escape the pipeline cause automatic retry (CF queue behavior).

Yes, we go with this option.

### 4. How to handle `getOrganizationAgentStub`?

Currently calls `env.ORGANIZATION_AGENT.idFromName()`, `.get()`, and `await stub.setName()`. This uses the `ORGANIZATION_AGENT` binding from `env`.

**Approach:** Access via `CloudflareEnv` service and wrap in `Effect.tryPromise`:
```ts
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

### 5. String env vars → Config?

The queue handler doesn't currently read any string env vars. The only env usage is for bindings (`R2`, `ORGANIZATION_AGENT`). The `makeLoggerLayer` does read `env.ENVIRONMENT` — but that already goes through `Schema.decodeUnknownSync` on the raw env, and the `ConfigProvider` is wired into the env layer via `ConfigProvider.fromUnknown(env)` so `Config.nonEmptyString("ENVIRONMENT")` would work.

No changes needed for string env vars in the queue handler specifically.

## Proposed Implementation

### `makeQueueRunEffect`

```ts
const makeQueueRunEffect = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const runtimeLayer = Layer.merge(r2Layer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ) => Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
};
```

### Effectified queue handler

```ts
const processQueueMessage = Effect.fn("processQueueMessage")(
  function* (messageBody: unknown) {
    const notification = yield* Schema.decodeUnknownEffect(r2QueueMessageSchema)(messageBody);
    if (notification.action !== "PutObject" && notification.action !== "DeleteObject") return;
    if (notification.action === "DeleteObject") {
      yield* processInvoiceDelete(notification);
    } else {
      yield* processInvoiceUpload(notification);
    }
  },
);

const processInvoiceDelete = Effect.fn("processInvoiceDelete")(
  function* (notification: typeof r2QueueMessageSchema.Type) {
    const parsed = parseInvoiceObjectKey(notification.object.key);
    if (!parsed) {
      yield* Effect.logError("Invalid invoice delete object key", { key: notification.object.key });
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
  },
);

const processInvoiceUpload = Effect.fn("processInvoiceUpload")(
  function* (notification: typeof r2QueueMessageSchema.Type) {
    const r2 = yield* R2;
    const head = yield* r2.head(notification.object.key);
    if (Option.isNone(head)) {
      yield* Effect.logWarning("R2 object deleted before notification processed", {
        key: notification.object.key,
      });
      return;
    }
    const metadata = yield* Schema.decodeUnknownEffect(r2ObjectCustomMetadataSchema)(
      head.value.customMetadata ?? {},
    );
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
  },
);
```

### Queue handler entry point

```ts
async queue(batch, env) {
  const runEffect = makeQueueRunEffect(env);
  for (const message of batch.messages) {
    const exit = await runEffect(processQueueMessage(message.body));
    if (Exit.isSuccess(exit)) {
      message.ack();
    } else {
      const cause = Cause.squash(exit.cause);
      if (cause instanceof ParseError) {
        // Invalid message body → ack to avoid infinite retry
        message.ack();
      } else {
        message.retry();
      }
    }
  }
},
```

## Open Questions

1. **`ParseError` from `Schema.decodeUnknownEffect`**: The current code acks invalid messages (both bad queue bodies and bad R2 metadata). With Effect, `Schema.decodeUnknownEffect` fails with `ParseError`. Should we distinguish bad-queue-body (ack, never retryable) from bad-R2-metadata (also ack currently, but could be a race — maybe retry once?)?

No

2. **Ack/retry inside vs outside Effect**: The proposed approach keeps ack/retry _outside_ Effect (in the `queue` handler after inspecting `Exit`). This is simpler but means the logging for ack/retry decisions happens partly outside Effect's structured logging. Alternative: pass `message` into the Effect pipeline and call `ack`/`retry` inside. Tradeoff: less pure but unified logging.

Let's start with outside for now.

3. **`formatQueueError` removal**: The current `formatQueueError` helper becomes unnecessary — `Cause.pretty` provides richer error formatting via Effect's structured logging.

Ok.

4. **Should `getOrganizationAgentStub` error be typed?**: Could wrap in a `QueueError` tagged error, or let it fail as a defect. Current code uses try/catch → `message.retry()`, so a typed error that maps to retry seems appropriate.

let's not have typed error for now. too granular. it should just fail and the machinery that retries queue messages handles, right?
