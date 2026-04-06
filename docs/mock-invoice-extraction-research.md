# Mocking InvoiceExtraction in Integration Tests

## Problem

`InvoiceExtractionWorkflow.run()` (src/invoice-extraction-workflow.ts:39-169) constructs its own Effect layers internally:

```ts
const invoiceExtractionLayer = Layer.provideMerge(
  InvoiceExtraction.layer,                      // hard-coded
  Layer.merge(envLayer, FetchHttpClient.layer),  // hard-coded
);
```

The workflow builds `InvoiceExtraction.layer` from scratch inside `run()`, which internally creates an `HttpClient` via `FetchHttpClient.layer` and uses it to call the Gemini API. There is **no dependency injection seam** at the workflow level — we cannot pass a test layer into the workflow class.

The upload test (`test/integration/upload-invoice.test.ts:32-56`) triggers the full flow: upload → queue → workflow → extraction → save. The `pollInvoiceStatus` call waits for the invoice to reach `ready` status, which requires the extraction workflow to complete successfully, which requires a real LLM response.

## Approaches Analyzed

### Approach 1: Effect Layer — Mock `InvoiceExtraction` Service Directly

**How it works in Effect v4:** Effect v4 has a dedicated `Layer.mock()` API (refs/effect4/packages/effect/src/Layer.ts:1846-1894) for testing `ServiceMap.Service` classes. It accepts a partial implementation — only Effect-returning methods you provide are used; unimplemented ones throw `UnimplementedError` via Proxy:

```ts
// Layer.mock() — partial impl, unimplemented methods throw
const InvoiceExtractionTest = Layer.mock(InvoiceExtraction, {
  extract: ({ fileBytes, contentType }) =>
    Effect.succeed({
      invoiceConfidence: 0.95,
      invoiceNumber: "TEST-001",
      // ... all InvoiceExtractionSchema fields
      invoiceItems: [{ description: "Test", quantity: "1", unitPrice: "$100", amount: "$100", period: "" }],
    }),
})
```

Alternatively, `ServiceMap.Service` classes get an auto-generated `.of()` method:

```ts
// From refs/effect4/ai-docs/src/09_testing/20_layer-tests.ts
const InvoiceExtractionTest = Layer.succeed(InvoiceExtraction)(
  InvoiceExtraction.of({
    extract: Effect.fn("test")(function*() {
      return { invoiceConfidence: 0.95, /* ... */ }
    })
  })
)
```

Both can be used with `@effect/vitest`'s `layer()` or inline `Effect.provide()`:

```ts
// Shared layer for a describe block
layer(InvoiceExtractionTest)("extraction tests", (it) => {
  it.effect("extracts invoice", () => Effect.gen(function*() {
    const svc = yield* InvoiceExtraction
    const result = yield* svc.extract({ fileBytes: new Uint8Array(), contentType: "image/png" })
    assert.strictEqual(result.invoiceNumber, "TEST-001")
  }))
})

// Or inline per-test
it.effect("extracts invoice", () =>
  Effect.gen(function*() { /* ... */ }).pipe(Effect.provide(InvoiceExtractionTest))
)
```

**Blocker:** The workflow hard-codes `InvoiceExtraction.layer` in its `run()` method (line 57). There's no way to inject a test layer from outside. The `InvoiceExtractionWorkflow` class extends `AgentWorkflow` and is instantiated by the Cloudflare runtime, not by our code.

**Verdict:** ❌ Not viable without refactoring the workflow to accept layers externally.

### Approach 2: Mock `HttpClient` at the Effect Layer

**How it works:** Effect v4's `HttpClient.makeWith` can create a mock HTTP client:

```ts
// From refs/effect4/packages/ai/openai/test/OpenAiClient.test.ts:48-61
const makeMockHttpClient = (handler) =>
  HttpClient.makeWith(
    (effect) => Effect.flatMap(effect, handler),
    Effect.succeed
  )
```

Then provide it via `Layer.succeed(HttpClient.HttpClient, mockClient)`.

**Blocker:** Same as Approach 1 — the workflow constructs `FetchHttpClient.layer` internally (line 58). We cannot swap the HTTP client.

**Verdict:** ❌ Same injection problem.

### Approach 3: `outboundService` in Miniflare Config (Intercept All Outbound Fetch)

**How it works:** Miniflare supports an `outboundService` option that intercepts **all** outbound `fetch()` calls from the worker:

```ts
// From refs/workers-sdk/fixtures/vitest-pool-workers-examples/misc/vitest.config.ts
cloudflareTest({
  miniflare: {
    outboundService(request) {
      return new Response(`fallthrough:${request.method} ${request.url}`);
    },
  },
})
```

This operates at the workerd runtime level — every `fetch()` call from the worker (including from Durable Objects and Workflows) passes through this handler. You can pattern-match on the URL to return mock responses for the AI Gateway endpoint while passing other requests through.

For our case, the mock would need to:
1. Match requests to `https://gateway.ai.cloudflare.com/v1/.../google-ai-studio/...`
2. Return a valid Gemini API response shape matching `GeminiResponseSchema`

```ts
// vitest.config.ts
cloudflareTest({
  miniflare: {
    outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "gateway.ai.cloudflare.com") {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  invoiceConfidence: 0.95,
                  invoiceNumber: "INV-001",
                  invoiceDate: "2024-01-01",
                  // ... all InvoiceExtractionSchema fields
                })
              }]
            }
          }]
        }), { headers: { "content-type": "application/json" } });
      }
      // fallthrough for other requests
      return fetch(request);
    },
  },
})
```

**Pros:**
- No code changes needed — works at the runtime level
- Intercepts fetch from Workflows, DOs, everything
- Already used in workers-sdk test fixtures

**Cons:**
- Config-level, not per-test — same mock response for all tests
- Requires knowing the exact response shape (Gemini API format wrapping our schema)
- Cannot assert on what was sent (no request capture)
- `outboundService` is in the vitest config, not in test code — harder to vary per test
- May interfere with other outbound calls (e.g., to better-auth, Cloudflare APIs)

**Verdict:** ✅ Viable. Most practical approach without code changes.

### Approach 4: MSW (Mock Service Worker) in Test Setup

**How it works:** The request-mocking fixture (`refs/workers-sdk/fixtures/vitest-pool-workers-examples/request-mocking/`) shows MSW used with `@cloudflare/vitest-pool-workers`:

```ts
// test/server.ts
import { setupServer } from "msw/node";
export const server = setupServer();

// test/setup.ts
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// test/declarative.test.ts
server.use(
  http.post("https://gateway.ai.cloudflare.com/*", async ({ request }) => {
    return HttpResponse.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(mockExtraction) }] } }]
    });
  })
);
```

**Important caveat from the README:**
> Tests demonstrate declarative mocking with `fetchMock` from the `cloudflare:test` module, and imperative mocks of `globalThis.fetch()`

MSW runs in the Node.js test process. The worker code runs in workerd. MSW intercepts requests that go through Node's `fetch` — but workerd has its own `fetch` implementation. MSW might not intercept fetch calls made from within the workerd runtime (DOs, Workflows).

**Verdict:** ⚠️ Uncertain. MSW may only intercept Node-side fetches, not workerd-side. Need to test.

### Approach 5: `vi.spyOn(globalThis, "fetch")` (Imperative Mock)

**How it works:**

```ts
// From refs/workers-sdk/fixtures/vitest-pool-workers-examples/request-mocking/test/imperative.test.ts
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "gateway.ai.cloudflare.com") {
    return new Response(JSON.stringify(mockGeminiResponse));
  }
  throw new Error("No mock found");
});
```

**Important:** In the vitest-pool-workers context, test code runs inside workerd. `globalThis.fetch` inside the test IS the same `fetch` that the worker code uses (they share the same isolate for unit-style tests). But for integration tests where DOs/Workflows run in separate isolates, `globalThis.fetch` mocking in the test isolate won't affect other isolates.

**Verdict:** ❌ Won't work for our case — the workflow runs in a separate context (Workflow runtime), not the test isolate.

### Approach 6: Refactor Workflow to Accept Layers (Recommended Long-term)

**How it works:** Modify `InvoiceExtractionWorkflow` to allow layer injection:

```ts
// Option A: Static layer override
export class InvoiceExtractionWorkflow extends AgentWorkflow<...> {
  static invoiceExtractionLayerFactory = (envLayer: Layer.Layer<...>) =>
    Layer.provideMerge(
      InvoiceExtraction.layer,
      Layer.merge(envLayer, FetchHttpClient.layer),
    );

  async run(event, step) {
    // ...
    const invoiceExtractionLayer = InvoiceExtractionWorkflow
      .invoiceExtractionLayerFactory(envLayer);
    // ...
  }
}

// In test setup:
InvoiceExtractionWorkflow.invoiceExtractionLayerFactory = (envLayer) =>
  Layer.provideMerge(
    Layer.succeed(InvoiceExtraction, InvoiceExtraction.of({
      extract: Effect.fn("test")(function*() {
        return mockExtractionResult;
      })
    })),
    envLayer,
  );
```

**Pros:**
- Clean Effect-idiomatic pattern
- Per-test customizable
- Testable at the service boundary

**Cons:**
- Requires production code change
- Static mutable state (class-level override) is impure
- AgentWorkflow lifecycle is managed by Cloudflare runtime — unclear if static overrides persist across isolate boundaries

**Verdict:** ⚠️ Viable but uncertain whether static overrides survive across workerd isolate boundaries.

## Architecture Constraint Summary

The core challenge is the **runtime boundary**: integration tests in `@cloudflare/vitest-pool-workers` run test code inside workerd, but Workflows and Durable Objects may run in separate isolates. This means:

| Mechanism | Same isolate as test? | Works for Workflows? |
|-----------|----------------------|---------------------|
| `vi.spyOn(globalThis, "fetch")` | ✅ | ❌ |
| MSW (`setupServer`) | Node-side only | ❌ |
| `Layer.succeed(InvoiceExtraction, ...)` | ✅ for direct effects | ❌ for Workflows |
| `outboundService` (miniflare config) | N/A (runtime-level) | ✅ |
| Static class property override | ✅ | ❓ (isolate-dependent) |

## Recommendation

### Short-term: `outboundService` (Approach 3)

Use miniflare's `outboundService` in `test/integration/vitest.config.ts` to intercept the AI Gateway call. This requires:

1. Adding `outboundService` to the miniflare config that pattern-matches on `gateway.ai.cloudflare.com`
2. Returning a well-formed Gemini response containing valid `InvoiceExtractionSchema` JSON
3. Passing through all other requests (better-auth, D1, R2, etc.)

Note: `outboundService` and `fetchMock` are **mutually exclusive** per miniflare's validation (refs/workers-sdk/packages/miniflare/src/shared/error.ts — `ERR_MULTIPLE_OUTBOUNDS`).

Key concern: `outboundService` catches *all* outbound fetch. Any test that relies on real external HTTP (unlikely in integration tests, but worth noting) would be affected. Other Cloudflare bindings (D1, R2, KV, Queues) use internal RPC, not fetch, so they're unaffected.

### Long-term: Refactor for Layer Injection (Approach 6)

Make the workflow's layer construction injectable so Effect-level mocking works. This is cleaner but requires understanding how the Cloudflare Workflow runtime manages class instances across isolate boundaries.

## Mock Response Shape

For `outboundService`, the mock must match `GeminiResponseSchema` → `InvoiceExtractionSchema`:

```ts
const mockGeminiResponse = {
  candidates: [{
    content: {
      parts: [{
        text: JSON.stringify({
          invoiceConfidence: 0.95,
          invoiceNumber: "TEST-001",
          invoiceDate: "2024-01-15",
          dueDate: "2024-02-15",
          currency: "USD",
          vendorName: "Test Vendor",
          vendorEmail: "vendor@test.com",
          vendorAddress: "123 Test St",
          billToName: "Test Customer",
          billToEmail: "customer@test.com",
          billToAddress: "456 Test Ave",
          subtotal: "$100.00",
          tax: "$10.00",
          total: "$110.00",
          amountDue: "$110.00",
          invoiceItems: [{
            description: "Test Service",
            quantity: "1",
            unitPrice: "$100.00",
            amount: "$100.00",
            period: "",
          }],
        })
      }]
    }
  }]
};
```

## Config Keys Required by InvoiceExtraction.layer

Even with outbound fetch mocked, `InvoiceExtraction.make` reads these configs (src/lib/InvoiceExtraction.ts:97-101):
- `CF_ACCOUNT_ID` — already in wrangler.jsonc vars
- `AI_GATEWAY_ID` — already in wrangler.jsonc vars
- `GOOGLE_AI_STUDIO_API_KEY` — **not in wrangler.jsonc**, needs to be added (can be dummy value)
- `AI_GATEWAY_TOKEN` — **not in wrangler.jsonc**, needs to be added (can be dummy value)

These must be present as env vars/bindings for `Config.redacted` to succeed, even though the actual HTTP call is mocked.

## References

- Effect v4 testing with layers: `refs/effect4/ai-docs/src/09_testing/20_layer-tests.ts`
- Effect v4 mock HttpClient pattern: `refs/effect4/packages/ai/openai/test/OpenAiClient.test.ts:48-61`
- `ServiceMap.Service` definition: `refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts`
- Miniflare `outboundService`: `refs/workers-sdk/fixtures/vitest-pool-workers-examples/misc/vitest.config.ts:10-12`
- MSW + vitest-pool-workers: `refs/workers-sdk/fixtures/vitest-pool-workers-examples/request-mocking/`
- Imperative fetch mock: `refs/workers-sdk/fixtures/vitest-pool-workers-examples/request-mocking/test/imperative.test.ts`
- `@effect/vitest` layer: `refs/effect4/packages/vitest/src/index.ts:150` (options), `refs/effect4/packages/vitest/src/internal/internal.ts:180-227` (implementation)
