# D1 Read Replicas + Better Auth: Research & Questions

## Findings

### 1. Raw `D1Database` (no session) always goes to primary

From `refs/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`:

> "To use read replication, you must use the D1 Sessions API, otherwise all queries will continue to be executed only by the primary database."

**Without `withSession()`, read replication is not used at all.** Every query (read or write) hits primary. This is the current behavior for both better-auth and the Effect D1 service.

### 2. `D1DatabaseSession` cannot be passed to better-auth (the `exec` problem)

**The interfaces** (`worker-configuration.d.ts:9807-9832`):

```ts
declare abstract class D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;        // <-- session lacks this
    withSession(constraintOrBookmark?: ...): D1DatabaseSession;
    dump(): Promise<ArrayBuffer>;                       // deprecated
}

declare abstract class D1DatabaseSession {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    getBookmark(): D1SessionBookmark | null;            // <-- database lacks this
}
```

**Better-auth's D1 detection** (`refs/better-auth/packages/kysely-adapter/src/dialect.ts:48-54`):

```ts
// Detection (getKyselyDatabaseType)
if ("batch" in db && "exec" in db && "prepare" in db) {
  return "sqlite";
}
```

**Better-auth's D1 adapter creation** (`refs/better-auth/packages/kysely-adapter/src/dialect.ts:148-153`):

```ts
// Adapter creation (createKyselyAdapter)
if ("batch" in db && "exec" in db && "prepare" in db) {
  const { D1SqliteDialect } = await import("./d1-sqlite-dialect");
  dialect = new D1SqliteDialect({
    database: db,
  });
}
```

`D1DatabaseSession` lacks `exec` → fails the `"exec" in db` check → better-auth won't recognize it as D1. **This is a hard blocker.**

**What better-auth actually calls at runtime** (`refs/better-auth/packages/kysely-adapter/src/d1-sqlite-dialect.ts:93-97`):

```ts
class D1SqliteConnection implements DatabaseConnection {
  readonly #db: D1Database;
  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const results = await this.#db
      .prepare(compiledQuery.sql)
      .bind(...compiledQuery.parameters)
      .all();
    // ...
  }
}
```

Only `prepare().bind().all()` at runtime. `exec` is never called after detection. But detection is the gate.

### 3. Effect D1 service is compatible with sessions

`D1.ts` only uses `prepare()` and `batch()` - both present on `D1DatabaseSession`. Switching the Effect D1 service to accept either `D1Database | D1DatabaseSession` is straightforward.

---

## Current State

### `createD1SessionService` is a no-op

- Created every request (`worker.ts:173-179`)
- `setSessionBookmarkCookie()` called on response (`worker.ts:187`) - but only writes cookie if `getSession()` was called
- `getSession()` is never called anywhere
- Net: dead code. Cookie never written. No session ever created.

### Better Auth: raw `D1Database`, always primary

`Auth.ts:36` extracts `D1` from `CloudflareEnv`, passes to `betterAuth()` at line 100. All queries go to primary.

### Effect D1 service: raw `D1Database`, always primary

`D1.ts:6` gets `D1` from `CloudflareEnv`, wraps in Effect. All queries go to primary.

---

## Options

### Option A: Better-auth on primary, Effect D1 on session (recommended)

- Better-auth keeps raw `D1Database` → always primary. Auth operations are writes + critical reads, primary is correct.
- Effect D1 service takes a `D1DatabaseSession` → can use replicas for reads.
- Session created in `worker.ts`, threaded to Effect D1 via layer.
- Bookmark cookie plumbing handles cross-request consistency.

**Pros**: No hacks. Better-auth untouched. Repository reads get replica benefits.
**Cons**: Two D1 paths per request. Auth writes and Effect writes go through different handles (but both ultimately hit primary for writes).

### Option B: Everything on primary (status quo, explicit)

- Delete `createD1SessionService` since it's dead code.
- Accept all queries hit primary.
- Revisit when read volume justifies the complexity.

### Option C: Shim `exec` onto session for better-auth

Not recommended. `exec` is only for detection but it's fragile - better-auth could start using `exec` at runtime in a future version. Also semantically wrong since the shimmed `exec` wouldn't participate in session consistency.

---

## Questions

**Q1**: Is Option A worth implementing now, or should we go with Option B and revisit later? The benefit is proportional to read volume on the Repository layer.

**Q2**: For Option A, should the session constraint be route-aware? e.g.:

- API auth routes (`/api/auth/*`): no session needed (better-auth uses raw D1)
- Other routes: `first-unconstrained` with bookmark from cookie
- Or just use `first-unconstrained` globally for the Effect D1 session?

**Q3**: What about better-auth's `databaseHooks` and `hooks.before`? These call `runEffect` which uses the Effect service layer (Repository, Stripe, KV). If Effect D1 is on a session but better-auth is on raw D1, the auth hook code that goes through Repository would use the session handle while better-auth's own queries use raw D1. Is that a problem? Both ultimately write to primary, so consistency should be fine - but it's two different "views" of the database within one auth operation.

**Q4**: Should we clean up `createD1SessionService` regardless of which option we pick? It's dead code now.

---

## Reference: D1 Read Replication Details

- Replicas created asynchronously across regions (ENAM, WNAM, WEUR, EEUR, APAC, OC)
- No extra cost for replicas
- Writes always go to primary regardless of session constraint
- `first-primary`: first read hits primary (freshest), subsequent reads may use replica
- `first-unconstrained`: first read hits nearest (may be stale replica), default
- Bookmark: resumes session from previous request's state
- Sessions provide sequential consistency: monotonic reads, monotonic writes, read-your-own-writes
- `D1Result.meta.served_by_region` and `meta.served_by_primary` for observability
- Sessions API works locally but `served_by_*` fields are `undefined` in dev
- Source: `refs/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`
