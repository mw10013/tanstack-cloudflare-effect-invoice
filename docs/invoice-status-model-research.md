# Invoice Status Model Research

## Status Model Redesign

### Current Statuses

| Status | Set Where | Meaning |
|---|---|---|
| `uploaded` | `repo.upsertInvoice` (OrganizationRepository.ts:61) | File in R2, DB record created |
| `extracting` | `repo.setExtracting` (OrganizationRepository.ts:97) | Extraction workflow running |
| `extracted` | `repo.saveExtraction` (OrganizationRepository.ts:125) | AI extraction complete |
| `error` | `repo.setError` (OrganizationRepository.ts:165) | Extraction failed |

### Problem: "uploaded" Is Misleading

The invoice record is only inserted into the database **after** R2 confirms the upload is complete (via R2 notification → worker → org-agent). So by the time the DB record exists, the file is already uploaded. The status immediately transitions: `uploaded` → `extracting` in the same `onInvoiceUpload` handler (organization-agent.ts). The `uploaded` status is effectively a transient intermediate state that users rarely see.

### Problem: "extracted" Doesn't Fit Manual Invoices

When a user creates an invoice manually (no file, no extraction), the invoice is immediately usable. Calling it "extracted" is wrong — nothing was extracted.

### Proposed Status Model

| Status | Meaning | When Set |
|---|---|---|
| `extracting` | Extraction workflow running | Upload flow: on invoice insert (R2 notification received) |
| `ready` | Invoice data is available for use | Upload flow: extraction completes. Manual flow: on create. |
| `error` | Extraction or processing failed | Upload flow: extraction fails |
| `deleted` | Soft-deleted (future) | Delete action (replaces current hard delete) |

**Removed:**
- `uploaded` — not needed. Record is inserted with `extracting` since extraction kicks off immediately upon insert.
- `extracted` — renamed to `ready` (or alternative, see below).

**Added:**
- `deleted` — for future soft-delete support.

### Status Lifecycle: Upload Flow (Revised)

```
R2 notification received → worker → org-agent.onInvoiceUpload
  → repo.upsertInvoice()          status: "extracting"
  → runWorkflow(EXTRACTION)
  → extraction completes
    → repo.saveExtraction()        status: "ready"
  OR extraction fails
    → repo.setError()              status: "error"
```

No more `uploaded` → `extracting` two-step. The record starts at `extracting`.

### Status Lifecycle: Manual Create Flow

```
createInvoice server fn → org-agent.createInvoice
  → repo.upsertInvoice()          status: "ready"
```

Immediately `ready` — no extraction needed.

### Status Lifecycle: Soft Delete (Future)

```
deleteInvoice server fn → org-agent
  → repo.softDeleteInvoice()      status: "deleted"
  → (optionally) schedule R2 cleanup
```

R2 object cleanup can happen asynchronously or be deferred. The invoice disappears from default queries immediately.

---

## Question 3: Is "ready" the Right Name?

### Options Considered

| Name | Pros | Cons |
|---|---|---|
| `ready` | Clear intent: invoice is ready for use/review | Slightly vague — ready for what? |
| `active` | Common SaaS status term, clear meaning | Could imply ongoing activity vs. static data |
| `complete` | Indicates all data is present | Manual invoices start "complete" with no data — contradictory? |
| `available` | Neutral, indicates accessibility | Uncommon in status enums |
| `draft` | Familiar term for editable documents | Implies not finalized; but extracted invoices are also "ready" — calling them draft is confusing |

### Assessment

`ready` works well for both flows:
- Upload: extraction done, invoice data ready for review
- Manual: invoice created, ready for user to populate

The alternative `active` is also reasonable but has a different connotation (ongoing vs. available). `complete` is misleading for manual invoices that start empty.

<!-- REVIEW: Preference between "ready" and "active"? Or another option? -->

---

## Question 4: Other Statuses to Consider

### Statuses We Considered and Rejected (For Now)

| Status | Why Considered | Why Not Now |
|---|---|---|
| `draft` | Manual invoice creation research proposed it | Adds complexity. If manual invoices are immediately `ready`, a separate `draft` state just means "ready but empty" which the UI can determine from data presence. If we later want explicit draft→finalized workflow, we can add it then. |
| `uploading` | Track in-progress uploads | Not needed — DB record is only created after R2 confirms upload complete. Upload progress is client-side only. |
| `uploaded` | Current status | Redundant — extraction starts immediately on insert. |
| `sent` | Invoice sent to recipient | Out of scope — no send/share functionality yet. |
| `paid` / `overdue` | Payment tracking | Out of scope — no payment tracking yet. |
| `archived` | Hide without deleting | `deleted` (soft delete) serves the same purpose for now. |
| `processing` | Generic "something happening" | `extracting` is more specific and descriptive. |

### Recommended Final Status Set

```typescript
export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
```

Four statuses. Minimal, each with clear meaning and a specific lifecycle trigger.

<!-- REVIEW: Any statuses missing? Should "deleted" wait until the soft-delete implementation, or define it now for forward compatibility? -->

---

## Question 5: UI Impact

### Badge Mapping (Current → Proposed)

Current `getStatusVariant` logic in invoices.tsx:
- `extracted` → `success` (green)
- `error` → `destructive` (red)
- everything else → `secondary` (grey)

Proposed:
- `ready` → `success` (green)
- `error` → `destructive` (red)
- `extracting` → `secondary` (grey)
- `deleted` → not displayed (filtered from default queries)

### Other UI Changes

- Remove "uploaded" badge handling (no longer a status)
- Invoices list query should filter out `deleted` by default
- Invoice detail view: `ready` replaces `extracted` as the condition for showing full data

---

## Summary of Proposed Changes

All items implemented:

1. ~~**Move** `InvoiceStatus` + `InvoiceStatusValues` from Domain.ts → OrganizationDomain.ts~~ **DONE**
2. ~~**Replace** status values: `["uploaded", "extracting", "extracted", "error"]` → `["extracting", "ready", "error", "deleted"]`~~ **DONE**
3. ~~**Upload flow**: insert with `extracting` (remove `uploaded` intermediate step)~~ **DONE**
4. **Manual create flow**: insert with `ready` — deferred
5. **Soft delete**: set status to `deleted` instead of hard delete — deferred
