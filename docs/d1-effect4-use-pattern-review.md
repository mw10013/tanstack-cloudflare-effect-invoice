# D1 Review Against Effect v4 `use` Research

Question: after grounding the `use` research in Effect v4, does `src/lib/D1.ts` need refactoring?

## Short Answer

No major refactor needed.

`src/lib/D1.ts` already follows the important v4 ideas:

- `ServiceMap.Service` with `make` in `src/lib/D1.ts:4`
- explicit layer in `src/lib/D1.ts:53`
- foreign Promise boundary wrapped with `Effect.tryPromise` in `src/lib/D1.ts:70`
- public methods traced with `Effect.fn(...)` in `src/lib/D1.ts:8`, `src/lib/D1.ts:18`, `src/lib/D1.ts:28`

The one notable caveat is `prepare`.

From `src/lib/D1.ts:7`:

```ts
const prepare = (query: string) => d1.prepare(query);
```

That does leak raw D1 prepared statements past the service boundary.

From `src/lib/Repository.ts:12`:

```ts
const result =
  yield *
  d1.first(d1.prepare(`select * from User where email = ?1`).bind(email));
```

So yes, `prepare` is an abstraction leak.

But we accept it.

Why:

- the important execution boundary is still centralized in `tryD1`
- retry behavior is still centralized in `retryIfIdempotentWrite`
- the current API matches D1 naturally, especially for bound statements and `batch`
- trying to hide `prepare` risks creating a worse API than the raw D1 shape

## Bottom Line

The v3 `use` pattern is philosophically relevant here, not literally.

Applied to `src/lib/D1.ts`:

- no, it should not gain a custom `use` method
- no, it does not need a broader refactor
- yes, `prepare` leaks the underlying D1 abstraction
- yes, that leak is acceptable in this service
