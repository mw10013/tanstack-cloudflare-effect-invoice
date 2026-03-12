# Effect v4 Tagged Error Research

## Question

Is `Data.TaggedError` idiomatic in Effect v4? What are the alternatives and trade-offs?

## Current Code (D1.ts)

```ts
import { Data } from "effect";

export class D1Error extends Data.TaggedError("D1Error")<{
  readonly message: string;
  readonly cause: Error;
}> {}
```

## Finding: `Data.TaggedError` Still Exists in v4

`Data.TaggedError` is still present in Effect v4 (`packages/effect/src/Data.ts` L764). It creates a class extending `YieldableError` with a `readonly _tag` property.

```ts
// Data.ts L740-757
class NotFound extends Data.TaggedError("NotFound")<{
  readonly resource: string;
}> {}
```

**However**, the Effect v4 docs (`LLMS.md`, `ai-docs/`) **never use `Data.TaggedError`**. Every single error example uses `Schema.TaggedErrorClass` instead.

## The v4 Idiomatic Way: `Schema.TaggedErrorClass`

From `LLMS.md` L40-43, L79-82, L135-137, L160-168 and all `ai-docs/src/01_effect/03_errors/` examples:

```ts
import { Schema } from "effect";

export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect, // Schema.Defect handles unknown/Error causes
}) {}
```

### Key Differences from `Data.TaggedError`

| Feature              | `Data.TaggedError`               | `Schema.TaggedErrorClass`                       |
| -------------------- | -------------------------------- | ----------------------------------------------- |
| Callable syntax      | `("Tag")<{ fields }>`            | `<Self>()("Tag", { schemaFields })`             |
| Field types          | Raw TS types (`string`, `Error`) | Schema types (`Schema.String`, `Schema.Defect`) |
| Serialization        | No                               | Yes (encode/decode via Schema)                  |
| Validation           | No                               | Yes (runtime type checking)                     |
| HTTP API integration | Manual                           | Built-in `httpApiStatus` annotation             |
| v4 docs coverage     | Zero examples                    | All examples                                    |

### Construction & Yielding

Errors are yieldable in `Effect.gen` — yielding fails the effect:

```ts
// From ai-docs/src/01_effect/01_basics/02_effect-fn.ts L24-27
// Always `return yield*` to help TS control flow
return yield * new D1Error({ message: "query failed", cause: someError });
```

### Wrapping Foreign Errors with `Schema.Defect`

`Schema.Defect` is the v4 idiom for wrapping unknown/thrown errors as a `cause` field. Used pervasively:

```ts
// From ai-docs/src/01_effect/01_basics/10_creating-effects.ts L9-17
class InvalidPayload extends Schema.TaggedErrorClass<InvalidPayload>()(
  "InvalidPayload",
  {
    input: Schema.String,
    cause: Schema.Defect, // accepts any thrown value
  },
) {}

// From LLMS.md L135-137
class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Defect,
  },
) {}
```

Usage with `Effect.tryPromise`:

```ts
// From ai-docs L46-56
export const fetchUser = Effect.fn("fetchUser")((userId: number) =>
  Effect.tryPromise({
    async try() {
      /* ... */
    },
    catch: (cause) => new UserLookupError({ userId, cause }),
  }),
);
```

### Handling: `catchTag` / `catchTags`

```ts
// From ai-docs/src/01_effect/03_errors/01_error-handling.ts L20-23
Effect.catchTag(["ParseError", "ReservedPortError"], (_) =>
  Effect.succeed(3000),
);

// From ai-docs/src/01_effect/03_errors/10_catch-tags.ts L19-23
Effect.catchTags({
  ValidationError: (error) =>
    Effect.succeed(`Validation failed: ${error.message}`),
  NetworkError: (error) =>
    Effect.succeed(`Network request failed with status ${error.statusCode}`),
});
```

### HTTP API Integration

```ts
// From ai-docs/src/51_http-server/fixtures/Users.ts L4-9
class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  {},
  { httpApiStatus: 404 },
) {}
```

## Advanced Pattern: Reason Errors

From `ai-docs/src/01_effect/03_errors/20_reason-errors.ts` — compose multiple sub-errors under a single parent using a `reason` union field:

```ts
class RateLimitError extends Schema.TaggedErrorClass<RateLimitError>()(
  "RateLimitError",
  {
    retryAfter: Schema.Number,
  },
) {}

class QuotaExceededError extends Schema.TaggedErrorClass<QuotaExceededError>()(
  "QuotaExceededError",
  {
    limit: Schema.Number,
  },
) {}

class AiError extends Schema.TaggedErrorClass<AiError>()("AiError", {
  reason: Schema.Union([RateLimitError, QuotaExceededError]),
}) {}

// Handle with Effect.catchReason or Effect.catchReasons
callModel.pipe(
  Effect.catchReason("AiError", "RateLimitError", (reason) =>
    Effect.succeed(`Retry after ${reason.retryAfter} seconds`),
  ),
);
```

## Constructs Comparison for D1Error

### Option 1: `Schema.TaggedErrorClass` (Recommended)

```ts
export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

**Pros**: v4 idiomatic, serializable, runtime validation, `Schema.Defect` handles foreign errors, future HTTP API integration ready.
**Cons**: Slightly more verbose field definitions.

### Option 2: `Data.TaggedError` (Current)

```ts
export class D1Error extends Data.TaggedError("D1Error")<{
  readonly message: string;
  readonly cause: Error;
}> {}
```

**Pros**: Simpler syntax, still works in v4.
**Cons**: No serialization, no runtime validation, not used anywhere in v4 docs, `cause: Error` doesn't handle unknown thrown values as cleanly as `Schema.Defect`.

### Option 3: Reason Errors (Over-engineered for D1)

```ts
class ConstraintViolation extends Schema.TaggedErrorClass<ConstraintViolation>()(
  "ConstraintViolation",
  {},
) {}
class QueryError extends Schema.TaggedErrorClass<QueryError>()(
  "QueryError",
  {},
) {}

class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  reason: Schema.Union([ConstraintViolation, QueryError]),
}) {}
```

**Pros**: Fine-grained error handling per reason.
**Cons**: Over-engineering — D1 errors are infrastructure, not domain-level branching. Retry logic already handles the distinction via message matching.

## Recommendation

**Use `Schema.TaggedErrorClass` with `cause: Schema.Defect`** (Option 1).

- Aligns with every v4 example in `LLMS.md` and `ai-docs/`
- `Schema.Defect` replaces the manual `Cause.isUnknownError` → `Error` extraction in `tryD1`
- Consistent with `DatabaseError` pattern from `LLMS.md` L135-137
- No behavioral change needed in retry logic or `tryD1` helper
