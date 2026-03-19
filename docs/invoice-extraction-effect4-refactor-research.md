# Invoice Extraction Workflow → Effect v4 Refactor Research

## Current State

`src/invoice-extraction-workflow.ts` is plain async/await inside an `AgentWorkflow.run()` method. Key issues:

- Raw `fetch` to Gemini via AI Gateway
- Manual `Buffer.from(fileBytes).toString("base64")` encoding
- `Schema.decodeUnknownSync` for both Gemini envelope and extracted JSON
- No typed errors — bare `throw new Error(...)`
- Direct `this.env.*` access for secrets instead of Effect services

## Constraint: AgentWorkflow

`AgentWorkflow.run()` is an async method called by the Cloudflare Agents framework. Effect must be **run to a promise** at the boundary — we can't change the class shape. The `run()` method has access to `this.env` (Cloudflare `Env`) and `this.agent` (the `OrganizationAgent` DO instance).

```ts
// boundary: run() must return a Promise
async run(event, step) {
  // Effect programs run here via Effect.runPromise
}
```

## Proposed Architecture

### 1. Extract `runInvoiceExtraction` → Effect program

Current:
```ts
const runInvoiceExtraction = async ({ accountId, ... }) => {
  const response = await fetch(url, { ... })
  // manual error check, manual decode
}
```

Proposed: an Effect that requires `HttpClient.HttpClient` in context.

```ts
const runInvoiceExtraction = ({
  accountId,
  gatewayId,
  googleAiStudioApiKey,
  aiGatewayToken,
  fileBytes,
  contentType,
}: InvoiceExtractionParams) =>
  HttpClientRequest.post(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": googleAiStudioApiKey,
        "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
      },
      body: HttpBody.jsonUnsafe({
        contents: [
          {
            parts: [
              { text: invoiceExtractionPrompt },
              {
                inlineData: {
                  mimeType: contentType,
                  data: Encoding.encodeBase64(fileBytes),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema:
            Schema.toJsonSchemaDocument(InvoiceExtractionSchema).schema,
        },
      }),
    },
  ).pipe(
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(GeminiResponseSchema)),
    Effect.flatMap(({ candidates }) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(InvoiceExtractionSchema))(
        candidates[0].content.parts[0].text,
      ),
    ),
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(new InvoiceExtractionError({
        message: `AI Gateway ${error.response?.status ?? "transport"}: ${error.message}`,
        cause: error,
      })),
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new InvoiceExtractionError({
        message: `Decode: ${error.message}`,
        cause: error,
      })),
    ),
  )
```

### 2. Typed error

Following `D1Error`, `R2Error`, `StripeError` patterns in codebase:

```ts
// src/lib/D1.ts:57-60
export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

// src/lib/R2.ts:46-49
export class R2Error extends Schema.TaggedErrorClass<R2Error>()("R2Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

Same pattern:

```ts
class InvoiceExtractionError extends Schema.TaggedErrorClass<InvoiceExtractionError>()(
  "InvoiceExtractionError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}
```

### 3. Base64 encoding

Replace `Buffer.from(fileBytes).toString("base64")` with `Encoding.encodeBase64` from `effect/Encoding`:

```ts
import * as Encoding from "effect/Encoding"
Encoding.encodeBase64(fileBytes) // Uint8Array → string
```

Source: `refs/effect4/packages/effect/src/Encoding.ts:70-71`

### 4. HttpClient provision

The workflow runs inside a Cloudflare Worker — `globalThis.fetch` is available. Use `FetchHttpClient.layer`:

```ts
import { FetchHttpClient } from "effect/unstable/http"

// In run(), provide HttpClient to the effect:
const result = await Effect.runPromise(
  runInvoiceExtraction(params).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
)
```

### 5. Gemini response schema

Replace the standalone `decodeGeminiResponse` with schema used via `HttpClientResponse.schemaBodyJson`:

```ts
const GeminiResponseSchema = Schema.Struct({
  candidates: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
})
```

### 6. `run()` integration

The `step.do` callbacks remain async (Agents framework requirement). The Effect program runs inside the `"extract-invoice"` step:

```ts
async run(event, step) {
  const fileBytes = await step.do("load-file", async () => {
    const object = await this.env.R2.get(event.payload.r2ObjectKey)
    if (!object) throw new Error(`Invoice file not found: ${event.payload.r2ObjectKey}`)
    return new Uint8Array(await object.arrayBuffer())
  })

  const extractedJson = await step.do("extract-invoice", async () =>
    Effect.runPromise(
      runInvoiceExtraction({
        accountId: this.env.CF_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY,
        aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
        fileBytes,
        contentType: event.payload.contentType,
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  )

  await step.do("save-extracted-json", async () => {
    await this.agent.saveExtractedJson({
      invoiceId: event.payload.invoiceId,
      idempotencyKey: event.payload.idempotencyKey,
      extractedJson: JSON.stringify(extractedJson),
    })
  })

  return { invoiceId: event.payload.invoiceId }
}
```

## Design Decisions

### Why not wrap the entire `run()` in Effect.gen?

The `step.do` calls are Agents framework primitives that provide durable execution (idempotency, replay). They must remain as-is. Effect wraps the **computation inside** each step, not the step orchestration itself.

### Why `HttpClient.execute` (module accessor) vs `client.execute` (instance)?

`HttpClient.execute(request)` is the module-level accessor that reads `HttpClient.HttpClient` from context. This is the simpler pattern when you don't need a preconfigured client instance — single request, no shared middleware.

Source: `refs/effect4/packages/effect/src/unstable/http/HttpClient.ts:130-132`

### Why not use the R2 Effect service for `load-file`?

The workflow class only has `this.env.R2` (raw Cloudflare R2 binding), not the Effect `R2` service layer. The Effect services (`R2`, `D1`, `KV`) are composed in `worker.ts` layers for the HTTP request path. The AgentWorkflow runs in a different context (Durable Object). Wrapping a single `R2.get` call in Effect within a `step.do` adds ceremony without benefit.

### Error handling pattern: `tryStripe`/`tryD1`/`tryR2` → `catchTag`

The codebase services use a `try*` helper to wrap promises in Effect with typed errors:

```ts
// src/lib/D1.ts:71-79
const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new D1Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

For the extraction workflow, the HttpClient pipeline already produces typed errors (`HttpClientError`, `SchemaError`). We map them to `InvoiceExtractionError` via `Effect.catchTag` — same error-mapping pattern, different source.

## Codebase Effect Patterns

### worker.ts fetch handler — layer composition + `runPromiseExit`

The HTTP path builds a full layer stack per-request, then exposes `runEffect` as a typed runner:

```ts
// worker.ts:99-134
const makeHttpRunEffect = (env: Env, request: Request) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  // ... compose layers ...
  const runtimeLayer = Layer.merge(authRequestR2Layer, makeLoggerLayer(env));
  return async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, runtimeLayer));
    // ... exit handling with redirect/notFound detection ...
  };
};
```

Key patterns:
- `Layer.succeedServices` + `ServiceMap.make` to inject raw env values (`worker.ts:31-39`)
- `Layer.provideMerge` to chain dependent layers (`worker.ts:61-62, 101-110`)
- `Layer.merge` to combine independent layers (`worker.ts:104, 114-116`)
- `ConfigProvider.fromUnknown(env)` to expose env vars as `Config` values (`worker.ts:34-36`)
- `Effect.runPromiseExit` + `Cause.squash` for structured error handling at the boundary (`worker.ts:120-133`)

### worker.ts scheduled handler — simpler layer, `runPromise`

```ts
// worker.ts:59-67
const makeScheduledRunEffect = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const runtimeLayer = Layer.merge(repositoryLayer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
  ) => Effect.runPromise(Effect.provide(effect, runtimeLayer));
};
```

Simpler than HTTP: no request layer, no exit inspection, just `Effect.runPromise`. Uses `Effect.logInfo`/`Effect.logWarning` for structured logging (`worker.ts:368, 375`).

### worker.ts queue handler — plain async, no Effect (future refactor)

The queue handler (`worker.ts:384-410`) uses `Schema.decodeUnknownExit` for validation but otherwise is plain async/await with try/catch. Not yet Effect-ified.

### Service pattern — `ServiceMap.Service` + `Effect.fn` + `try*` helper

All services follow the same shape:

```ts
// D1, R2, KV, Stripe all use this pattern:
class MyService extends ServiceMap.Service<MyService>()("MyService", {
  make: Effect.gen(function* () {
    const env = yield* CloudflareEnv;
    const operation = Effect.fn("MyService.operation")(function* (...args) {
      return yield* tryMyService(() => rawApiCall(...args));
    });
    return { operation };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

class MyServiceError extends Schema.TaggedErrorClass<MyServiceError>()(
  "MyServiceError",
  { message: Schema.String, cause: Schema.Defect },
) {}

const tryMyService = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MyServiceError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    // optional: Effect.retry(...)
  );
```

Instances: `D1.ts`, `R2.ts`, `KV.ts`, `Stripe.ts`.

### Relevance to invoice extraction

The workflow runs in a **Durable Object** context (AgentWorkflow), not the main worker request path. It doesn't have access to the composed layer stack from `worker.ts`. But the same patterns apply:

- `FetchHttpClient.layer` is the minimal layer needed (provides `HttpClient.HttpClient`)
- `Effect.runPromise` at the boundary (like `makeScheduledRunEffect` — no exit inspection needed since workflow errors are handled by the Agents framework via `onWorkflowError`)
- `Schema.TaggedErrorClass` for typed errors (same as `D1Error`, `R2Error`, etc.)
- `Effect.tapError(Effect.logError)` for error logging before propagation

## Pattern Alignment Table

| Pattern | Codebase Reference | Applied Here |
|---|---|---|
| `Schema.TaggedErrorClass` for errors | `D1Error` (`D1.ts:57`), `R2Error` (`R2.ts:46`), `StripeError` (`Stripe.ts:227`) | `InvoiceExtractionError` |
| `Effect.tapError` + `Effect.logError` | `tryD1` (`D1.ts:79`), `tryR2` (`R2.ts:66`), `tryStripe` (`Stripe.ts:243`), `tryKV` (`KV.ts:91`) | ✓ |
| `Effect.retry` with schedule | `tryR2` (`R2.ts:67-71`), `tryKV` (`KV.ts:92-99`), `retryIfIdempotentWrite` (`D1.ts:81-96`) | Optional — step-level retry may suffice |
| `Effect.fn` for named spans | `D1.batch` (`D1.ts:9`), `R2.head` (`R2.ts:8`), `KV.get` (`KV.ts:21`), `Stripe.getPrices` (`Stripe.ts:32`) | Could wrap `runInvoiceExtraction` |
| `Effect.runPromise` at boundary | `makeScheduledRunEffect` (`worker.ts:66`) | ✓ — inside `step.do` |
| `Layer.provideMerge` / `Layer.merge` | `worker.ts:61-62, 101-116` | `FetchHttpClient.layer` via `Effect.provide` |
| `Schema.decodeUnknownEffect` | `Repository.ts` | Gemini text → `InvoiceExtractionSchema` |
| `HttpBody.jsonUnsafe` for body | `refs/effect4/ai-docs/src/50_http-client/10_basics.ts:79` | ✓ |
| `FetchHttpClient.layer` provision | `refs/effect4/packages/effect/src/unstable/http/FetchHttpClient.ts:71` | ✓ |
| `Encoding.encodeBase64` | `refs/effect4/packages/effect/src/Encoding.ts:70` | Replaces `Buffer.from().toString("base64")` |

## Imports

```ts
import { Effect } from "effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"
import { FetchHttpClient } from "effect/unstable/http"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
```

## Open Questions

1. **Retry**: Should we add `retryTransient` for transient AI Gateway failures? The Agents workflow framework already provides retry at the step level (`step.do` is durable). Adding Effect-level retry would handle transient 5xx within a single step attempt. The codebase `R2` and `D1` services both do retry at the Effect level (`R2.ts:67-71`, `D1.ts:81-96`).

2. **Logging**: Current code uses `console.log`/`console.error`. Should we use `Effect.logInfo`/`Effect.logError` inside the Effect program? The codebase services consistently use `Effect.tapError(Effect.logError)` (`D1.ts:79`, `R2.ts:66`, `Stripe.ts:243`). Would need to provide a logger layer or rely on default console logger.

3. **`load-file` step**: Worth wrapping in Effect too for consistency, or leave as plain async since it's a single R2 call?
