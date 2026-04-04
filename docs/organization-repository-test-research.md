# OrganizationRepository Integration Test Research

## Goal

Write `test/integration/organization-repository.test.ts` for `OrganizationRepository` methods, following the pattern established in `repository.test.ts`.

---

## Key Difference: DO SQLite vs D1

`Repository` (tested in `repository.test.ts`) uses D1 — a shared database bound to the Worker via `env.D1`.

`OrganizationRepository` uses **Durable Object SQLite** — per-instance SQLite storage accessed through `ctx.storage.sql` on `DurableObjectState`. Each `OrganizationAgent` DO instance gets its own isolated SQLite database.

| | Repository | OrganizationRepository |
|---|---|---|
| Storage | D1 (shared) | DO SQLite (per-instance) |
| SQL client | `D1` service from `@/lib/D1` | `SqlClient` from `@effect/sql-sqlite-do` |
| Schema origin | `migrations/` dir (applied by `applyD1Migrations`) | DO constructor (`this.sql\`create table if not exists ...\``) |
| Layer chain | `Repository.layer ← D1.layer ← CloudflareEnv` | `OrganizationRepository.layer ← SqliteClient.layer({db: ctx.storage.sql})` |

---

## How OrganizationRepository Gets Its SqlClient

In `src/organization-agent.ts:36-51`, `makeRunEffect` builds the layer:

```ts
const sqliteLayer = SqliteClient.layer({ db: ctx.storage.sql });
const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
```

`SqliteClient.layer` (from `@effect/sql-sqlite-do`) takes a `SqliteClientConfig` with a `db: SqlStorage` field. It provides both `SqliteClient` and `SqlClient.SqlClient` to downstream layers.

`OrganizationRepository.make` yields `SqlClient.SqlClient` — the generic Effect SQL client — so it's wired through `SqliteClient.layer`.

---

## Testing Inside a Durable Object

### The Problem

DO SQLite is only accessible inside the DO's execution context. You can't access `ctx.storage.sql` from the test runner's top-level scope. The test code runs in the Worker isolate, but DO storage belongs to a specific DO instance.

### runInDurableObject

`@cloudflare/vitest-pool-workers` provides `runInDurableObject` from `cloudflare:test`:

```ts
import { env, runInDurableObject } from "cloudflare:test";

const id = env.ORGANIZATION_AGENT.idFromName("test");
const stub = env.ORGANIZATION_AGENT.get(id);

await runInDurableObject(stub, async (instance: OrganizationAgent, state: DurableObjectState) => {
  // Runs inside the DO's execution context
  // instance = the actual OrganizationAgent class instance
  // state = DurableObjectState with state.storage.sql
});
```

**How it works** (from `refs/workers-sdk/packages/vitest-pool-workers/src/worker/durable-objects.ts`):

1. Stores the callback in a Map keyed by action ID
2. Sends a special fetch request to the stub with `cf: { vitestPoolWorkersDurableObjectAction: id }`
3. `maybeHandleRunRequest` intercepts the fetch inside the DO, executes the callback with `(instance, state)`
4. Returns the result through the Map

**Constraint**: Only works with DOs defined in the `main` worker (same isolate). `OrganizationAgent` is defined in `wrangler.jsonc` as a binding on the main worker, so this works.

### Reference Example

`refs/workers-sdk/fixtures/vitest-pool-workers-examples/durable-objects/test/direct-access.test.ts`:

```ts
await runInDurableObject(stub, async (instance: Counter, state) => {
  expect(instance.count).toBe(2);
  expect(await state.storage.get<number>("count")).toBe(2);
});
```

---

## Two Approaches

### Approach A: Build Effect Layer Inside runInDurableObject

Run Effect code inside the DO callback using `state.storage.sql` to build the `SqliteClient` layer.

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { layer } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { OrganizationRepository } from "@/lib/OrganizationRepository";

it("countInvoices", async () => {
  const id = env.ORGANIZATION_AGENT.idFromName("test-count");
  const stub = env.ORGANIZATION_AGENT.get(id);

  await runInDurableObject(stub, async (_instance, state) => {
    const sqliteLayer = SqliteClient.layer({ db: state.storage.sql });
    const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);

    await Effect.runPromise(Effect.provide(
      Effect.gen(function* () {
        const repo = yield* OrganizationRepository;
        const count = yield* repo.countInvoices();
        expect(count).toBe(0);
      }),
      repoLayer,
    ));
  });
});
```

**Pros:**
- Tests OrganizationRepository against real DO SQLite
- Each DO instance auto-creates tables in constructor, so schema is ready
- Mirrors the production layer chain exactly

**Cons:**
- Can't use `@effect/vitest` `it.effect` or `layer()` — those run at the test suite level, outside the DO context
- Must use `Effect.runPromise` manually inside the callback
- Layer is rebuilt per test (but these are fast — in-memory SQLite)

### Approach B: Use Instance Methods Directly

Call `OrganizationAgent` methods that internally use `this.runEffect`:

```ts
await runInDurableObject(stub, async (instance: OrganizationAgent) => {
  const result = await instance.createInvoice();
  // result = { invoiceId: "..." }
});
```

**Pros:**
- Tests the full stack including the Agent class
- Schema already created by constructor

**Cons:**
- Tests the Agent methods, not the Repository in isolation
- Some methods need `getCurrentAgent()` context (e.g., `uploadInvoice` calls `getConnectionIdentity`)
- Some methods call external services (R2, Workflows, Queues)
- This is more of an OrganizationAgent integration test, not a Repository unit test

### Recommendation: Approach A

Approach A matches the pattern in `repository.test.ts` — test the Repository layer in isolation. The DO is just the execution context that gives us `state.storage.sql`.

---

## Schema Initialization

The `OrganizationAgent` constructor (`src/organization-agent.ts:102-139`) creates tables:

```ts
void this.sql`create table if not exists Invoice (...)`;
void this.sql`create table if not exists InvoiceItem (...)`;
```

When `runInDurableObject` is called, the DO instance has already been constructed (Miniflare creates it on first `.get()`), so the tables exist. No separate migration step needed.

**Verification**: The `_instance` parameter in the callback is the constructed `OrganizationAgent`. By the time the callback runs, the constructor has already executed `this.sql\`create table...\``.

---

## Test Structure

### Layer Setup

Can't use `@effect/vitest` `layer()` because the Effect layer must be built inside `runInDurableObject`. Instead, use a helper:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { SqliteClient } from "@effect/sql-sqlite-do";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationRepository } from "@/lib/OrganizationRepository";
import type { OrganizationAgent } from "@/organization-agent";

const runInOrg = <A>(
  name: string,
  effect: Effect.Effect<A, unknown, OrganizationRepository>,
) => {
  const id = env.ORGANIZATION_AGENT.idFromName(name);
  const stub = env.ORGANIZATION_AGENT.get(id);
  return runInDurableObject(stub, async (_instance: OrganizationAgent, state) => {
    const sqliteLayer = SqliteClient.layer({ db: state.storage.sql });
    const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
    return Effect.runPromise(Effect.provide(effect, repoLayer));
  });
};
```

### Isolation Strategy

Each test should use a unique DO instance name (e.g., `test-${crypto.randomUUID()}`) so tests get isolated SQLite databases. This is free — each DO name creates a fresh instance with empty tables.

```ts
it("countInvoices — empty", async () => {
  await runInOrg(`count-empty-${crypto.randomUUID()}`, Effect.gen(function* () {
    const repo = yield* OrganizationRepository;
    const count = yield* repo.countInvoices();
    expect(count).toBe(0);
  }));
});
```

### Seed Helpers

Same pattern as `repository.test.ts` — `Effect.fn` helpers that insert test data via `SqlClient`:

```ts
const seedInvoice = Effect.fn("seed.invoice")(function* (overrides?: {
  id?: string;
  name?: string;
  status?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const id = overrides?.id ?? crypto.randomUUID();
  yield* sql`
    insert into Invoice (id, name, status)
    values (${id}, ${overrides?.name ?? "Test Invoice"}, ${overrides?.status ?? "ready"})
  `;
  return { id };
});
```

---

## Methods to Test

From `src/lib/OrganizationRepository.ts`:

| Method | Returns | Test cases |
|---|---|---|
| `countInvoices` | `number` | Empty, after inserts |
| `findInvoice(id)` | `Option<Invoice>` | Found, not found |
| `getInvoices` | `Invoice[]` | Empty, multiple, ordering (desc by createdAt) |
| `getInvoice(id)` | `Option<InvoiceWithItems>` | Found with items, found without items, not found |
| `upsertInvoice(input)` | `void` | Insert new, update existing (conflict on id) |
| `insertUploadingInvoice(input)` | `void` | Insert new, conflict does nothing |
| `createInvoice(id)` | `void` | Creates with defaults |
| `updateInvoice(input)` | `Option<InvoiceWithItems>` | Update ready invoice, update error invoice, reject non-ready/error |
| `deleteInvoiceRecord(id)` | `rows` | Deletes ready, deletes error, skips uploading/extracting |
| `saveInvoiceExtraction(input)` | `rows` | Saves fields + items, idempotency key mismatch returns empty |
| `setError(workflowId, error)` | `rows` | Sets error status, returns updated row |

### getInvoice Detail

`getInvoice` uses a `json_object` + `json_group_array` query that joins Invoice with InvoiceItem. This is the most complex query to test — need to seed both Invoice and InvoiceItem rows and verify the decoded `InvoiceWithItems` schema.

### updateInvoice Detail

`updateInvoice` takes `UpdateInvoiceInput.Type` which includes `invoiceItems`. It:
1. Updates the Invoice row (only if status is 'ready' or 'error')
2. Deletes existing InvoiceItems
3. Inserts new InvoiceItems
4. Returns the result of `getInvoice`

This is transactional within the DO SQLite context (single-threaded).

---

## Potential Issues

### 1. `@effect/vitest` Integration

`layer()` and `it.effect` from `@effect/vitest` won't work here because the Effect runtime must be constructed inside the `runInDurableObject` callback. Use plain vitest `it()` with async callbacks that call `runInOrg`.

### 2. Agent Base Class vs DurableObject

`OrganizationAgent` extends `Agent` (from "agents" package), not `DurableObject` directly. The `runInDurableObject` type expects `DurableObject | Rpc.DurableObject`. `Agent` extends `DurableObject` under the hood, so this should work. If there's a type mismatch, cast the instance.

### 3. `this.sql` vs `state.storage.sql`

The constructor uses `this.sql` (provided by `Agent` base class), which is a convenience wrapper around `ctx.storage.sql`. In the test callback, we get `state: DurableObjectState` and use `state.storage.sql` to build the `SqliteClient` layer. These access the same underlying SQLite database.

### 4. Schema Types

`OrganizationRepository` methods use Effect Schema decoding internally (`decodeInvoice`, `decodeInvoices`). The test seed helpers must insert data that matches the schema expectations, or the decode will fail. Pay attention to:
- `createdAt` is `integer` (unix epoch ms) with a default
- `invoiceConfidence` is `real` defaulting to 0
- Various `not null default ''` text fields

### 5. SqlClient Import

`OrganizationRepository.make` does `yield* SqlClient.SqlClient` (the generic Effect SQL client tag). `SqliteClient.layer` provides both `SqliteClient` and `SqlClient.SqlClient`, so the repository's dependency is satisfied.

---

## File Plan

| File | Action |
|---|---|
| `test/integration/organization-repository.test.ts` | New — tests all OrganizationRepository methods |

No changes to existing files needed. The test config already picks up `test/integration/*.test.ts`.
