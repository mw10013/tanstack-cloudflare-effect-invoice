# Invoice Schema Research

Current schema (organization-agent.ts L47-59):

```sql
create table if not exists Invoice (
  id text primary key,
  fileName text not null,
  contentType text not null,
  createdAt integer not null,
  eventTime integer not null,
  idempotencyKey text not null unique,
  r2ObjectKey text not null,
  status text not null default 'uploaded',
  processedAt integer,
  invoiceJson text,
  invoiceJsonError text
)
```

---

## `status`

### Current values and where they're set

| Value | Where set | Meaning |
|---|---|---|
| `uploaded` | `onInvoiceUpload` — default on insert, reset on upsert (L55, L109, L118) | File landed in R2, row created |
| `extracting` | `onInvoiceUpload` — after `runWorkflow` succeeds (L146) | Workflow started |
| `extracting_json` | Only checked in guard (L95), never written | Dead code from prior iteration |
| `ready` | `applyInvoiceJson` (L190) | Extraction succeeded, invoiceJson populated |
| `extract_error` | `onWorkflowError` (L221) | Workflow failed |

### UI reads (invoices.tsx)

- `getStatusVariant`: `ready` → default, `extract_error` → destructive, else → secondary (L80-86)
- Badge renders `invoice.status` raw (L430)
- `extract_error` shows error alert (L302)

### Issues

1. `extracting_json` is dead — checked in the guard at L95 but never written anywhere.
2. `uploaded` as default is misleading — when the row is first created, the workflow is about to start. The status immediately transitions to `extracting` a few lines later. The default only matters if the process crashes between insert and `runWorkflow`.
3. No enum/literal type — status is a plain `text` column and `Schema.String` in the row schema. No compile-time safety.

### Recommendation

- Remove `extracting_json` from guard.
- Keep `uploaded`, `extracting`, `ready`, `extract_error` as the four states. Consider renaming for clarity:
  - `uploaded` → `pending`? Or keep `uploaded`.
  - `extracting` → fine.
  - `ready` → `extracted`? More descriptive. `ready` is vague.
  - `extract_error` → `error`? Shorter. Status column already scopes to invoice context.
- Add `Schema.Literals` for compile-time safety.

---

## `processedAt`

### Usage

| Where | How |
|---|---|
| `applyInvoiceJson` (L187-191) | Set to `Date.now()` on success |
| `onWorkflowError` (L219-224) | Set to `Date.now()` on error |
| `onInvoiceUpload` upsert (L110, L119) | Reset to `null` |
| UI | **Never read.** Not displayed anywhere. |

### Analysis

It's set when extraction completes (success or failure) but never consumed. Could be useful for latency tracking (createdAt → processedAt) but currently unused.

### Recommendation

- **Remove** unless we have a near-term plan to display it. Easy to re-add later. Reduces schema noise.
- Alternative: keep for debugging/admin purposes, but it's invisible to users.

---

## `eventTime`

### Usage

| Where | How |
|---|---|
| R2 queue notification | `notification.eventTime` — the timestamp from the R2 event (worker.ts L171, L225, L281) |
| Local dev upload/delete | `new Date().toISOString()` — synthetic (invoices.tsx L183, L218) |
| `onInvoiceUpload` | Parsed, used for out-of-order detection: `if (existing && eventTime < existing.eventTime)` (L85). Also written to both `createdAt` and `eventTime` on insert (L108). |
| `onInvoiceDelete` | Parsed, used in delete guard: `where eventTime <= ${eventTime}` (L170) |

### Analysis

- **Purpose**: Guards against out-of-order R2 event notifications. If a stale event arrives after a newer one, it's ignored.
- **Name**: Generic — it's specifically the R2 notification timestamp, not an arbitrary event time.
- **Dual use**: On first insert, `createdAt = eventTime` (L108). On upsert, only `eventTime` updates; `createdAt` stays from original insert.

### Recommendation

- Rename to `r2EventTime` or `lastEventTime` to clarify its purpose.
- Keep the column — the out-of-order guard is important for correctness with queue-based event processing.

---

## `invoiceJsonError`

### Usage

| Where | How |
|---|---|
| `onWorkflowError` (L224) | Stored with prefix-stripped error message |
| `applyInvoiceJson` (L193) | Reset to `null` on success |
| UI (invoices.tsx L307) | Displayed in alert when `status === "extract_error"` |
| `extractInvoiceJsonErrorPrefix` | String prefix convention to tag extraction errors in workflow, stripped in `onWorkflowError` |

### Analysis

- Column name is overly specific (`invoiceJsonError` vs just `error`).
- The `extractInvoiceJsonErrorPrefix` string-prefix convention couples workflow ↔ agent through fragile string parsing.
- The column stores errors from any workflow step (file load, extraction, save), not just JSON extraction.
- `status = 'extract_error'` already conveys "this is an extraction error."

### Recommendation

- Rename to `error` — simpler, and `status` already provides context.
- Remove `extractInvoiceJsonErrorPrefix` and the prefix-stripping logic. Store the raw error string from `onWorkflowError`.

---

## `invoiceJson`

### Usage

| Where | How |
|---|---|
| `applyInvoiceJson` (L192) | Stored as JSON string on success |
| UI (invoices.tsx L311-331) | Parsed and pretty-printed in inspection panel |
| UI (invoices.tsx L320-321) | Copied to clipboard |

### Analysis

- Straightforward. Stores the extracted structured data as a JSON string.
- Name is fine — `invoiceJson` or `extractionJson` would both work.

### Recommendation

- Keep as-is, or rename to `extractedJson` / `extractionResult` if we want consistency with other renames.

---

## Summary of proposed changes

| Column | Action |
|---|---|
| `status` | Remove `extracting_json` from guard. Consider `Schema.Literals`. Consider renaming `ready` → `extracted`, `extract_error` → `error`. |
| `processedAt` | Remove (unused in UI). |
| `eventTime` | Rename to `r2EventTime` or `lastEventTime`. |
| `invoiceJsonError` | Rename to `error`. Remove `extractInvoiceJsonErrorPrefix`. |
| `invoiceJson` | Keep. Maybe rename to `extractedJson`. |
| `extracting_json` dead code | Remove from guard at L95. |

---

## Questions for review

1. Do we want `processedAt` for future admin/debugging, or remove it now?

Remove

2. Preferred name for `eventTime`?

I want `r2` somewhere in the name. `r2EventTime` still seems too generic even though now we know it's about r2. Analyze the code and scan refs/cloudflare-docs. Is this an r2 notification time or is it an r2 time independent of r2 notifications. is this just for r2 put or also for r2 delete?

3. Preferred name for `status` values? Keep existing or rename?

I don't think we need `extracting_json`, right? so that should be removed.
`uploaded` is fine. it should not be the default status and there should not be any default status. the upsert must be explicit about it.

`extract_error` should probably be renamed to `error`, right?

Yes, I think we need schema type and literals or some such for this. I'm not sure how to go about it and we probably do something similar in Domain.ts


4. Rename `invoiceJson` to `extractedJson` or leave it?

rename.


In the UI, I think we show `ready`. I'm not sure we are ready for a `ready` state since we're slowly making our way through the UI workflow. After the invoice is extracted, we should probably just leave it in the extracted state or whatever calling that. At some point, we'll want a state indicating human needs to review extraction.

We use status as the column in the database. I suppose it could also be called state. Not sure which is better in the context of database and backend. Also, in the context of UI where it's displayed. status vs state. tradeoffs, recommendation?

Yes, we want to remove processedAt.