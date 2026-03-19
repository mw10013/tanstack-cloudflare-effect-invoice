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

Following `R2Error` and `GoogleApiError` patterns in codebase:

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

Replace the standalone `decodeGeminiResponse` with an Effect-compatible schema:

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

Used via `HttpClientResponse.schemaBodyJson(GeminiResponseSchema)` — effectful, returns `SchemaError` on failure.

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

### Why `HttpClient.execute` (accessor) vs `client.execute` (instance)?

`google-client.ts` already uses `HttpClient.execute(request)` — the module-level accessor that reads `HttpClient.HttpClient` from context. This is the simpler pattern when you don't need a preconfigured client instance. Consistent with codebase.

Source: `src/lib/google-client.ts:80`

### Why not use the R2 Effect service for `load-file`?

The workflow class only has `this.env.R2` (raw Cloudflare R2 binding), not the Effect `R2` service layer. Wrapping a single `R2.get` call in Effect within a `step.do` adds ceremony without benefit. The `load-file` step stays as-is.

### Why `HttpClientResponse.filterStatusOk` instead of `HttpClient.filterStatusOk`?

Both work. The response-level `filterStatusOk` is used in `google-client.ts:81` (`Effect.flatMap(HttpClientResponse.filterStatusOk)`). Client-level `filterStatusOk` pre-applies to all requests. Since we have a single request, response-level is fine and matches existing codebase pattern.

## Codebase Pattern Alignment

| Pattern | Reference | Applied Here |
|---|---|---|
| `HttpClient.execute` accessor | `src/lib/google-client.ts:80` | ✓ |
| `HttpClientResponse.filterStatusOk` | `src/lib/google-client.ts:81` | ✓ |
| `HttpClientResponse.schemaBodyJson` | `src/lib/google-client.ts:82` | ✓ |
| `Schema.TaggedErrorClass` for errors | `src/lib/R2.ts:46-49` | ✓ |
| `Effect.catchTag` error mapping | `src/lib/google-client.ts:83-86` | ✓ |
| `HttpBody.jsonUnsafe` for body | `src/lib/google-client.ts:137` | ✓ |
| `Encoding.encodeBase64` | `refs/effect4/packages/effect/src/Encoding.ts:70` | ✓ |
| `FetchHttpClient.layer` provision | `docs/effect4-http-client-research.md:360-366` | ✓ |

## Imports

```ts
import { Data, Effect } from "effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"
import { FetchHttpClient } from "effect/unstable/http"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
```

## Open Questions

1. **Retry**: Should we add `retryTransient` for transient AI Gateway failures? The Agents workflow framework already provides retry at the step level (`step.do` is durable). Adding Effect-level retry would handle transient 5xx within a single step attempt.

2. **Logging**: Current code uses `console.log`/`console.error`. Should we use `Effect.logInfo`/`Effect.logError` inside the Effect program? Would need to provide a logger layer (the main app already has one in `worker.ts`).

3. **`load-file` step**: Worth wrapping in Effect too for consistency, or leave as plain async since it's a single R2 call?
