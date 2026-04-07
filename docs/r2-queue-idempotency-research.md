# R2 Queue Idempotency Research

## Question

- Is `eventTime` actually used in `onInvoiceUpload`?
- Are retries and duplicate queue messages handled correctly?

## Grounding

- Cloudflare Queues delivery model is at-least-once, so duplicates can happen:
  - `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`
  - `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:14`
- Queue ordering is best effort, not guaranteed FIFO:
  - `refs/cloudflare-docs/src/content/docs/queues/configuration/javascript-apis.mdx:285`
- R2 notification payload includes `eventTime`:
  - `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:103`

## Does `onInvoiceUpload` use `eventTime`?

Yes.

Flow in code:

1. Queue consumer maps R2 notification `eventTime` into `r2ActionTime`:

```ts
stub.onInvoiceUpload({
  invoiceId: metadata.invoiceId,
  r2ActionTime: notification.eventTime,
  idempotencyKey: metadata.idempotencyKey,
  r2ObjectKey: notification.object.key,
  fileName: metadata.fileName,
  contentType: metadata.contentType,
})
```

Source: `src/lib/Q.ts:94`, `src/lib/Q.ts:96`.

2. `onInvoiceUpload` parses and compares it to stored `r2ActionTime`:

```ts
const r2ActionTime = Date.parse(upload.r2ActionTime)
...
if (
  Option.isSome(existing) &&
  existing.value.r2ActionTime !== null &&
  r2ActionTime < existing.value.r2ActionTime
) return
```

Source: `src/organization-agent.ts:180`, `src/organization-agent.ts:190`.

So the stale/out-of-order guard is present and based on `eventTime` via `r2ActionTime`.

## Current Retry + Dedupe Behavior

- Queue handler retries processing on non-schema failures (`message.retry()`):
  - `src/lib/Q.ts:217`
- `onInvoiceUpload` dedupes when same `idempotencyKey` already has persisted `r2ActionTime`:
  - `src/organization-agent.ts:200`
  - `src/organization-agent.ts:204`

### Practical impact

- Duplicate delivery after first successful process is ignored. Good.
- Out-of-order older notifications are ignored by timestamp check. Good.
- Risk window still exists:
  - if DB upsert to `extracting` succeeds,
  - then workflow start fails,
  - retried message can be deduped too early,
  - resulting in stuck `extracting`.

This can happen because dedupe only checks persisted row/key/time, not whether a workflow is actually running or completed.

## Effective Fix Strategy

Use dedupe based on both idempotency and workflow/state truth:

- Keep stale guard (`r2ActionTime < existing.r2ActionTime`) as-is.
- Skip duplicate only when one of these is true:
  - an active workflow exists for this `idempotencyKey`, or
  - invoice is terminal (`ready` or `error`) for this same key.
- If invoice is `extracting` but no active workflow is found, allow retry path to re-attempt workflow start.

This preserves dedupe for genuine duplicates while fixing the "upsert succeeded, workflow start failed" retry hole.

## Recommendation

- Keep using `idempotencyKey` as deterministic workflow id.
- Adjust dedupe condition to include workflow truth (active instance) and terminal invoice state.
- Treat "workflow already exists" as idempotent success.
- Add monitoring for invoices stuck in `extracting` beyond an SLA threshold.
