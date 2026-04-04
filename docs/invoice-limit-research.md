# Invoice Limit Research

## Goal

Limit total invoice count per organization (all statuses) so operations that would exceed the limit fail with an error the UI can display.

## Operations That Create Invoices

| Method | Agent method | How it creates |
|---|---|---|
| `uploadInvoice` | `@callable` | R2 put → `insertUploadingInvoice` (INSERT … ON CONFLICT DO NOTHING) |
| `onInvoiceUpload` | event handler | `upsertInvoice` (INSERT … ON CONFLICT DO UPDATE) |
| `createInvoice` | `@callable` | `createInvoice` (INSERT with status "ready") |

`onInvoiceUpload` upserts an existing row (created by `uploadInvoice` or the R2 event), so it generally doesn't increase count. It exists for fault tolerance — ensuring the DB record and workflow get created even if `uploadInvoice`'s insert hasn't landed yet. No limit check here: once the R2 object exists, we want the record and workflow to proceed unconditionally. Occasional over-limit from race conditions is acceptable and rare in practice.

## Proposed Approach

### 1. New repo method: `countInvoices`

```ts
const countInvoices = Effect.fn("OrganizationRepository.countInvoices")(
  function* () {
    const rows = yield* sql`select count(*) as count from Invoice`;
    return (rows[0] as { count: number }).count;
  },
);
```

Add to `OrganizationRepository` service interface.

### 2. New domain error

In `OrganizationDomain.ts`, following existing `OrganizationAgentError` pattern:

```ts
export class InvoiceLimitExceededError extends Schema.TaggedErrorClass<InvoiceLimitExceededError>()(
  "InvoiceLimitExceededError",
  { limit: Schema.Number },
) {}
```

This is a separate tagged error class (not reusing `OrganizationAgentError`) so the UI can match on `_tag` for specific messaging. Follows Effect v4 `Schema.TaggedErrorClass` pattern from `refs/effect4/ai-docs/src/01_effect/03_errors/01_error-handling.ts`.

### 3. Guard in agent methods

Idiomatic Effect v4 precondition guard pattern — `return yield*` short-circuits the generator:

```ts
// organization-agent.ts — inside uploadInvoice's Effect.gen
const repo = yield* OrganizationRepository;
const count = yield* repo.countInvoices();
if (count >= INVOICE_LIMIT)
  return yield* new InvoiceLimitExceededError({ limit: INVOICE_LIMIT });
```

Same guard in `createInvoice`. For `onInvoiceUpload`, the guard goes before `upsertInvoice`.

Pattern sourced from `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Users.ts` — `return yield* new UsersError(...)`.

### 4. Limit constant

Environment variable via Effect `Config`, read from Cloudflare env bindings (already wired through `ConfigProvider.fromUnknown(env)` in `makeRunEffect`):

```ts
const invoiceLimit = yield* Config.number("INVOICE_LIMIT").pipe(
  Config.withDefault(10),
);
```

`wrangler.jsonc` changes — add `INVOICE_LIMIT` to both environments:

```jsonc
// top-level vars (local)
"INVOICE_LIMIT": "3"

// env.production.vars
"INVOICE_LIMIT": "10"
```

Note: Cloudflare vars are strings; `Config.number` handles the parse.

Local limit of 3 keeps testing practical. Production limit of 10 (demo app). Default of 10 is a safety net if the var is missing.

### 5. Race condition: count-then-insert

SQLite in Durable Objects is single-threaded per isolate and `runEffect` calls are serialized within a single DO instance. The count-then-insert is safe because:

- DO's JS execution is single-threaded (no concurrent `runEffect` calls interleave)
- `onInvoiceUpload` and `uploadInvoice` both run inside the same DO instance
- SQLite ops in DO don't yield the event loop (noted in existing constructor comment)

No need for `INSERT … WHERE (SELECT count(*) …) < limit` — the application-level guard is sufficient.

### 6. UI error handling

Current UI uses `useMutation` from TanStack Query. Errors from `stub.uploadInvoice()` / `stub.createInvoice()` propagate as rejected promises. The existing pattern in `app.$organizationId.invoices.index.tsx`:

```tsx
{uploadMutation.error && (
  <p>{uploadMutation.error.message}</p>
)}
```

`OrganizationAgentError` and `InvoiceLimitExceededError` both have a `message` field. When an Effect fails with a tagged error inside a `@callable` method, the Cloudflare Agents RPC layer serializes it as an error with the message. The existing `uploadMutation.error.message` display picks it up automatically.

For `createInvoiceMutation`, add an `onError` or inline error display (currently missing error UI for create).

For a better UX, could check `_tag === "InvoiceLimitExceededError"` on the error object if the RPC layer preserves it, or just match on the message string.

## Error type: `InvoiceLimitExceededError`

Separate `Schema.TaggedErrorClass` so the UI can branch on `_tag` and show distinct messaging (e.g., limit reached banner, disable create/upload buttons). Carries a structured `limit` field.

## Affected Methods Summary

| Method | Guard needed | Notes |
|---|---|---|
| `uploadInvoice` | Yes | Before R2 put (fail fast, don't waste R2 write) |
| `createInvoice` | Yes | Before INSERT |
| `onInvoiceUpload` | No | Fault tolerance handler — once R2 object exists, must ensure DB record + workflow proceed |
| `deleteInvoice` | No | Decreases count |
| `updateInvoice` | No | Updates existing row |
| `saveInvoiceExtraction` | No | Updates existing row |
| `onWorkflowError` | No | Updates existing row |

### `onInvoiceUpload` — no limit check

This is the R2 notification handler. Its job is fault tolerance: if `uploadInvoice`'s insert hasn't landed, `onInvoiceUpload` upserts the row and kicks off the workflow. Once the R2 object exists we don't want to block on limits — that would leave an orphaned R2 object with no cleanup path. The limit is enforced upstream in `uploadInvoice` before the R2 put.
