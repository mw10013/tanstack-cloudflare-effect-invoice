# Effect v4 `use` Pattern Research

Question: how should the earlier Effect v3 `use` pattern research be updated after grounding it in `refs/effect4`, and does `refs/effect4` use the same pattern for OpenAI?

## Short Answer

Yes, Effect v4 still supports a `use` pattern.

But the meaning is a bit different and the docs are more opinionated:

- `use` is now a first-class `ServiceMap.Service` accessor
- v4 docs explicitly say to prefer `yield* Service` over `Service.use(...)` in most cases
- the deeper pattern is still valid: keep foreign libraries at the edge, wrap them in services, normalize failure/cancellation/scoping there, then expose Effect-native APIs

So the v3 workshop pattern still holds conceptually, but in v4 the most idiomatic version is usually:

1. model the integration as `ServiceMap.Service`
2. build layers explicitly with `Layer.effect(...)`
3. wrap foreign boundaries with `Effect.try`, `Effect.tryPromise`, `Stream.fromAsyncIterable`, `Effect.acquireRelease`, etc.
4. access services mostly with `yield*`, using `.use(...)` only when it is the clearest tool

So the simplest accurate takeaway is:

- the Effect v3 `use` pattern is not very relevant in the literal API sense for Effect v4
- it is still relevant in the philosophical / architectural sense

Literal v3 reading: expose a custom public `use` method like `openai.use((client) => ...)`.

Idiomatic v4 reading: wrap foreign libraries in a service and normalize the boundary there, but usually expose focused domain methods and consume services with `yield*`.

So if we are asking "should we port the workshop's public `use` API verbatim into v4?", the answer is usually no.

If we are asking "should we keep the workshop's idea of one integration boundary that centralizes error mapping, cancellation, scoping, and stream translation?", the answer is yes.

## The Main v4 Docs Signal

From `refs/effect4/migration/services.md:81`:

```ts
In v4, accessors are removed. The most direct replacement is `Service.use`,
which receives the service instance and runs a callback:
```

Example from `refs/effect4/migration/services.md:97`:

```ts
class Notifications extends ServiceMap.Service<
  Notifications,
  {
    readonly notify: (message: string) => Effect.Effect<void>;
  }
>()("Notifications") {}

const program = Notifications.use((n) => n.notify("hello"));
```

But the same doc immediately adds, from `refs/effect4/migration/services.md:126`:

```ts
Prefer `yield*` over `use` in most cases.
```

And the recommended explicit shape from `refs/effect4/migration/services.md:135`:

```ts
const program = Effect.gen(function* () {
  const notifications = yield* Notifications;
  yield* notifications.notify("hello");
  yield* notifications.notify("world");
});
```

That is the biggest thing to update from the v3 research.

## What `use` Means In v4

In v3 workshop material, `use` was mostly presented as a method you add to your service to wrap a foreign SDK.

In v4, `use` is also a built-in service accessor.

From `refs/effect4/packages/effect/src/ServiceMap.ts:67`:

```ts
use<A, E, R>(f: (service: Shape) => Effect<A, E, R>): Effect<A, E, R | Identifier>
useSync<A>(f: (service: Shape) => A): Effect<A, never, Identifier>
```

And its implementation from `refs/effect4/packages/effect/src/ServiceMap.ts:216`:

```ts
use<A, E, R>(this: Service<never, any>, f: (service: any) => Effect<A, E, R>): Effect<A, E, R> {
  return withFiber((fiber) => f(get(fiber.services, this)))
}
```

This matters because v4 `Service.use(...)` is not resource management or error handling by itself.

It is just:

- fetch the service from the environment
- run a callback with it

So there are now two related but distinct ideas:

1. `Service.use(...)` as a built-in accessor helper
2. a custom service method named `use` that wraps a foreign client/resource boundary

The v3 workshop was about the second one.

## The v3 Pattern Still Survives In v4

The earlier v3 research still mostly stands.

The core pattern remains good:

- create a service around the raw library
- keep the raw client/resource private
- normalize errors and interruption at the boundary
- derive narrower app-facing methods on top

What changes is the v4 service style.

From `refs/effect4/migration/services.md:173`:

```ts
In v4, `ServiceMap.Service` with `make` stores the constructor effect on the
class but does not auto-generate a layer. Define layers explicitly using
`Layer.effect`.
```

Example from `refs/effect4/migration/services.md:180`:

```ts
class Logger extends ServiceMap.Service<Logger>()("Logger", {
  make: Effect.gen(function* () {
    const config = yield* Config;
    return { log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`) };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Config.layer),
  );
}
```

So the v4 translation of the workshop is:

- same boundary concept
- new service and layer syntax
- more explicit environment access idioms

## Boundary Wrapping Is Even More Explicit In v4

The v4 docs are very direct about how to wrap foreign code.

From `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:32`:

```ts
// `Effect.try` wraps synchronous code that may throw.
```

From `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:45`:

```ts
// `Effect.tryPromise` wraps Promise-based APIs that can reject or throw.
```

And from `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:64`:

```ts
// `Effect.callback` wraps callback-style asynchronous APIs.
```

This reinforces the v3 workshop idea: put all non-Effect boundaries behind the right constructor.

## Resource Scoping Is A First-Class v4 Concern

The best v4 analogue to the sqlite exercise is the SMTP example in `refs/effect4/ai-docs/src/01_effect/04_resources/10_acquire-release.ts`.

Resource acquisition from `refs/effect4/ai-docs/src/01_effect/04_resources/10_acquire-release.ts:34`:

```ts
const transporter =
  yield *
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeMailer.createTransport({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user, pass: Redacted.value(pass) },
      }),
    ),
    (transporter) => Effect.sync(() => transporter.close()),
  );
```

Effectful method from `refs/effect4/ai-docs/src/01_effect/04_resources/10_acquire-release.ts:46`:

```ts
const send = Effect.fn("Smtp.send")((message) =>
  Effect.tryPromise({
    try: () =>
      transporter.sendMail({
        from: "Acme Cloud <cloud@acme.com>",
        to: message.to,
        subject: message.subject,
        text: message.body,
      }),
    catch: (cause) => new SmtpError({ cause }),
  }).pipe(Effect.asVoid),
);
```

This is essentially the workshop's sqlite/OpenAI lesson rewritten in v4 style:

- acquire the foreign resource in a layer or scoped effect
- release it with a finalizer
- expose public methods as `Effect.fn(...)`
- wrap foreign operations exactly once

## Cancellation Is More Clearly Part Of The Pattern In v4

One of the most important details from the v3 workshop was passing `AbortSignal` into OpenAI.

That is not a workshop-specific trick. It is aligned with v4 core style.

From `refs/effect4/packages/platform-node/src/NodeHttpClient.ts:103`:

```ts
Effect.tryPromise({
  try: () =>
    dispatcher.request({
      ...fiber.getRef(UndiciOptions),
      signal,
      method: request.method,
      headers: request.headers,
      origin: url.origin,
      path: url.pathname + url.search + url.hash,
      body,
```

The v4 pattern is clear:

- if the foreign API accepts `AbortSignal`, thread it through
- do not just wrap promises mechanically
- let interruption actually cancel underlying work

That strengthens, not weakens, the v3 workshop takeaway.

## Streams: The Pattern Expands Cleanly In v4

The workshop used `Stream.fromAsyncIterable` and `Stream.unwrap` for OpenAI and sqlite streaming.

That remains idiomatic in v4.

The docs point to `Stream.fromAsyncIterable(...)` in `refs/effect4/ai-docs/src/02_stream/10_creating-streams.ts`, and v4 internals continue to build integrations by translating foreign streams into Effect streams.

The strongest OpenAI example is not a `.use(...)` method, but `OpenAiClient.createResponseStream` in `refs/effect4/packages/ai/openai/src/OpenAiClient.ts:224`:

```ts
const createResponseStream: Service["createResponseStream"] = (payload) =>
  httpClientOk
    .execute(
      HttpClientRequest.post("/responses", {
        body: HttpBody.jsonUnsafe({ ...payload, stream: true }),
      }),
    )
    .pipe(
      Effect.map(buildResponseStream),
      Effect.catchTag("HttpClientError", (error) =>
        Errors.mapHttpClientError(error, "createResponseStream"),
      ),
    );
```

And the stream construction from `refs/effect4/packages/ai/openai/src/OpenAiClient.ts:206`:

```ts
const stream = response.stream.pipe(
  Stream.decodeText(),
  Stream.pipeThroughChannel(
    Sse.decodeDataSchema(Generated.ResponseStreamEvent),
  ),
  Stream.takeUntil(
    (event) =>
      event.data.type === "response.completed" ||
      event.data.type === "response.incomplete",
  ),
  Stream.map((event) => event.data),
  Stream.catchTags({
    Retry: (error) => Stream.die(error),
    HttpClientError: (error) =>
      Stream.fromEffect(
        Errors.mapHttpClientError(error, "createResponseStream"),
      ),
    SchemaError: (error) =>
      Stream.fail(Errors.mapSchemaError(error, "createResponseStream")),
  }),
);
```

Same conceptual move as the workshop:

- foreign streaming protocol in
- Effect `Stream` out
- error translation at the boundary

## Does The OpenAI Code In `refs/effect4` Use The Workshop's `use` Pattern?

Not explicitly.

I did not find a bespoke OpenAI service method named `use` in `refs/effect4/packages/ai/openai/src/`.

Instead, the official v4 OpenAI code takes a more specialized shape:

- `OpenAiClient` is a `ServiceMap.Service`
- `make` builds a configured HTTP/generated client
- the service exposes narrow operations like `createResponse`, `createResponseStream`, and `createEmbedding`
- higher-level services like `OpenAiLanguageModel` build on top of that

From `refs/effect4/packages/ai/openai/src/OpenAiClient.ts:86`:

```ts
export class OpenAiClient extends ServiceMap.Service<OpenAiClient, Service>()(
  "@effect/ai-openai/OpenAiClient",
) {}
```

From `refs/effect4/packages/ai/openai/src/OpenAiClient.ts:144`:

```ts
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient
```

From `refs/effect4/packages/ai/openai/src/OpenAiClient.ts:270`:

```ts
export const layer = (
  options: Options,
): Layer.Layer<OpenAiClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenAiClient, make(options));
```

So the answer is:

- the exact workshop-style `openai.use((client) => ...)` API is not present in the v4 OpenAI package
- the underlying integration philosophy absolutely is present
- v4 library code prefers narrower, already-wrapped Effect-native methods over exposing a generic raw-client callback escape hatch

## What This Means For Our Research

The v3 workshop taught a very useful transitional pattern:

- hide the raw SDK
- expose a generic `use`
- derive helpers from there

The v4 codebase suggests a refinement:

- still hide the raw SDK
- but prefer publishing focused service methods instead of relying on a public generic `use` unless that flexibility is actually needed

So in v4, the strongest pattern is not "every integration should expose `use`".

It is closer to:

1. wrap foreign code in a service
2. centralize `try` / `tryPromise` / stream conversion / cleanup there
3. expose domain methods first
4. optionally keep a private or low-level `use` if it improves local implementation ergonomics

## `ManagedRuntime` Shows Another Kind Of `use`

The v4 integration docs also show `Service.use(...)` at framework boundaries.

From `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:74`:

```ts
const todos = await runtime.runPromise(TodoRepo.use((repo) => repo.getAll));
```

This is real v4 usage of `use`, but it is different from the workshop's foreign-SDK wrapper pattern.

Here, `use` means:

- grab a service from the environment
- call one of its existing Effect methods

That reinforces the main distinction:

- built-in v4 `Service.use(...)` is an accessor convenience
- custom workshop-style `service.use(...)` is an integration boundary helper

They rhyme, but they are not the same abstraction.

## Practical v4 Guidance

Grounded in `refs/effect4`, the best v4 guidance looks like this.

### Good fit for a custom `use` method

Add a custom low-level `use` when:

- the foreign library is large and awkward to wrap method-by-method initially
- you need a boundary for error mapping and `AbortSignal`
- you want a private primitive for building `query`, `stream`, `paginate`, etc.

This is the workshop/OpenAI/sqlite shape.

### Prefer domain methods as the public API

Prefer public methods like:

- `query`
- `stream`
- `send`
- `createResponse`
- `createEmbedding`

This matches the official v4 OpenAI package and SMTP example.

### Prefer `yield* Service` over `Service.use(...)`

For consuming services in our application code, prefer explicit dependencies:

```ts
const program = Effect.gen(function* () {
  const client = yield* MyService;
  return yield* client.doThing();
});
```

Use `Service.use(...)` when it genuinely makes code clearer, especially at framework edges.

## Bottom Line

`refs/effect4` confirms that the v3 `use` research was directionally right, but it sharpens the conclusion.

The stable v4 pattern is not "use `use` everywhere".

The stable v4 pattern is:

- services via `ServiceMap.Service`
- explicit layers via `Layer.effect`
- explicit boundary wrappers via `Effect.try`, `Effect.tryPromise`, stream adapters, and scoped resource management
- explicit service access with `yield*` by default
- narrow domain methods as the preferred public surface

And for OpenAI specifically: the official v4 code does not expose the workshop's generic `use` method, but it absolutely follows the same deeper principle of keeping foreign integration concerns centralized inside an Effect-native service.
