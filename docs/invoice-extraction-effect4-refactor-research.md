# Invoice Extraction Workflow Effect v4 Design Research

## Goal

Refactor `src/invoice-extraction-workflow.ts` so that:

- `run()` constructs the needed layers/services once
- `run()` returns a promise produced by running one top-level Effect
- each `step.do(..., asyncThunk)` still owns the durable promise boundary
- the async thunks run Effects using the same already-constructed services

This is viable in Effect v4.

## Effect v4 Runtime Model

Effect v4 no longer has the old `Runtime<R>` value as the primary app-level dependency carrier.

Docs:

- `"In v4, this type no longer exists and you can use ServiceMap<R> instead"` — `refs/effect4/migration/runtime.md:15-16`
- `"Run functions live directly on Effect"` — `refs/effect4/migration/runtime.md:16`

Relevant primitives:

- `Effect.runPromise(effect)` — run a fully-provided effect at the edge: `refs/effect4/packages/effect/src/Effect.ts:8438`
- `Effect.runPromiseWith(services)(effect)` — run an effect with an explicit `ServiceMap`: `refs/effect4/packages/effect/src/Effect.ts:8471`
- `Effect.runPromiseExitWith(services)(effect)` — same but preserve `Exit`: `refs/effect4/packages/effect/src/Effect.ts:8559`
- `Effect.services()` — get the current `ServiceMap`: `refs/effect4/packages/effect/src/Effect.ts:5524`
- `Effect.servicesWith(...)` — derive work from the current `ServiceMap`: `refs/effect4/packages/effect/src/Effect.ts:5570`
- `Effect.provideServices(effect, services)` — re-provide a captured `ServiceMap`: `refs/effect4/packages/effect/src/Effect.ts:5694`

That means the correct mental model is:

1. build a layer stack
2. provide it to one top-level Effect
3. inside that Effect, capture the current services when needed
4. when crossing back out to promise/callback land, use `runPromiseWith(services)` or `provideServices(..., services)`

## Answer To The Main Question

Yes: `run()` can and should return the promise from one top-level Effect.

The right shape is:

```ts
async run(event, step) {
  const runtimeLayer = ...
  return Effect.runPromise(
    main(event, step).pipe(Effect.provide(runtimeLayer)),
  )
}
```

This matches the repo's boundary pattern in `src/worker.ts:64-66`:

```ts
return <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
) => Effect.runPromise(Effect.provide(effect, runtimeLayer));
```

## The Important Step Boundary Pattern

`step.do()` is different from ordinary code in the Effect body because it requires an async thunk returning a promise.

So the durable boundary should remain:

```ts
step.do("extract-invoice", () => Promise<A>)
```

If the step body is implemented as an Effect, that thunk must bridge the Effect to a promise.

The key question is: how do we make that nested Effect use the same services already constructed for the top-level Effect?

Effect v4 provides the exact mechanism:

- capture current services once with `yield* Effect.services()`
- build `const runPromise = Effect.runPromiseWith(services)`
- inside each `step.do` thunk, call `runPromise(subEffect)`

This is not a hack. It is a first-class v4 pattern.

Grounding from refs:

- `const runFork = Effect.runForkWith(yield* Effect.services<RX>())` — `refs/effect4/packages/effect/src/Channel.ts:1867`
- `const services = yield* Effect.services<R>()` and later `Effect.provideServices(f(exit), services)` — `refs/effect4/packages/effect/src/unstable/workflow/Workflow.ts:694-695`
- `ManagedRuntime` internally uses cached services and then `Effect.runPromiseWith(self.cachedServices)(effect)` — `refs/effect4/packages/effect/src/ManagedRuntime.ts:236-241`

So yes: the correct deep pattern is to snapshot the current `ServiceMap` once inside the running Effect, then reuse it for step thunks.

## Public API vs Low-Level Fiber Access

There is low-level fiber access in v4, but it is not the app-level pattern to use here.

Public API:

- `Effect.services()`
- `Effect.servicesWith(...)`
- `Effect.provideServices(...)`
- `Effect.runPromiseWith(...)`

Low-level/internal-ish style:

- `Effect.withFiber((fiber) => ...)`
- direct `fiber.services`

The public API already expresses exactly what this workflow needs. There is no reason to reach for `withFiber` here.

## Recommended Architecture

### 1. One top-level Effect in `run()`

`run()` should:

- capture `this.env` / `this.agent` into locals before entering generators
- build a runtime layer from existing services
- run one Effect with `Effect.runPromise(...)`

Sketch:

```ts
async run(event, step) {
  const env = this.env;
  const agent = this.agent;

  const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const invoiceExtractionLayer = Layer.provideMerge(
    InvoiceExtraction.layer,
    Layer.merge(envLayer, FetchHttpClient.layer),
  );
  const runtimeLayer = Layer.merge(r2Layer, invoiceExtractionLayer);

  return Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Effect.services<Layer.Success<typeof runtimeLayer>>();
      const runWithServices = Effect.runPromiseWith(services);

      const doEffectStep = <A, E>(
        name: string,
        effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
      ) =>
        Effect.tryPromise({
          try: () => step.do(name, () => runWithServices(effect)),
          catch: (cause) => new InvoiceWorkflowError({
            message: `workflow step failed: ${name}`,
            cause,
          }),
        });

      const fileBytes = yield* doEffectStep(
        "load-file",
        loadFileEffect({ r2ObjectKey: event.payload.r2ObjectKey }),
      );

      const extracted = yield* doEffectStep(
        "extract-invoice",
        Effect.gen(function* () {
          const invoiceExtraction = yield* InvoiceExtraction;
          return yield* invoiceExtraction.extract({
            fileBytes,
            contentType: event.payload.contentType,
          });
        }),
      );

      yield* doEffectStep(
        "save-extracted-json",
        saveExtractedJsonEffect({
          agent,
          invoiceId: event.payload.invoiceId,
          idempotencyKey: event.payload.idempotencyKey,
          extracted,
        }),
      );

      return { invoiceId: event.payload.invoiceId };
    }).pipe(Effect.provide(runtimeLayer)),
  );
}
```

This gives you:

- one top-level Effect boundary in `run()`
- durable `step.do` promises still owning each step
- each step thunk executing an Effect with the exact same service graph

### 2. Use existing services where they actually help

Existing useful services in this repo:

- `CloudflareEnv` — `src/lib/CloudflareEnv.ts:3`
- `R2` — `src/lib/R2.ts:5`

Note: `saveExtractedJson` currently exists on the DO agent object, not as an Effect service, so that last step can reasonably stay a closure-based Effect over `agent` for now.

So `load-file` should prefer the existing `R2` service rather than direct `env.R2.get(...)`.

Sketch:

```ts
const loadFileEffect = ({ r2ObjectKey }: { readonly r2ObjectKey: string }) =>
  Effect.gen(function* () {
    const r2 = yield* R2;
    const object = yield* r2.get(r2ObjectKey);
    if (Option.isNone(object)) {
      return yield* new InvoiceWorkflowError({
        message: `Invoice file not found: ${r2ObjectKey}`,
        cause: new Error(`Invoice file not found: ${r2ObjectKey}`),
      });
    }
    return new Uint8Array(yield* Effect.promise(() => object.value.arrayBuffer()));
  });
```

That keeps the workflow aligned with the service-oriented codebase instead of bypassing it.

### 3. Introduce an `InvoiceExtraction` service

The extraction HTTP/decode logic should be a proper service, not a free function with secret parameters.

Why:

- matches `src/lib/D1.ts:5`, `src/lib/R2.ts:5`, `src/lib/Repository.ts:7`
- pulls secrets from `CloudflareEnv` rather than from call sites
- composes naturally with `FetchHttpClient.layer`
- becomes straightforward to run from `step.do` using captured services

Sketch:

```ts
export class InvoiceExtraction extends ServiceMap.Service<InvoiceExtraction>()(
  "InvoiceExtraction",
  {
    make: Effect.gen(function* () {
      const env = yield* CloudflareEnv;
      const client = yield* HttpClient.HttpClient;

      const extract = Effect.fn("InvoiceExtraction.extract")(function* ({
        fileBytes,
        contentType,
      }: {
        readonly fileBytes: Uint8Array;
        readonly contentType: string;
      }) {
        const response = yield* HttpClientRequest.post(gatewayUrl(env), {
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.GOOGLE_AI_STUDIO_API_KEY,
            "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
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
              responseJsonSchema: invoiceExtractionJsonSchema,
            },
          }),
        }).pipe(client.execute);

        return yield* decodeInvoiceExtractionResponse(response);
      });

      return { extract };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

## Why `runPromiseWith(services)` Is The Right Bridge

The workflow has two different execution domains:

- Effect domain: the main orchestration logic
- promise domain: `step.do(..., asyncThunk)` required by the Agents framework

`runPromiseWith(services)` is the exact bridge between them.

It is better than rebuilding the layer graph inside each step thunk because:

- services are constructed once
- all steps share the same environment view
- any service overrides/local provisions already active in the top-level Effect are preserved
- the step thunk stays thin and only performs the boundary conversion

Equivalent lower-level shape if `runPromiseWith` did not exist:

```ts
const services = yield* Effect.services<R>();
const promise = Effect.runPromise(Effect.provideServices(subEffect, services));
```

But `runPromiseWith(services)(subEffect)` is the built-in shorthand for exactly that style of execution.

## ManagedRuntime: Useful, But Not The Best Primary Pattern Here

`ManagedRuntime` is real and documented:

- `ManagedRuntime.make(layer)` — `refs/effect4/packages/effect/src/ManagedRuntime.ts:160`
- example bridge for external frameworks — `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:67-76`

It can work here:

```ts
const runtime = ManagedRuntime.make(runtimeLayer);
return runtime.runPromise(mainEffect);
```

And then step callbacks could call:

```ts
step.do("extract-invoice", () => runtime.runPromise(effect))
```

But for this specific workflow, it is not the best primary pattern.

Reasons:

- `ManagedRuntime` is most useful when you need a reusable runtime object shared across many non-Effect handlers
- in this workflow, we already have a top-level Effect; we mainly need to cross from that Effect into nested promise callbacks
- `Effect.services()` + `Effect.runPromiseWith(services)` is more direct and keeps the execution model explicit
- if you create a fresh `ManagedRuntime` per workflow run, you also need to think about disposal for scoped resources; the top-level `Effect.provide(runtimeLayer)` path avoids introducing another lifecycle object

So:

- `ManagedRuntime` is valid
- capturing current services and using `runPromiseWith` is the tighter fit

## Response / Decode Design

### Base64

Use `Encoding.encodeBase64(fileBytes)`.

Docs:

- `export const encodeBase64: (input: Uint8Array | string) => string` — `refs/effect4/packages/effect/src/Encoding.ts:70`

### JSON body decode

For success responses, `HttpClientResponse.schemaBodyJson(...)` is the idiomatic path.

Docs example:

- `Effect.flatMap(HttpClientResponse.schemaBodyJson(Todo))` — `refs/effect4/ai-docs/src/50_http-client/10_basics.ts:64`

### Do not throw away non-2xx bodies

Do not blindly call `HttpClientResponse.filterStatusOk` first.

Docs show it fails immediately on non-2xx:

- `filterStatusOk` returns failure for non-2xx — `refs/effect4/packages/effect/src/unstable/http/HttpClientResponse.ts:201-210`

For AI Gateway, the error body is operationally important, so the extraction service should:

1. inspect `response.status`
2. if non-2xx, read `response.text`
3. map to `InvoiceExtractionError` with status + body excerpt
4. only decode success bodies with `schemaBodyJson`

### JSON string payload decode

Gemini returns extracted JSON as text. The correct Effect schema tool is:

```ts
Schema.fromJsonString(InvoiceExtractionSchema)
```

Docs:

- `"Returns a schema that decodes a JSON string and then decodes the parsed value using the given schema"` — `refs/effect4/packages/effect/src/Schema.ts:7072-7079`

## Error Design

Stay aligned with existing repo style:

- `src/lib/D1.ts:57`
- `src/lib/R2.ts:46`
- `src/lib/Stripe.ts:227`

Use tagged errors:

```ts
export class InvoiceExtractionError extends Schema.TaggedErrorClass<InvoiceExtractionError>()(
  "InvoiceExtractionError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class InvoiceWorkflowError extends Schema.TaggedErrorClass<InvoiceWorkflowError>()(
  "InvoiceWorkflowError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}
```

Suggested split:

- `InvoiceExtractionError` for HTTP / Gemini envelope / payload decode failures
- `InvoiceWorkflowError` for step-boundary orchestration failures

## Recommended Concrete Shape

### Runtime layer

Build only what the workflow needs:

- `CloudflareEnv`
- `R2`
- `FetchHttpClient.layer`
- `InvoiceExtraction.layer`
- optionally logger layer later

Sketch:

```ts
const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
const r2Layer = Layer.provideMerge(R2.layer, envLayer);
const extractionLayer = Layer.provideMerge(
  InvoiceExtraction.layer,
  Layer.merge(envLayer, FetchHttpClient.layer),
);
const runtimeLayer = Layer.merge(r2Layer, extractionLayer);
```

### Step runner helper

This is the core reusable construct:

```ts
const services = yield* Effect.services<Layer.Success<typeof runtimeLayer>>();
const runWithServices = Effect.runPromiseWith(services);

const doEffectStep = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
) =>
  Effect.tryPromise({
    try: () => step.do(name, () => runWithServices(effect)),
    catch: (cause) =>
      new InvoiceWorkflowError({
        message: `workflow step failed: ${name}`,
        cause,
      }),
  });
```

That is the main v4 construct this workflow needs.

## What Still Needs To Be Settled Before Implementation

1. Workflow return type
   - current generic in `src/invoice-extraction-workflow.ts:57-60` does not match the actual returned shape in `src/invoice-extraction-workflow.ts:106`

2. Exact service module placement
   - likely `src/lib/InvoiceExtraction.ts`

3. How much of the workflow shell to service-ify
   - `R2` should likely be reused
   - `agent.saveExtractedJson(...)` can stay as a small closure-based Effect unless a dedicated agent service is introduced

4. Retry policy
   - workflow durability retry via `step.do`
   - optional transient HTTP retry inside `InvoiceExtraction`
   - do not retry schema failures / malformed model output

5. Persisted error format
   - `src/organization-agent.ts:201-227` stores workflow error as string
   - decide whether to truncate/sanitize AI Gateway response bodies

6. Tests
   - success response
   - non-2xx gateway body
   - malformed Gemini envelope
   - invalid extracted JSON string
   - empty candidate / no text response

## Final Recommendation

The strongest v4 design here is:

- one top-level Effect in `run()`
- provide the layer graph once at that top level
- inside the running Effect, capture current services with `Effect.services()`
- build `runPromiseWith(services)` once
- make every `step.do` thunk run an Effect through that runner

That gives you exactly what you asked for:

- top-level orchestration remains a single Effect
- step thunks still satisfy the Agents framework promise contract
- nested step Effects reuse the already-constructed service graph instead of rebuilding layers or falling back to raw async code

This is not a shallow compromise. It is the direct Effect v4 pattern supported by the runtime migration docs, `runPromiseWith`, `services()`, and the library's own internal use of captured service maps across callback/finalizer/fork boundaries.
