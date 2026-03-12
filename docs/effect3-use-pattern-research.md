# Effect v3 `use` Pattern Research

Question: what is the `use` pattern in `refs/effect3-workshop`, and why does it help integrate Effect with non-Effect libraries?

## Short Answer

The workshop's pattern is: build an `Effect.Service` around a raw client/resource, then expose a single low-level `use` method that turns "run this callback against the raw library" into an `Effect`.

Workshop definition from `refs/effect3-workshop/slides.md:1537`:

```ts
A common approach to wrapping Promise-based libraries with Effect is to create
an Effect.Service that exposes an `use` method.

interface SomeApi {}

declare const use: <A>(f: (api: SomeApi) => Promise<A>) => Effect<A>
```

That `use` boundary becomes the one place where the integration handles:

- error translation
- interruption / cancellation
- tracing
- resource lifetime
- conversion into `Stream` when the foreign API is paginated or streaming

## Where The Workshop Uses It

Primary references:

- `refs/effect3-workshop/slides.md:1533`
- `refs/effect3-workshop/src/demos/section-2/openai-01.ts`
- `refs/effect3-workshop/src/demos/section-2/openai-02.ts`
- `refs/effect3-workshop/src/demos/section-2/openai-paginate-01.ts`
- `refs/effect3-workshop/src/demos/section-2/openai-completions-01.ts`
- `refs/effect3-workshop/src/demos/section-2/openai-completions-02.ts`
- `refs/effect3-workshop/src/demos/shared/OpenAi.ts`
- `refs/effect3-workshop/src/exercises/section-2/sqlite-01-solution.ts`
- `refs/effect3-workshop/src/exercises/section-2/sqlite-02-solution.ts`

The workshop shows the same pattern in two shapes:

1. Promise-based SDK client: OpenAI
2. Synchronous resource with cleanup: sqlite / `better-sqlite3`

## Mental Model

The pattern is not "wrap every foreign method individually first".

The pattern is:

1. construct the foreign client once inside a service
2. keep the raw client private to that service
3. expose `use` as the generic escape hatch
4. build narrower helpers like `query`, `paginate`, `stream`, `completion` on top of `use`

So `use` is the low-level boundary, not the final app-facing API.

## OpenAI: Minimal Form

From `refs/effect3-workshop/src/demos/section-2/openai-01.ts:10`:

```ts
const use = <A>(f: (client: Api.OpenAI) => Promise<A>): Effect.Effect<A> =>
  Effect.promise(() => f(client));
```

What this gives you:

- call OpenAI with normal SDK code inside the callback
- get back an `Effect` instead of a bare `Promise`
- keep direct SDK access centralized in one service

Why this version is incomplete:

- no typed error mapping
- no `AbortSignal`
- no tracing/span name

Good starter shape. Not the final one to copy.

## OpenAI: Real Pattern

From `refs/effect3-workshop/src/demos/section-2/openai-02.ts:12`:

```ts
const use = Effect.fn("OpenAI.use")(
  <A>(
    f: (client: Api.OpenAI, signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, OpenAiError> =>
    Effect.tryPromise({
      try: (signal) => f(client, signal),
      catch: (cause) => new OpenAiError({ cause }),
    }),
);
```

And the error type from `refs/effect3-workshop/src/demos/section-2/openai-02.ts:28`:

```ts
export class OpenAiError extends Schema.TaggedError<OpenAiError>()(
  "OpenAiError",
  {
    cause: Schema.Defect,
  },
) {}
```

This is the actual workshop pattern.

### What `use` is doing here

- closes over a configured `client`
- accepts arbitrary SDK work as a callback
- turns Promise rejection / thrown defects into `OpenAiError`
- threads Effect interruption into SDK cancellation via `AbortSignal`
- attaches a trace name with `Effect.fn("OpenAI.use")`

This is why the pattern is powerful: every foreign call inherits the same integration rules.

## Why Callback-Based `use` Is Better Than Exposing The Raw Client

If the service returned `client` only, every caller would need to remember:

- which Effect constructor to use
- how to map errors
- how to pass cancellation
- how to name spans

With `use`, callers still write native SDK code, but the dangerous boundary is centralized.

That is the key ergonomic win: raw library ergonomics at the call site, Effect correctness at the edge.

## Higher-Level Helpers Built On Top

The workshop does not stop at `use`. It treats `use` as the primitive and then derives more specific Effect-native APIs.

### Paginated APIs -> `Stream`

From `refs/effect3-workshop/src/demos/section-2/openai-paginate-01.ts:22`:

```ts
const paginate = <Page extends AbstractPage<any>, A>(
  f: (client: Api.OpenAI) => PagePromise<Page, A>,
): Stream.Stream<A, OpenAiError> =>
  Stream.paginateChunkEffect(
    undefined,
    Effect.fn("OpenAi.paginateChunk")(function* (cursor: Page | undefined) {
      const page = yield* Effect.tryPromise({
        try: () => (cursor ? cursor.getNextPage() : f(client)),
        catch: (cause) => new OpenAiError({ cause }),
      });
      return [
        Chunk.unsafeFromArray(page.getPaginatedItems()),
        page.hasNextPage() ? Option.some(page) : Option.none(),
      ];
    }),
  );
```

Important point: the service no longer exposes OpenAI pagination as "manually chase cursors". It exports a `Stream`.

So the pattern is not only wrapping foreign effects. It also translates foreign iteration models into Effect-native ones.

### Async Iterable Streams -> `Stream`

From `refs/effect3-workshop/src/demos/section-2/openai-completions-01.ts:42`:

```ts
const stream = <A>(
  f: (
    client: Api.OpenAI,
    signal: AbortSignal,
  ) => Promise<ApiStreaming.Stream<A>>,
): Stream.Stream<A, OpenAiError> =>
  Effect.tryPromise({
    try: (signal) => f(client, signal),
    catch: (cause) => new OpenAiError({ cause }),
  }).pipe(
    Effect.map((stream) =>
      Stream.fromAsyncIterable(
        stream,
        (cause) => new OpenAiError({ cause }),
      ).pipe(Stream.ensuring(Effect.sync(() => stream.controller.abort()))),
    ),
    Stream.unwrap,
    Stream.withSpan("OpenAi.stream"),
  );
```

This adds one subtle but important idea:

- conversion of SDK async iterables into `Stream`
- explicit finalization with `Stream.ensuring(...)`
- abort the underlying SDK stream when the Effect stream ends early

That finalizer is one of the most valuable details in the workshop.

### Domain Helper On Top Of `stream`

From `refs/effect3-workshop/src/demos/section-2/openai-completions-02.ts:56`:

```ts
const completion = (
  request: ChatCompletionCreateParamsBase,
): Stream.Stream<ChatCompletionChunk, OpenAiError> =>
  stream((client, signal) =>
    client.chat.completions.create(
      {
        ...request,
        stream: true,
      },
      { signal },
    ),
  ).pipe(
    Stream.takeWhile((chunk) => chunk.choices[0].finish_reason !== "stop"),
    Stream.withSpan("OpenAi.completion"),
  );
```

This shows the full layering:

- `use` = lowest-level escape hatch
- `stream` / `paginate` = Effect-native transport adapters
- `completion` = domain-specific helper

That stack is likely the main pattern worth copying.

## SQLite: Same Pattern For Sync Libraries

The sqlite exercises show the same idea for a non-Promise API.

From `refs/effect3-workshop/src/exercises/section-2/sqlite-01-solution.ts:7`:

```ts
const db =
  yield *
  Effect.acquireRelease(
    Effect.sync(() => new Sqlite(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );
```

From `refs/effect3-workshop/src/exercises/section-2/sqlite-01-solution.ts:12`:

```ts
const use = Effect.fn("SqlClient.use")(
  <A>(f: (db: Sqlite.Database) => A): Effect.Effect<A, SqlError> =>
    Effect.try({
      try: () => f(db),
      catch: (cause) => new SqlError({ cause }),
    }),
);
```

And the query helper from `refs/effect3-workshop/src/exercises/section-2/sqlite-01-solution.ts:19`:

```ts
const query = <A = unknown>(
  sql: string,
  ...params: Array<any>
): Effect.Effect<Array<A>, SqlError> =>
  use((db) => {
    const stmt = db.prepare<Array<any>, A>(sql);
    if (stmt.reader) {
      return stmt.all(...params) ?? [];
    }
    stmt.run(...params);
    return [];
  }).pipe(Effect.withSpan("SqlClient.query", { attributes: { sql } }));
```

The difference vs OpenAI:

- use `Effect.try`, not `Effect.tryPromise`
- resource must be scoped with `Effect.acquireRelease`
- same `use` shape still works

This is important: `use` is not specific to async SDKs. It is a general boundary pattern for foreign code.

## SQLite Streaming: `Effect<Stream>` -> `Stream.unwrap`

From `refs/effect3-workshop/src/exercises/section-2/sqlite-02-solution.ts:29`:

```ts
const stream = <A = unknown>(
  sql: string,
  ...params: Array<any>
): Stream.Stream<A, SqlError> =>
  use((db) => {
    const stmt = db.prepare<Array<any>, A>(sql);
    return Stream.fromIterable(stmt.iterate(...params));
  }).pipe(
    Stream.unwrap,
    Stream.withSpan("SqlClient.stream", { attributes: { sql } }),
  );
```

Nice detail: `use` can produce a `Stream`, so the result is `Effect<Stream<...>>`, and `Stream.unwrap` flattens it.

This is a reusable move for libraries that hand you iterators/readers/cursors after an effectful acquisition step.

## What The Exercises Progressively Teach

The exercise -> solution progression is consistent:

- start with raw SDK/resource access
- add `use`
- add error typing
- add cancellation when possible
- add tracing/span names
- derive specialized helpers from `use`
- convert foreign pagination/streaming into `Stream`
- manage cleanup with `acquireRelease` when the resource needs closing

So the workshop is teaching one pattern, then reusing it across multiple integration modes.

## Why This Pattern Helps With Non-Effect Libraries

The core problem with non-Effect libraries is not just that they return `Promise` or throw.

The real problem is that they have their own model for:

- failure
- cancellation
- resource ownership
- iteration / streaming
- observability

`use` creates one translation layer where all of that gets normalized into Effect's model.

Without that layer, those concerns leak everywhere.

## Best Takeaways To Carry Into Effect v4

Even though the workshop is framed as Effect v3, the pattern maps directly onto how we should think in Effect v4.

### 1. Keep raw clients at the edge

Good pattern:

- service owns the client/resource
- app code depends on Effect-native methods
- raw SDK access only appears inside `use` callbacks or service internals

### 2. Prefer the "real" `use` shape, not the naive one

Prefer the `openai-02.ts` version:

- `Effect.tryPromise`
- typed tagged error
- `AbortSignal`
- `Effect.fn(...)`

Not the `Effect.promise(() => f(client))` starter.

### 3. Add narrow helpers on top of `use`

Do not stop at a generic escape hatch.

The workshop's stronger shape is:

- `use`
- `paginate`
- `stream`
- `query`
- `completion`

That gives you both flexibility and a domain API.

### 4. Scope resources that need cleanup

The sqlite example is the clearest proof that `use` alone is not enough.

If the foreign resource needs closing, pair `use` with `Effect.acquireRelease`.

### 5. Preserve explicit finalizers for foreign streams

`refs/effect3-workshop/src/demos/section-2/openai-completions-01.ts:50` explicitly aborts the SDK stream:

```ts
Stream.fromAsyncIterable(stream, (cause) => new OpenAiError({ cause })).pipe(
  Stream.ensuring(Effect.sync(() => stream.controller.abort())),
);
```

That is stronger than just `Stream.fromAsyncIterable(...)` because it makes early termination deterministic.

## Distilled Template

Minimal mental template extracted from the workshop:

```ts
export class Foreign extends Effect.Service<Foreign>()("Foreign", {
  effect: Effect.gen(function* () {
    const client = makeForeignClient();

    const use = Effect.fn("Foreign.use")(
      <A>(
        f: (client: Client, signal: AbortSignal) => Promise<A>,
      ): Effect.Effect<A, ForeignError> =>
        Effect.tryPromise({
          try: (signal) => f(client, signal),
          catch: (cause) => new ForeignError({ cause }),
        }),
    );

    return { use } as const;
  }),
}) {}
```

Then layer more specific helpers on top.

For sync resources, swap:

- `effect` -> `scoped` when cleanup is required
- `Effect.tryPromise` -> `Effect.try`
- client construction -> `Effect.acquireRelease`

## Bottom Line

The workshop's `use` pattern is a thin, central adapter around a foreign library.

It works because it lets callers keep natural SDK-style code while the service centrally enforces Effect concerns: typed failure, interruption, tracing, scoping, and translation into `Stream` when needed.

The deepest lesson is not "add a `use` method".

It is: define one foreign-library boundary, normalize the semantics there, then build narrower Effect-native APIs on top of that boundary.
