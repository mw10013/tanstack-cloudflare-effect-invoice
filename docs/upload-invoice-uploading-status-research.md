# Research: uploadInvoice Refactor — "uploading" Status

## Goal

Refactor `uploadInvoice` (L257, organization-agent.ts) to insert an invoice record with status `"uploading"` immediately after the R2 put succeeds but before the queue/workflow kicks off. This gives the UI something to display instantly.

## Current Flow

```
uploadInvoice (callable, client-initiated)
  1. validate input (schema, size, mime)
  2. generate invoiceId + idempotencyKey
  3. R2 put (with customMetadata: invoiceId, idempotencyKey, fileName, contentType)
  4. (local only) send queue message
  5. return { invoiceId }
     — no DB row exists yet —

onInvoiceUpload (queue consumer, async)
  1. idempotency guards (r2ActionTime, workflow status, existing status)
  2. repo.upsertInvoice({ status: "extracting", ... })
  3. broadcast "invoice.uploaded"
  4. runWorkflow("INVOICE_EXTRACTION_WORKFLOW", ...)
```

**Problem:** Between step 5 of `uploadInvoice` and step 2 of `onInvoiceUpload`, the UI has an `invoiceId` but no DB row, so `getInvoices`/`getInvoice` return nothing. The route invalidation after upload may beat the queue consumer.

## Proposed Flow

```
uploadInvoice (callable)
  1. validate input
  2. generate invoiceId + idempotencyKey
  3. R2 put
  4. INSERT invoice row with status "uploading"    <-- NEW
  5. (local only) send queue message
  6. return { invoiceId }

onInvoiceUpload (queue consumer, unchanged logic)
  1. idempotency guards
  2. repo.upsertInvoice({ status: "extracting", ... })  — overwrites "uploading"
  3. broadcast "invoice.uploaded"
  4. runWorkflow(...)
```

## Status Threading

### Add "uploading" to InvoiceStatusValues

**`src/lib/OrganizationDomain.ts`:**
```ts
export const InvoiceStatusValues = [
  "uploading",   // <-- new
  "extracting",
  "ready",
  "error",
] as const;
```

No schema migration needed — the `status` column is `text not null`, no enum constraint.

### Places that check status values

| Location | Current check | Impact |
|---|---|---|
| `deleteInvoiceRecord` (repo L147-154) | `status in ('ready', 'error')` | Safe — won't delete "uploading" rows |
| `deleteInvoice` callable (agent L309) | `status !== "ready" && status !== "error"` → early return | Safe — won't delete "uploading" |
| `onInvoiceUpload` guard (agent L188) | `status === "extracting" \|\| status === "ready"` → skip | **"uploading" does NOT match** → proceeds to upsert. Correct. |
| `saveInvoiceExtraction` (repo L187) | `where id = ? and idempotencyKey = ?` | Transitions any status to "ready" if idempotencyKey matches. Works fine with "uploading". |
| `setError` (repo L207-211) | `where idempotencyKey = ?` | Same — works regardless of current status. |
| `updateInvoice` (repo L226+) | Sets `status = 'ready'` unconditionally | Would promote "uploading" to "ready" if user edits. The UI should prevent editing "uploading" invoices (same as "extracting"). |
| UI canEdit (route L97) | `status === "ready" \|\| status === "error"` | Safe — "uploading" is not editable. |
| UI extracting message (route L165) | `status === "extracting"` | Needs update to also show a message for "uploading". Could show "Uploading..." or group with extracting. |

### onInvoiceUpload compatibility with pre-existing "uploading" row

Walking through the guards with an existing row at status `"uploading"`:

1. **r2ActionTime guard (L172-177):** The "uploading" row has `r2ActionTime = null` (we don't set it). Guard checks `existing.value.r2ActionTime !== null` — fails, so guard is skipped. Proceeds. ✓
2. **Workflow guard (L178-183):** Checks `getWorkflow(upload.idempotencyKey)`. The "uploading" row has the same idempotencyKey. But no workflow has been started yet, so `getWorkflow` returns null or a non-active status. Proceeds. ✓
3. **Status guard (L184-191):** Checks `idempotencyKey === upload.idempotencyKey && (status === "extracting" || status === "ready")`. Status is `"uploading"` — does NOT match "extracting" or "ready". Proceeds. ✓
4. **upsertInvoice:** Overwrites the row, sets `status = "extracting"`, fills in `r2ActionTime`, same `idempotencyKey`. ✓
5. **Workflow start:** Normal. ✓

**Conclusion:** `onInvoiceUpload` handles a pre-existing "uploading" row correctly with zero changes.

## Insert vs Upsert — Fault Tolerance Analysis

### Scenario: uploadInvoice runs twice for same invoiceId (crash retry, etc.)

This **cannot happen** — `invoiceId` is generated fresh via `crypto.randomUUID()` inside `uploadInvoice`. Each call gets a unique ID. No retry mechanism re-invokes with the same ID.

### Scenario: onInvoiceUpload runs before/concurrently with the insert

Durable Object methods are single-threaded (no concurrent JS execution). `uploadInvoice` and `onInvoiceUpload` both run on the same DO instance, so they're serialized. However, `uploadInvoice` yields to the event loop during `r2.put` and `queue.send`, during which `onInvoiceUpload` could execute.

**Sequence concern:**
```
uploadInvoice: R2 put succeeds, yields
onInvoiceUpload: fires, invoice doesn't exist yet → creates with "extracting"
uploadInvoice: resumes, inserts with "uploading" → OVERWRITES "extracting" ← BAD
```

**This argues for INSERT with ON CONFLICT DO NOTHING rather than upsert.**

With `INSERT ... ON CONFLICT(id) DO NOTHING`:
- If `onInvoiceUpload` already created the row → insert is a no-op. The row stays at "extracting". ✓
- If `onInvoiceUpload` hasn't run yet → insert succeeds with "uploading". ✓
- Normal case: insert succeeds, then `onInvoiceUpload` upserts to "extracting". ✓

### Recommendation: INSERT ON CONFLICT DO NOTHING

A new repo method, e.g. `insertUploadingInvoice`:

```ts
const insertUploadingInvoice = Effect.fn("OrganizationRepository.insertUploadingInvoice")(
  function* (input: {
    invoiceId: string;
    name: string;
    fileName: string;
    contentType: string;
    idempotencyKey: string;
    r2ObjectKey: string;
  }) {
    yield* sql`
      insert into Invoice (id, name, fileName, contentType, idempotencyKey, r2ObjectKey, status)
      values (
        ${input.invoiceId}, ${input.name}, ${input.fileName}, ${input.contentType},
        ${input.idempotencyKey}, ${input.r2ObjectKey}, ${"uploading"}
      )
      on conflict(id) do nothing
    `;
  },
);
```

### r2ObjectKey — optional but harmless

We know the key at insert time (`${this.name}/invoices/${invoiceId}`). Including it means the row is complete from the start. Omitting it is also safe — the column defaults to `''`, and `onInvoiceUpload` upserts the real key. The UI shouldn't show a view link for "uploading" status, so an empty key is fine in that window. **Include it** for completeness since we have it.

### idempotencyKey — must include

`idempotencyKey` has a `unique` constraint (DDL L108). More importantly:
- `saveInvoiceExtraction` (repo L187) uses `where idempotencyKey = ?` to find the row
- `setError` (repo L211) uses `where idempotencyKey = ?` to find the row
- `onInvoiceUpload` guard (agent L186-187) compares `existing.value.idempotencyKey === upload.idempotencyKey`

If we omit it (null), the row exists but downstream operations that look up by `idempotencyKey` won't find it until `onInvoiceUpload` upserts. That's actually fine since those only run after the workflow starts — but `onInvoiceUpload`'s guard at L186 checks `existing.value.idempotencyKey !== null && existing.value.idempotencyKey === upload.idempotencyKey` — with null idempotencyKey, this guard is skipped, and `onInvoiceUpload` proceeds to upsert normally. So **omitting works but including is cleaner** and avoids any edge case where the workflow somehow starts before the upsert.

Key differences from `upsertInvoice`:
- No `r2ActionTime` — not known at upload time (comes from R2 event notification)
- `on conflict do nothing` — never overwrites a row that `onInvoiceUpload` already created
- No extracted field resets needed — this is a fresh row

## uploadInvoice Changes

After the R2 put block (after L280), before the local queue message:

```ts
const name = data.fileName.replace(/\.[^.]+$/, "");
const repo = yield* OrganizationRepository;
yield* repo.insertUploadingInvoice({
  invoiceId,
  name,
  fileName: data.fileName,
  contentType: data.contentType,
  idempotencyKey,
  r2ObjectKey: key,
});
```

### Ordering: insert before or after local queue message?

In **production**, R2 event notifications fire automatically from the R2 put — the local queue send doesn't exist. So the insert always happens after R2 and before `onInvoiceUpload` (which is async via queue). Order relative to the local queue message is irrelevant in prod.

In **local dev**, placing the insert **after** the queue send is slightly better: if the queue send fails, we haven't created a dangling "uploading" row. But the queue send is a dev-only workaround and not fault-tolerant itself, so this is marginal. **Place after the queue send** for slightly cleaner local dev semantics — but both orderings are fine.

Uses the same `name` derivation as `onInvoiceUpload` (L192): `fileName.replace(/\.[^.]+$/, "")`.

No new broadcast/activity needed.

## UI Changes

### Invoice detail page (`app.$organizationId.invoices.$invoiceId.tsx`)

L165 currently shows extraction message only for `"extracting"`. Should also handle `"uploading"`:

```ts
{(invoice.status === "extracting" || invoice.status === "uploading")
  ? invoice.status === "uploading"
    ? "Uploading invoice..."
    : "This invoice is still extracting and cannot be edited yet."
```

Or simpler — treat both the same:
```ts
{(invoice.status === "extracting" || invoice.status === "uploading")
  ? "This invoice is being processed and cannot be edited yet."
```

### Invoice list rendering

Check if invoice list items show status badges or indicators — these may need "uploading" added. The list route is `app.$organizationId.invoices.index.tsx`.

## Summary of Files to Change

1. **`src/lib/OrganizationDomain.ts`** — add `"uploading"` to `InvoiceStatusValues`
2. **`src/lib/OrganizationRepository.ts`** — add `insertUploadingInvoice` method
3. **`src/organization-agent.ts`** — call `insertUploadingInvoice` in `uploadInvoice` after R2 put
4. **`src/routes/app.$organizationId.invoices.$invoiceId.tsx`** — handle "uploading" status in UI
5. **`src/routes/app.$organizationId.invoices.index.tsx`** — handle "uploading" in list display if needed

No changes needed to: `onInvoiceUpload`, `saveInvoiceExtraction`, `setError`, `deleteInvoice`, `deleteInvoiceRecord`, queue consumer, workflow.
