# Effect 4 Logging & Console Research (Updated)

## Two Systems: `Effect.log*` vs `Console`

Effect 4 has two separate mechanisms:

1. `Effect.log*` + `Logger` for structured, leveled, configurable logging
2. `Console.*` for effectful wrappers around native console methods

Grounding:

- `Effect.ts` says `annotateLogs` "Adds an annotation to each log line in this effect" and `withLogSpan` "Adds a span to each log line" (`refs/effect4/packages/effect/src/Effect.ts:13163`, `refs/effect4/packages/effect/src/Effect.ts:13260`)
- `Console.ts` says Console is "Type-safe", "Testable", and "Service-based" (`refs/effect4/packages/effect/src/Console.ts:8-12`)

## Answers To The Annotations

### `annotateLogs` vs `annotateLogsScoped`

Short answer:

- `annotateLogs` annotates the provided effect (including nested work executed inside it)
- `annotateLogsScoped` mutates log annotations for the whole current `Scope`, then restores prior state when scope closes

Grounding:

- API docs: "This differs from `annotateLogs` ... `annotateLogsScoped` updates annotations for the entire current `Scope` and restores the previous annotations when the scope closes" (`refs/effect4/packages/effect/src/Effect.ts:13232-13234`)
- Internal implementation explicitly snapshots previous annotations and restores in a scope finalizer (`refs/effect4/packages/effect/src/internal/effect.ts:5856-5876`)
- Test proof:
  - `[{},{ requestId: "req-123" },{}]` (`refs/effect4/packages/effect/test/Logger.test.ts:60`)
  - `[{ outer: "program" }, { outer: "program", inner: "scope" }, {}]` (`refs/effect4/packages/effect/test/Logger.test.ts:84-85`)

### Format vs Console vs Tracer

- `format*` loggers (`formatSimple`, `formatLogFmt`, `formatStructured`, `formatJson`) are formatters; they produce output values
- `console*` loggers (`consoleJson`, `consoleStructured`, `consoleLogFmt`, `consolePretty`) are formatter + sink (they write to console)
- `tracerLogger` writes log events onto the active trace span (not stdout/stderr)

Grounding:

- `withConsoleLog` implementation calls `console.log(self.log(options))` (`refs/effect4/packages/effect/src/Logger.ts:309-315`)
- `tracerLogger` calls `span.event(...)` with attributes (`refs/effect4/packages/effect/src/internal/effect.ts:6196-6214`)

### Which logger for Cloudflare production?

Recommendation:

- Production default: `Logger.consoleJson`
- Dev local: `Logger.consolePretty()`
- Optional: combine both during transition/debug

Why:

- `consoleJson` docs: "Perfect for production logging and log aggregation" (`refs/effect4/packages/effect/src/Logger.ts:1020`)
- `formatJson` is single-line JSON (`refs/effect4/packages/effect/src/Logger.ts:698-704`)
- Cloudflare Workers runtime surfaces console output; JSON lines are easiest to query/pipe

### What do `mergeWithExisting` and multiple loggers mean?

- Multiple loggers: every log entry fan-outs to each logger in the active set
- `mergeWithExisting: false` (default): replace current logger set
- `mergeWithExisting: true`: start from existing set, then add new loggers

Grounding:

- Runtime loop iterates all current loggers: `for (const logger of loggers) { logger.log(...) }` (`refs/effect4/packages/effect/src/internal/effect.ts:5962-5966`)
- `Logger.layer` builds `new Set(existing?)` and adds each new logger (`refs/effect4/packages/effect/src/Logger.ts:1169-1172`)
- Default logger set is `new Set([defaultLogger, tracerLogger])` (`refs/effect4/packages/effect/src/internal/effect.ts:5839`)

Implication:

- If you replace loggers, you also drop default `tracerLogger` unless you add it back or merge.

### Why `Layer.unwrap`?

`Layer.unwrap` flattens `Effect<Layer<...>>` into `Layer<...>`.

Grounding:

- `Layer.ts`: "Unwraps a Layer from an Effect, flattening the nested structure" (`refs/effect4/packages/effect/src/Layer.ts:845-849`)
- So env/config-dependent layer selection needs `unwrap`, because selection is effectful (`refs/effect4/ai-docs/src/08_observability/10_logging.ts:43-49`)

### What is a tracing span? How it combines with `annotateLogs`?

- A span is a timed tracing context (`Effect.withSpan` / `Effect.fn("name")`)
- `Effect.fn("name")` creates a traced function and adds span/stack-frame metadata
- `Effect.withLogSpan("label")` adds elapsed `label=<N>ms` into log records
- `Effect.annotateLogs(...)` adds key-value log annotations
- Together: each log entry can include both timing span fields and annotations

Grounding:

- `Effect.fn` docs: "Creates a traced function ... adds spans" (`refs/effect4/packages/effect/src/Effect.ts:12823`)
- AI docs: `Effect.fn("...")` attaches tracing span via `Effect.withSpan` (`refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts:13-15`)
- `formatStructured` includes both `annotations` and `spans` in output (`refs/effect4/packages/effect/src/Logger.ts:666-693`)

### When to use `Console` instead of `Effect.log*`?

Use `Console` when you need console-native features:

- `group/groupCollapsed/groupEnd`
- `time/timeEnd/timeLog`
- `table`, `dir`, `trace`, assertions

Use `Effect.log*` when you need:

- log levels and filtering
- structured fields/annotations
- pluggable sinks and fan-out
- trace correlation (`tracerLogger`)

Grounding:

- Console feature list (`refs/effect4/packages/effect/src/Console.ts:17-22`)
- Minimum level filtering reference (`refs/effect4/packages/effect/src/References.ts:460-461`)

### `Console.withGroup` output impact

`withGroup` wraps effect execution in `console.group(...)`/`console.groupCollapsed(...)`, then always calls `console.groupEnd()`.

Grounding:

- Acquire/use/release implementation (`refs/effect4/packages/effect/src/Console.ts:668-680`)

### `Console.withTime` output impact

`withTime` calls `console.time(label)` before execution and `console.timeEnd(label)` after execution.

Grounding:

- Acquire/use/release implementation (`refs/effect4/packages/effect/src/Console.ts:715-721`)

## Corrected Patterns For `Auth.ts`

### No `await` inside Effect generators

For Promise APIs in callbacks, wrap with `Effect.tryPromise` and `yield*`:

```ts
sendMagicLink: (data) =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.logInfo("sendMagicLink", { email: data.email });
      yield* Effect.tryPromise(() =>
        kv.put("demo:magicLink", data.url, { expirationTtl: 60 }),
      );
    }).pipe(
      Effect.annotateLogs({ service: "better-auth", hook: "sendMagicLink" }),
    ),
  );
```

Grounding:

- `Effect.tryPromise` is the Effect way to wrap Promise APIs (`refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:45-56`)

### Suggested logger layer strategy

```ts
const LoggerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* Config.string("NODE_ENV").pipe(
      Config.withDefault("development"),
    );
    return env === "production"
      ? Logger.layer([Logger.consoleJson, Logger.tracerLogger], {
          mergeWithExisting: false,
        })
      : Logger.layer([Logger.consolePretty(), Logger.tracerLogger], {
          mergeWithExisting: false,
        });
  }),
);
```

Notes:

- Explicitly keep `Logger.tracerLogger` when replacing logger set
- Add `Layer.succeed(References.MinimumLogLevel, "Warn")` in production if needed

## `Auth.ts` Logging Plan (RunEffect-First)

Constraint from annotation:

- Every `console.*` call in `src/lib/Auth.ts` must move under `runEffect(...)`

### Phase 0: Bootstrap logging in `makeRunEffect` (`src/worker.ts`)

Yes, this is required for app-wide consistency.

Why:

- `makeRunEffect` is the runtime choke point: `Effect.runPromiseExit(Effect.provide(effect, appLayer))` (`src/worker.ts:67`)
- Every Auth call path uses this runner (`src/worker.ts:122`, `src/worker.ts:183`)
- No explicit logger layer is configured in `src/` yet (`rg "Logger.layer|MinimumLogLevel" src` => none)

Effect implication:

- `Effect.log*` will work with defaults, but format/level policy is uncontrolled
- to enforce JSON vs pretty and minimum level, provide logger + `References.MinimumLogLevel` in `makeRunEffect`

Grounding:

- Default logger set contains `defaultLogger` and `tracerLogger` (`refs/effect4/packages/effect/src/internal/effect.ts:5839`)
- Logger override/merge behavior is controlled by `Logger.layer(..., { mergeWithExisting })` (`refs/effect4/packages/effect/src/Logger.ts:1113-1117`)
- Minimum threshold controlled by `References.MinimumLogLevel` (`refs/effect4/packages/effect/src/References.ts:460-461`)

Suggested bootstrap shape:

```ts
const loggerLayer =
  env.ENVIRONMENT === "production"
    ? Layer.merge(
        Logger.layer([Logger.consoleJson, Logger.tracerLogger], {
          mergeWithExisting: false,
        }),
        Layer.succeed(References.MinimumLogLevel, "Info"),
      )
    : Layer.merge(
        Logger.layer([Logger.consolePretty(), Logger.tracerLogger], {
          mergeWithExisting: false,
        }),
        Layer.succeed(References.MinimumLogLevel, "Debug"),
      );
```

Then compose this into the layer passed to `Effect.provide(..., layer)` inside `makeRunEffect`.

Current inventory:

- `22` `console.*` call sites in `src/lib/Auth.ts`

Grounding:

- Existing `runEffect` bridge already exists: `const runEffect = Effect.runPromiseWith(services)` (`src/lib/Auth.ts:283`)
- Logger fan-out and level filtering behavior in runtime (`refs/effect4/packages/effect/src/internal/effect.ts:5962-5966`, `refs/effect4/packages/effect/src/References.ts:460-461`)

### Phase 1: Add a single auth logging boundary

Add one reusable helper inside `createBetterAuthOptions`:

- Wrap effects with `Effect.annotateLogs({ service: "Auth", module: "better-auth" })`
- Keep callback shape by returning `runEffect(...)`

Result:

- every callback migration is mechanical
- shared metadata on all Auth logs

### Phase 2: Migrate callback groups in order

1. Hooks and database hooks
2. Magic link + invitation email callbacks
3. Stripe plugin callbacks

Call sites:

1. Database hook defaults
   - `databaseHooks.user.create.after` (`src/lib/Auth.ts:94`)
   - `databaseHooks.session.create.before` (`src/lib/Auth.ts:104`)
2. Existing runEffect branch using `Effect.sync(() => console.log(...))`
   - `hooks.before` (`src/lib/Auth.ts:119-121`)
   - `authorizeReference` (`src/lib/Auth.ts:214-218`)
3. Async callbacks with raw console + Promise APIs
   - `sendMagicLink` (`src/lib/Auth.ts:132-141`)
   - `sendInvitationEmail` (`src/lib/Auth.ts:153-160`)
4. Stripe lifecycle callbacks returning `Promise.resolve()`
   - `onTrialStart` (`src/lib/Auth.ts:180-183`)
   - `onTrialEnd` (`src/lib/Auth.ts:186-189`)
   - `onTrialExpired` (`src/lib/Auth.ts:192-195`)
   - `onSubscriptionComplete` (`src/lib/Auth.ts:223-226`)
   - `onSubscriptionUpdate` (`src/lib/Auth.ts:229-232`)
   - `onSubscriptionCancel` (`src/lib/Auth.ts:235-238`)
   - `onSubscriptionDeleted` (`src/lib/Auth.ts:241-244`)
   - `onCustomerCreate` (`src/lib/Auth.ts:260-263`)
   - `onEvent` (`src/lib/Auth.ts:266-269`)

### Phase 3: Use this conversion pattern everywhere

Pattern A: pure log callback

```ts
onSubscriptionUpdate: ({ subscription }) =>
  runEffect(
    Effect.logInfo("stripe plugin: onSubscriptionUpdate", {
      subscriptionId: subscription.id,
    }).pipe(Effect.annotateLogs({ hook: "stripe.onSubscriptionUpdate" })),
  );
```

Pattern B: log + Promise side effect

```ts
sendMagicLink: (data) =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.logInfo("sendMagicLink", { email: data.email });
      yield* Effect.tryPromise(() =>
        kv.put("demo:magicLink", data.url, { expirationTtl: 60 }),
      );
    }).pipe(Effect.annotateLogs({ hook: "magicLink.sendMagicLink" })),
  );
```

Grounding:

- `Effect.tryPromise` for Promise APIs (`refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts:45-56`)

### Phase 4: Log level and annotation policy

1. `Debug`: noisy internal hooks (`databaseHooks.*`, authorize checks)
2. `Info`: product events (magic link, invite email, subscription lifecycle)
3. `Warning`: unexpected but non-fatal states
4. `Error`: caught failures before rethrow / propagation

Always attach stable keys:

- `service`, `hook`, `userId`, `subscriptionId`, `organizationId`, `path`

### Phase 5: Verification checklist

1. `rg -n "console\\." src/lib/Auth.ts` returns `0`
2. `pnpm typecheck`
3. `pnpm lint`
4. Exercise sign-in / invite / subscription flows and verify structured log output
