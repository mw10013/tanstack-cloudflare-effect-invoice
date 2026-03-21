# Research: Replacing D1 Service with @effect/sql-d1

## Current D1 Service (`src/lib/D1.ts`)

Thin ServiceMap wrapper over Cloudflare's raw D1 API:

```
prepare(query)        → D1PreparedStatement
batch(stmts, opts?)   → Effect<D1Result<T>[], D1Error>  (calls d1.batch())
run(stmt, opts?)      → Effect<D1Result<T>, D1Error>
first(stmt)           → Effect<Option<T>, D1Error>
```

- `idempotentWrite` enables retry (2x exponential + jitter) for 6 known transient D1 errors
- All queries use raw SQL strings with positional `?1`, `?2` params
- Usage: 13+ `first()` reads, 3 `run()` writes, 2 `batch()` multi-statement writes

## @effect/sql-d1

Source: `refs/effect4/packages/sql/d1/src/D1Client.ts`

Template-literal SQL builder returning Effect-wrapped results:

```ts
const sql = yield* SqlClient

const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`
yield* sql`INSERT INTO users ${sql.insert({ name: "alice", email: "a@b.com" })}`
yield* sql`UPDATE users SET ${sql.update(changes)} WHERE id = ${id}`

sql.and([...clauses])  sql.or([...clauses])  sql.in([1, 2, 3])
sql.unsafe("SELECT * FROM users", [])
stmt.compile()  // → [sqlString, params] tuple — synchronous, no execution
```

**Does NOT support:** `d1.batch()`, transactions, streaming, multi-row UPDATE.

**Additional features:** SqlResolver (read batching/dedup), SqlSchema (schema-validated queries), SqlModel (CRUD repos), prepared statement cache (LRU 200, 10min TTL), row transforms, tracing.

## Why batch() Matters

D1 rejects `BEGIN`/`COMMIT`. `batch()` is the **only way to get transactional atomicity**:

> "Batched statements are SQL transactions. If a statement in the sequence fails, it aborts or rolls back the entire sequence." — Cloudflare docs

## Augmenting @effect/sql-d1 with batch()

### Key Insight

`statement.compile()` synchronously returns `[sql, params]` without executing. All SqlClient helpers (`sql.insert()`, `sql.in()`, `sql.and()`, etc.) compile to valid SQLite with positional `?` placeholders.

### Wrapper Service: Build with SqlClient, Execute with d1.batch()

```ts
class Sql extends ServiceMap.Service<Sql>()("Sql", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { D1: rawD1 } = yield* CloudflareEnv

    const batch = Effect.fn("Sql.batch")(function* <T = Record<string, unknown>>(
      statements: ReadonlyArray<Statement.Statement<any>>,
      options?: { readonly idempotentWrite?: boolean },
    ) {
      const prepared = statements.map((stmt) => {
        const [query, params] = stmt.compile()
        return rawD1.prepare(query).bind(...params)
      })
      return yield* tryD1(() => rawD1.batch<T>(prepared)).pipe(
        retryIfIdempotentWrite(options?.idempotentWrite),
      )
    })

    return { ...sql, batch }
  }),
}) {}
```

Usage:

```ts
const sql = yield* Sql

// single queries — delegates to SqlClient
const users = yield* sql`SELECT * FROM users WHERE id = ${id}`

// batch — compiles + d1.batch() for transactional atomicity
yield* sql.batch([
  sql`INSERT INTO orders ${sql.insert(order)}`,
  sql`UPDATE inventory SET stock = stock - ${qty} WHERE product_id = ${productId}`,
], { idempotentWrite: true })
```

**D1 metadata** fully accessible on batch results (`result.meta.changes`, etc.). For single queries via SqlClient, metadata is hidden — use `sql.unsafe()` or add a `runRaw` method if needed.

**Result transforms:** `transformQueryNames` applies consistently (same compiler). `transformResultNames` does NOT apply on batch results since we bypass SqlClient execution — apply manually or via `Schema.decodeUnknown` if needed. Minor since batch ops are writes.

**Caveat:** Spreading SqlClient's interface means we couple to its shape. If upstream adds a `batch` property, we'd shadow it.

## Adding idempotentWrite Retry to SqlClient Queries

`SqlError` has the same shape as our `D1Error` (`cause: Defect`, `message: optional(String)`), so the retry predicate transfers directly.

### Approach: Retry combinator on the wrapper service

Add a `retryable` method that wraps any `Effect<A, SqlError>` with our D1 transient-error retry:

```ts
const RETRYABLE_ERROR_SIGNALS = [
  "reset because its code was updated",
  "starting up d1 db storage caused object to be reset",
  "network connection lost",
  "internal error in d1 db storage caused object to be reset",
  "cannot resolve d1 db due to transient issue on remote node",
  "can't read from request stream because client disconnected",
] as const

const retryTransientD1 = <A, R>(effect: Effect.Effect<A, SqlError, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => {
        const message = (error.message ?? "").toLowerCase()
        return RETRYABLE_ERROR_SIGNALS.some((signal) => message.includes(signal))
      },
      times: 2,
      schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
    }),
  )
```

Integrated into the Sql wrapper:

```ts
class Sql extends ServiceMap.Service<Sql>()("Sql", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { D1: rawD1 } = yield* CloudflareEnv

    const batch = Effect.fn("Sql.batch")(function* <T = Record<string, unknown>>(
      statements: ReadonlyArray<Statement.Statement<any>>,
      options?: { readonly idempotentWrite?: boolean },
    ) {
      const prepared = statements.map((stmt) => {
        const [query, params] = stmt.compile()
        return rawD1.prepare(query).bind(...params)
      })
      return yield* tryD1(() => rawD1.batch<T>(prepared)).pipe(
        options?.idempotentWrite ? retryTransientD1 : identity,
      )
    })

    return { ...sql, batch, retryable: retryTransientD1 }
  }),
}) {}
```

Usage:

```ts
const sql = yield* Sql

// read — no retry needed
const users = yield* sql`SELECT * FROM users WHERE id = ${id}`

// single write with retry
yield* sql.retryable(sql`UPDATE sessions SET activeOrganizationId = ${orgId} WHERE userId = ${userId}`)

// batch with retry
yield* sql.batch([
  sql`DELETE FROM Organization WHERE ...`,
  sql`DELETE FROM User WHERE id = ${userId} RETURNING *`,
], { idempotentWrite: true })
```

`retryable` is opt-in per query — same semantics as current `idempotentWrite: true`. Reads don't need it. Writes that are idempotent opt in explicitly.

## Trade-offs

### Gains
1. Composable template-literal SQL builder
2. SqlResolver for read batching/dedup
3. SqlSchema/SqlModel for schema-validated queries and CRUD
4. Prepared statement cache, row transforms, tracing
5. Ecosystem alignment — swap D1 for Postgres later with minimal changes

### Losses (mitigated)
1. ~~batch()~~ — preserved via compile-and-batch wrapper
2. ~~idempotentWrite~~ — `retryTransientD1` combinator on wrapper, opt-in per query
3. ~~D1 metadata~~ — accessible on batch; single-query meta via `sql.unsafe()`
4. `first()` → `Option` — use `SqlSchema.findOneOption` instead

## Recommendation

**Adopt @effect/sql-d1 with compile-and-batch wrapper service.**

- Single query syntax for all paths (reads, writes, batch)
- Transactional batch preserved via `.compile()` + `d1.batch()`
- Incremental migration — wrapper coexists with current D1 service
- Future-proof: drop wrapper if upstream adds batch; queries transfer to Postgres

**Migration effort:**

| Area | Effort |
|------|--------|
| Sql wrapper service | Low (~30 lines) |
| Repository queries (45 statements) | Medium (mechanical rewrite) |
| Layer composition | Low |
| batch() call sites | Low |

## Open Questions

- SqlResolver useful for any current N+1 patterns?
- Apply `transformResultNames`/`transformQueryNames` or keep current naming?
- Track @effect/sql-d1 repo for native batch() support?
