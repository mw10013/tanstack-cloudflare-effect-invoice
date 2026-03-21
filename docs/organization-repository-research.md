# Organization Repository Research

## Context

OrganizationAgent currently has inline SQL + schema decoding spread across its methods. Goal: extract a repository service following the existing service pattern in the codebase. Related question: do we need an OrganizationDomain.ts for the agent's domain objects?

## Current State

### Where SQL lives today (`organization-agent.ts`)

| Method | SQL Operation |
|---|---|
| `constructor` | `create table if not exists Invoice` |
| `onInvoiceUpload` | `select * from Invoice where id = ?` → `insert ... on conflict(id) do update` → `update Invoice set status = 'extracting'` |
| `onInvoiceDelete` | `delete from Invoice where id = ? and r2ActionTime <= ?` |
| `saveExtractedJson` | `update Invoice set status = 'extracted', extractedJson = ?` |
| `onWorkflowError` | `update Invoice set status = 'error', error = ?` |
| `getInvoices` | `select * from Invoice order by createdAt desc` |

### Where schemas live today (`organization-agent.ts`)

- `InvoiceRowSchema` — full row schema (lines 14-25)
- `InvoiceStatus` — imported from `Domain.ts` (shared enum)
- `decodeInvoiceRow` / `decodeInvoices` — sync decoders (lines 29-32)
- `OrganizationAgentError` — tagged error class (lines 34-37)
- `activeWorkflowStatuses` — set of workflow status strings (line 27)

### Existing service layering in the codebase

```
CloudflareEnv  (value service — just wraps Env)
    ↓
    D1          (ServiceMap.Service — yields CloudflareEnv, wraps d1 with retry/error handling)
    ↓
    Repository  (ServiceMap.Service — yields D1, exposes domain query methods)
```

`CloudflareEnv` is defined as a bare value service — one line:

```ts
export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");
```

`D1` depends on it: `const { D1: d1 } = yield* CloudflareEnv;`

`Repository` depends on `D1`: `const d1 = yield* D1;`

### Key difference: D1 vs DO SQLite

Repository.ts uses **D1** (async, prepared statements, `d1.first()` / `d1.run()`).

OrganizationAgent uses the **DO's `this.sql` tagged template** — synchronous, returns `T[]` directly. The type from the agents SDK:

```ts
sql<T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
): T[]
```

This comes from the Agent base class. The underlying Cloudflare type is `DurableObjectStorage.sql: SqlStorage` which has `exec(query, ...bindings)`. The Agent wraps it as a tagged template convenience.

## Approach: Follow the CloudflareEnv → D1 → Repository pattern exactly

### 1. Value service for the DO sql tagged template

Same pattern as `CloudflareEnv` — a value service that wraps a runtime value.

```ts
// src/lib/AgentSql.ts
import { ServiceMap } from "effect";

type AgentSqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export const AgentSql = ServiceMap.Service<AgentSqlFn>("AgentSql");
```

Like `CloudflareEnv`, this is just a typed slot. The agent provides the value at construction time via `Layer.succeed(AgentSql, this.sql)`.

If we later add more DO types, they all provide `AgentSql` the same way — it's the DO equivalent of `CloudflareEnv`.

### 2. OrganizationRepository as a ServiceMap.Service

Follows the exact same shape as `Repository`:

```ts
// src/lib/OrganizationRepository.ts
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { AgentSql } from "./AgentSql";
import * as OrganizationDomain from "./OrganizationDomain";

export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* AgentSql;

      const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
        function* (invoiceId: string) {
          return OrganizationDomain.decodeInvoiceRow(
            sql`select * from Invoice where id = ${invoiceId}`[0] ?? null,
          );
        },
      );

      const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(
        function* () {
          return OrganizationDomain.decodeInvoices(
            sql`select * from Invoice order by createdAt desc`,
          );
        },
      );

      const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
        function* (input: {
          invoiceId: string;
          fileName: string;
          contentType: string;
          r2ActionTime: number;
          idempotencyKey: string;
          r2ObjectKey: string;
        }) {
          void sql`
            insert into Invoice (
              id, fileName, contentType, createdAt, r2ActionTime,
              idempotencyKey, r2ObjectKey, status,
              extractedJson, error
            ) values (
              ${input.invoiceId}, ${input.fileName}, ${input.contentType},
              ${input.r2ActionTime}, ${input.r2ActionTime}, ${input.idempotencyKey},
              ${input.r2ObjectKey}, 'uploaded',
              ${null}, ${null}
            )
            on conflict(id) do update set
              fileName = excluded.fileName,
              contentType = excluded.contentType,
              r2ActionTime = excluded.r2ActionTime,
              idempotencyKey = excluded.idempotencyKey,
              r2ObjectKey = excluded.r2ObjectKey,
              status = 'uploaded',
              extractedJson = null,
              error = null
          `;
        },
      );

      const setExtracting = Effect.fn("OrganizationRepository.setExtracting")(
        function* (invoiceId: string, idempotencyKey: string) {
          void sql`
            update Invoice
            set status = 'extracting'
            where id = ${invoiceId} and idempotencyKey = ${idempotencyKey}
          `;
        },
      );

      const deleteInvoice = Effect.fn("OrganizationRepository.deleteInvoice")(
        function* (invoiceId: string, r2ActionTime: number) {
          return sql<{ id: string }>`
            delete from Invoice
            where id = ${invoiceId} and r2ActionTime <= ${r2ActionTime}
            returning id
          `;
        },
      );

      const saveExtractedJson = Effect.fn("OrganizationRepository.saveExtractedJson")(
        function* (input: { invoiceId: string; idempotencyKey: string; extractedJson: string }) {
          return sql<{ id: string; fileName: string }>`
            update Invoice
            set status = 'extracted',
                extractedJson = ${input.extractedJson},
                error = ${null}
            where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
            returning id, fileName
          `;
        },
      );

      const setError = Effect.fn("OrganizationRepository.setError")(
        function* (workflowId: string, error: string) {
          return sql<{ id: string; fileName: string }>`
            update Invoice
            set status = 'error',
                error = ${error}
            where idempotencyKey = ${workflowId}
            returning id, fileName
          `;
        },
      );

      return {
        findInvoice,
        getInvoices,
        upsertInvoice,
        setExtracting,
        deleteInvoice,
        saveExtractedJson,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### 3. How the agent wires it up

```ts
// organization-agent.ts constructor
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  void this.sql`create table if not exists Invoice (...)`;
  const agentSqlLayer = Layer.succeed(AgentSql, this.sql);
  const repoLayer = Layer.provideMerge(OrganizationRepository.layer, agentSqlLayer);
  const loggerLayer = makeLoggerLayer(env);
  this.runEffect = (effect) =>
    Effect.runPromise(Effect.provide(effect, Layer.merge(repoLayer, loggerLayer)));
}
```

Mirrors the worker.ts pattern:

```ts
// worker.ts (existing)
const envLayer = makeEnvLayer(env);
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
```

### 4. How agent methods look after

```ts
@callable()
getInvoices() {
  return this.runEffect(
    Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      return yield* repo.getInvoices();
    }),
  );
}

@callable()
onInvoiceUpload(upload: { ... }) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const r2ActionTime = Date.parse(upload.r2ActionTime);
      if (!Number.isFinite(r2ActionTime))
        return yield* new OrganizationAgentError({ message: `Invalid r2ActionTime: ${upload.r2ActionTime}` });

      const repo = yield* OrganizationRepository;
      const existing = yield* repo.findInvoice(upload.invoiceId);
      if (existing && r2ActionTime < existing.r2ActionTime) return;

      const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
      if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) return;
      if (existing?.idempotencyKey === upload.idempotencyKey
        && (existing.status === "extracting" || existing.status === "extracted")) return;

      yield* repo.upsertInvoice({ ...upload, r2ActionTime });
      yield* broadcastActivity(this, { level: "info", text: `Invoice uploaded: ${upload.fileName}` });
      yield* Effect.tryPromise({
        try: () => this.runWorkflow("INVOICE_EXTRACTION_WORKFLOW", { ... }, { id: upload.idempotencyKey, ... }),
        catch: (cause) => new OrganizationAgentError({ message: ... }),
      });
      yield* repo.setExtracting(upload.invoiceId, upload.idempotencyKey);
    }),
  );
}
```

### Error handling note

The current code wraps every SQL call in `Effect.try`. Since DO SQLite ops are synchronous and the `Effect.fn` generator itself will catch thrown exceptions, we have a choice:

- **Wrap in Effect.try** per call (current pattern) — granular error messages per operation
- **Let Effect.fn catch** — simpler code, errors surface as defects with stack traces

The sketch above omits `Effect.try` for readability. Whether to add it back is a style decision — the current agent wraps everything, so we could preserve that. But `Effect.fn` already catches and traces, so it may be unnecessary ceremony.

---

## OrganizationDomain.ts — Do We Need It?

### What would go in it?

| Schema | Currently in | Notes |
|---|---|---|
| `InvoiceRowSchema` | `organization-agent.ts` | Full row shape |
| `InvoiceRow` type | `organization-agent.ts` | Derived from schema |
| `InvoiceStatus` | `Domain.ts` | Already shared — used by both agent and UI |
| `OrganizationAgentError` | `organization-agent.ts` | Tagged error |
| `activeWorkflowStatuses` | `organization-agent.ts` | Runtime set |
| `decodeInvoiceRow` / `decodeInvoices` | `organization-agent.ts` | Sync decoders |
| `WorkflowProgressSchema` | `Activity.ts` | Stays there — used across concerns |

### Analysis

`InvoiceStatus` is already in `Domain.ts` because it's shared (UI renders it, agent writes it). The remaining schemas (`InvoiceRowSchema`, decoders, error class) are currently only used by OrganizationAgent.

**With OrganizationRepository**, these schemas become shared between the agent and the repository — that's the natural trigger for extracting them.

### Options

1. **Add to existing `Domain.ts`** — keeps one file for all domain schemas. Risk: Domain.ts grows and mixes primary DB schemas with DO-specific schemas.

2. **Create `OrganizationDomain.ts`** — clean separation. Contains `InvoiceRowSchema`, `InvoiceRow` type, decoders, `OrganizationAgentError`, `activeWorkflowStatuses`. `InvoiceStatus` stays in `Domain.ts` (already there, already shared).

3. **Co-locate in `OrganizationRepository.ts`** — schemas live next to the code that uses them. But then the agent also needs to import schemas from the repository module (e.g., `activeWorkflowStatuses`, `OrganizationAgentError`), which is a bit inverted.

### Recommendation

**Option 2** (`OrganizationDomain.ts`) — the two files form a natural pair. Keeps `Domain.ts` focused on the primary D1-backed domain.

---

## Proposed File Structure

```
src/lib/
  AgentSql.ts                  # Value service for DO sql tagged template (like CloudflareEnv)
  OrganizationDomain.ts        # InvoiceRow schema, decoders, error class
  OrganizationRepository.ts    # ServiceMap.Service, depends on AgentSql
  Domain.ts                    # Unchanged
  Repository.ts                # Unchanged
```

```
src/
  organization-agent.ts        # Slimmed down — orchestrates repo + broadcast + workflow
```

### Full layering picture

```
CloudflareEnv    AgentSql
    ↓                ↓
    D1          OrganizationRepository
    ↓
Repository
```

---

## Open Questions

1. **Table creation** — should the `create table if not exists` DDL move into the repository (e.g., an `initialize` effect), or stay in the agent constructor? Constructor is the natural place since it runs once per DO instantiation. But if the repository "owns" the schema, it's arguably more cohesive there.

2. **`broadcastActivity`** — uses `agent.broadcast()` which is an Agent method, not data. It stays in the agent. Repository handles pure data operations. Agent orchestrates: calls repo, broadcasts, runs workflow, calls repo again.

3. **`this.sql` type** — the Agent base class provides `this.sql` as a tagged template convenience over `this.ctx.storage.sql: SqlStorage`. The `AgentSql` service type should match the tagged template signature, not the raw `SqlStorage` interface. We pass `this.sql` (bound to the agent) into `Layer.succeed`.

4. **Workflow operations** — `this.runWorkflow()` and `this.getWorkflow()` are agent methods. They stay in the agent. Repository is purely data access.

5. **Error wrapping** — current code wraps every SQL call in `Effect.try` with `OrganizationAgentError`. With the repository pattern, we could:
   - Keep `Effect.try` wrapping (preserves granular error context)
   - Drop it and let exceptions propagate as defects (simpler, `Effect.fn` traces)
   - Rename error to `OrganizationRepositoryError` since it now lives in the repo layer

6. **Naming** — `AgentSql` is generic enough for any DO. If we only ever have one DO type, `OrganizationSql` would be more specific. `AgentSql` is the better default since it mirrors `CloudflareEnv` as a shared infrastructure service.
