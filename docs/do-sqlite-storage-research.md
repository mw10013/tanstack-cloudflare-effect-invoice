# Durable Object SQLite Storage Research

Deep research on DO SQLite storage internals, Effect v4 integration patterns, and whether/how to build an Effect service around DO SQLite (analogous to our D1 service).

---

## 1. DO SQLite Storage Fundamentals

### How it works

Each SQLite-backed Durable Object gets a **private, transactional, strongly consistent SQLite database**. Accessed via `ctx.storage.sql` (type: `SqlStorage`). The Agent base class wraps this as `this.sql` tagged template.

> Source: `refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx`

### SQL execution — `sql.exec()`

```ts
sql.exec(query: string, ...bindings: any[]): SqlStorageCursor
```

- **Synchronous** — does NOT return a Promise, does NOT require `await`
- Multiple semicolon-separated statements supported (bindings apply to last statement only)
- Returns `SqlStorageCursor` (Iterable + Iterator)

**Cursor API:**

| Method/Property | Description |
|---|---|
| `toArray()` | Collects remaining rows into array of objects |
| `one()` | Returns exactly one row; **throws** if zero or multiple |
| `raw()` | Iterator of arrays (column values, no names) |
| `columnNames` | `string[]` of column names |
| `rowsRead` / `rowsWritten` | Billing counters |
| `databaseSize` | Current DB size in bytes |

### Synchronous vs asynchronous — the critical distinction

**All SQL operations are synchronous.** This is the fundamental difference from D1.

Implications:
- No `await` needed — no event loop yield between SQL calls
- Multiple SQL calls without intervening `await` execute atomically (no interleaving from other requests)
- Input gates block new events while synchronous JS executes
- Output gates hold outgoing network messages until pending storage writes complete

> Source: `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx`

---

## 2. Transactions

### Automatic write coalescing (preferred)

Any series of write operations **without intervening `await`** are automatically submitted as an implicit atomic transaction. No explicit transaction call needed.

```ts
// These three commit together atomically — no explicit transaction needed
sql.exec("update accounts set balance = balance - ? where id = ?", amount, fromId);
sql.exec("update accounts set balance = balance + ? where id = ?", amount, toId);
sql.exec("insert into transfers (from_id, to_id, amount) values (?, ?, ?)", fromId, toId, amount);
```

Also: multiple semicolon-separated statements in a single `sql.exec()` call execute atomically.

### `transactionSync()` — explicit

```ts
ctx.storage.transactionSync(callback: () => T): T
```

- Callback **must be synchronous** (no async, no Promises)
- If callback throws, transaction is **rolled back**
- Returns callback's result

### When you actually need `transactionSync()`

Mostly **you don't**. Write coalescing handles most cases. Use `transactionSync()` when:
- You need read-then-write atomicity with rollback on failure
- You want explicit rollback semantics on exception

### Anti-pattern: `await` breaks coalescing

```ts
// BAD — await between writes breaks atomicity
const balance = sql.exec("select balance from accounts where id = ?", id).one();
await fetch("https://external-service.com/validate"); // ← opens input gate, other requests can interleave
sql.exec("update accounts set balance = ? where id = ?", newBalance, id); // ← may conflict
```

### What this means for Effect

**Effect generators that `yield*` synchronous Effects don't break coalescing.** The Effect runtime evaluates `Effect.try(() => sql.exec(...))` synchronously — no microtask boundary is introduced. Multiple `yield*` of sync Effects in sequence remain atomic.

An `await` or `yield*` of an async Effect (e.g., `Effect.tryPromise`) **will** break coalescing. This is exactly what happens in `onInvoiceUpload`: the upsert and setExtracting are separated by `runWorkflow` (async), so they commit as separate transactions. This is correct for that use case.

---

## 3. Migrations

### Cloudflare-level

In wrangler config: `new_sqlite_classes` array marks new classes as SQLite-backed. Cannot convert existing KV-backed classes.

### Application-level schema migrations

`PRAGMA user_version` is NOT supported. Manual approach:

```ts
// Track schema version in a migrations table
sql.exec(`create table if not exists _sql_schema_migrations (
  id integer primary key,
  applied_at text not null default (datetime('now'))
)`);
// Check max version, run missing migrations
```

Best place: in `blockConcurrencyWhile()` in constructor (current pattern uses synchronous DDL directly in constructor, which also works since constructor is synchronous).

> Source: `refs/cloudflare-docs/src/content/docs/durable-objects/reference/durable-objects-migrations.mdx`

---

## 4. Error Handling and Retries

### Error types from the caller's perspective (stub → DO)

| Property | Meaning | Retry? |
|---|---|---|
| `error.retryable === true` | Transient internal error | Yes (with backoff, if idempotent) |
| `error.overloaded === true` | DO is overloaded | **No** — retrying worsens it |
| Neither | Application error | Depends on application logic |

### Errors within the DO itself

**SQL-specific errors:**
- `one()` throws if zero rows or multiple rows
- Constraint violations (UNIQUE, FOREIGN KEY, CHECK) throw
- Malformed SQL throws

**Constructor exceptions:**
- If constructor throws, DO is **terminated and reset**
- Use `try...catch` to prevent state corruption

**Stub lifecycle:**
- Many exceptions leave `DurableObjectStub` in "broken" state
- Best practice: create a new stub for each retry

### Retryable error signals — DO vs D1

Our D1 service retries on these signals:

```ts
const RETRYABLE_ERROR_SIGNALS = [
  "reset because its code was updated",
  "starting up d1 db storage caused object to be reset",
  "network connection lost",
  "internal error in d1 db storage caused object to be reset",
  "cannot resolve d1 db due to transient issue on remote node",
  "can't read from request stream because client disconnected",
];
```

These are **D1-specific** (D1 uses DOs under the hood). For DO SQLite accessed from *within* the DO:
- "network connection lost" doesn't apply (local access)
- "starting up..." / "reset because..." — the DO restarts, constructor re-runs, caller gets an error on the stub
- SQL errors within the DO are typically constraint violations or logic errors — **not retryable**

**Retry strategy for DO SQLite should be at the caller (stub) level, not inside the DO.** Inside the DO, SQL errors are deterministic — retrying the same synchronous SQL won't produce a different result.

> Source: `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/error-handling.mdx`

---

## 5. Limits

| Limit | Value |
|---|---|
| Per-DO storage | 10 GB |
| Max columns per table | 100 |
| Max string/BLOB/row size | 2 MB |
| Max SQL statement length | 100 KB |
| Max bound parameters | 100 |
| Per-account storage (paid) | Unlimited |

> Source: `refs/cloudflare-docs/src/content/docs/durable-objects/platform/limits.mdx`

---

## 6. Effect v4's Existing DO SQLite Support

### `@effect/sql-sqlite-do` — full implementation exists

> Source: `refs/effect4/packages/sql/sqlite-do/src/SqliteClient.ts`

Effect v4 has a complete DO SQLite client. Key design:

```ts
export const SqliteClient = ServiceMap.Service<SqliteClient>("@effect/sql-sqlite-do/SqliteClient")

export interface SqliteClientConfig {
  readonly db: SqlStorage
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: ((str: string) => string)
  readonly transformQueryNames?: ((str: string) => string)
}
```

**How it wraps synchronous operations:**

```ts
const runStatement = (sql: string, params: ReadonlyArray<unknown> = []):
  Effect.Effect<ReadonlyArray<any>, SqlError, never> =>
  Effect.try({
    try: () => Array.from(runIterator(sql, params)),
    catch: (cause) => new SqlError({ cause, message: `Failed to execute statement` })
  })
```

Uses `Effect.try` (not `Effect.tryPromise`) — preserves synchronous semantics.

**Transaction support via Semaphore:**

```ts
const semaphore = yield* Semaphore.make(1)
const connection = yield* makeConnection

const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
  const fiber = Fiber.getCurrent()!
  const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope)
  return Effect.as(
    Effect.tap(
      restore(semaphore.take(1)),
      () => Scope.addFinalizer(scope, semaphore.release(1))
    ),
    connection
  )
})
```

The semaphore ensures sequential access. Transaction acquirer holds the semaphore for the scope's lifetime via a finalizer.

**Layer construction:**

```ts
export const layer = (config: SqliteClientConfig):
  Layer.Layer<SqliteClient | Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(
        ServiceMap.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
```

Provides both the specific `SqliteClient` and generic `Client.SqlClient`.

### `@effect/sql-d1` — for comparison

> Source: `refs/effect4/packages/sql/d1/src/D1Client.ts`

Key difference: D1 uses `Effect.tryPromise` (async), and transactions are explicitly NOT supported:

```ts
transactionAcquirer = Effect.die("transactions are not supported in D1")
```

---

## 7. Analysis: Should We Build a DO SQLite Effect Service?

### Option A: Use `@effect/sql-sqlite-do` directly

**What it gives us:**
- Full Effect SQL client with `SqlClient` interface
- Tagged template SQL via `Statement` module
- Automatic column name transforms (camelCase ↔ snake_case)
- Semaphore-based transaction support
- Reactive query invalidation via `Reactivity`
- Span attributes for observability

**What it costs:**
- Dependency on `@effect/sql-sqlite-do` package (unstable — `effect/unstable/sql/`)
- Different query pattern from our current `this.sql` tagged template
- Need to adapt Agent class integration (pass `ctx.storage.sql` as `SqlStorage`)
- Heavier abstraction than what we currently need

**How it would look:**

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  const sqliteLayer = SqliteDo.layer({ db: ctx.storage.sql });
  const loggerLayer = makeLoggerLayer(env);
  this.runEffect = (effect) =>
    Effect.runPromise(Effect.provide(effect, Layer.merge(sqliteLayer, loggerLayer)));
}
```

Repository methods would use the `SqlClient` interface:

```ts
const getInvoices = Effect.fn("...", function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select * from Invoice order by createdAt desc`;
});
```

### Option B: Custom thin service (current plan from organization-repository-research.md)

**What it gives us:**
- Minimal abstraction — just wraps `this.sql` tagged template
- Consistent with current codebase patterns (AgentSql mirrors CloudflareEnv)
- No external dependency
- No API mismatch — uses the exact same `this.sql` signature

**What it costs:**
- No built-in transaction management
- No column name transforms
- No reactive query support
- Re-inventing what `@effect/sql-sqlite-do` already does

**How it looks:** (see organization-repository-research.md for full sketch)

### Option C: Hybrid — use `@effect/sql-sqlite-do` internally, expose domain methods

Build OrganizationRepository on top of `@effect/sql-sqlite-do` but don't expose the raw SQL client. Repository owns the SQL interface; agent methods just call repository methods.

```ts
// OrganizationRepository.ts
export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(
        function* () {
          return yield* sql`select * from Invoice order by createdAt desc`;
        },
      );

      // ... other methods

      return { getInvoices, /* ... */ };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### Recommendation

**Option B (thin service) is the pragmatic choice for now.** Reasoning:

1. **We don't need transactions** — our current SQL operations are all single-statement writes. Write coalescing handles multi-statement atomicity automatically since our sync Effects don't introduce `await`.

2. **We don't need column transforms** — our columns are already camelCase in the DO schema (matching JS conventions).

3. **We don't need reactive queries** — DO state is event-sourced via agent methods, not polled.

4. **Stability** — `@effect/sql-sqlite-do` lives in `effect/unstable/sql/`. Depending on it ties us to an unstable API surface.

5. **Consistency** — Option B follows the exact same `CloudflareEnv → D1 → Repository` layering we already use. Less cognitive overhead.

**If we later need transactions, transforms, or reactive queries**, migrating from Option B → C is straightforward: swap `AgentSql` for `SqlClient.SqlClient` in the repository, change the layer wiring in the constructor. The repository's public API doesn't change.

---

## 8. Transaction Considerations for the Repository

Even with Option B, worth documenting how transactions would work if needed:

### Scenario: multi-statement atomic write

```ts
// These are all sync Effects — write coalescing makes them atomic automatically
yield* repo.upsertInvoice(input);
yield* repo.setExtracting(input.invoiceId, input.idempotencyKey);
// ↑ Both commit in one implicit transaction (no await between them)
```

### Scenario: read-then-write with rollback

If we needed read-modify-write atomicity with rollback:

```ts
// Using ctx.storage.transactionSync directly
const result = ctx.storage.transactionSync(() => {
  const row = sql`select * from Invoice where id = ${id}`[0];
  if (!row) throw new Error("not found");
  sql`update Invoice set status = 'extracting' where id = ${id}`;
  return row;
});
```

This could be exposed as a method on `AgentSql` or as a separate service:

```ts
type AgentSqlFn = {
  <T>(strings: TemplateStringsArray, ...values: unknown[]): T[];
  transactionSync: <T>(callback: () => T) => T;
};
```

### Scenario: Effect-managed transaction scope

If we adopt `@effect/sql-sqlite-do`, transactions use the `SqlClient` transaction pattern:

```ts
yield* sql.withTransaction(Effect.gen(function* () {
  const row = yield* sql`select * from Invoice where id = ${id}`;
  yield* sql`update Invoice set status = 'extracting' where id = ${id}`;
  return row;
}));
```

Under the hood this uses the semaphore pattern to ensure serialized access.

---

## 9. Summary Table

| Aspect | D1 (our current service) | DO SQLite (within DO) |
|---|---|---|
| Access | `d1.prepare(query).bind(...)` | `sql.exec(query, ...bindings)` or `this.sql\`...\`` |
| Sync/Async | Async (Promises) | **Synchronous** |
| Effect wrapping | `Effect.tryPromise` | `Effect.try` |
| Transactions | `d1.batch()` for implicit tx | Write coalescing (automatic) or `transactionSync()` |
| Retry strategy | Inside service (retryable error signals) | At caller/stub level (errors within DO are deterministic) |
| Effect v4 package | `@effect/sql-d1` (no tx support) | `@effect/sql-sqlite-do` (semaphore-based tx) |
| Our wrapper | `D1` ServiceMap.Service | Proposed: `AgentSql` value service |
| Error class | `D1Error` | `OrganizationAgentError` (or let defects propagate) |

---

## 10. Open Questions

1. **Should `AgentSql` also expose `transactionSync`?** — Not needed today but low cost to include. Keeps the door open without adding complexity.

2. **Error wrapping strategy** — Current code wraps every SQL call in `Effect.try`. Since DO SQL errors are deterministic (no transient errors), this is purely for tagged error types. Alternative: let `Effect.fn` catch and surface as defects with stack traces. Tradeoff: tagged errors are pattern-matchable but add boilerplate; defects are simpler but less structured.

3. **Migration ownership** — `create table if not exists` currently in constructor. If repository "owns" the schema, an `initialize` effect in the repo could make this more cohesive. But constructor is the natural place for DO lifecycle.

4. **Should we adopt `@effect/sql-sqlite-do` for future DOs?** — If we add more DO types with complex query needs (joins, transforms, reactive queries), the full SQL client becomes worth the dependency cost. For single-table CRUD, Option B suffices.
