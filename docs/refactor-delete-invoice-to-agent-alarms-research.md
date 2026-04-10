# Refactor `deleteInvoice` From Cloudflare Queue To Agent Alarms

## Bottom Line

- Replace the `FinalizeInvoiceDeletion` queue round-trip with `this.schedule(0, "onFinalizeInvoiceDeletion", payload, { retry: { maxAttempts: 3 } })` inside `OrganizationAgent.deleteInvoice`.
- Keep `onFinalizeInvoiceDeletion` as the alarm callback. Its body is already idempotent (`repo.deleteInvoice` is a no-op if the row is gone, `r2.delete` is idempotent on R2).
- Preserve the existing "schedule first, then delete the row eagerly" ordering — same crash-safety story as the current "enqueue first, then delete" pattern, just with the durable intent stored in `cf_agents_schedules` instead of a Cloudflare Queue.
- Failed retries are dropped (no DLQ), so the failure budget moves from "Cloudflare Queue retries until DLQ" to "2 retries with full-jitter exponential backoff, then orphaned R2 object". Acceptable for invoice file cleanup; called out below as the main tradeoff.
- Strip `FinalizeInvoiceDeletionQueueMessage` and its consumer branch from `src/lib/Q.ts`. The other queue paths (`PutObject`, `FinalizeMembershipSync`) are unaffected.

## Sources Checked

- `src/organization-agent.ts` (current `deleteInvoice` / `onFinalizeInvoiceDeletion`)
- `src/lib/Q.ts` (current queue producer + consumer for `FinalizeInvoiceDeletion`)
- `docs/cloudflare-durable-object-alarms-and-agents-research.md` (durability and retry guarantees of the underlying primitives)
- `refs/agents/docs/scheduling.md` (`schedule()` API, delay semantics, the "Scheduling vs Queue" decision matrix)
- `refs/agents/docs/retries.md` (`RetryOptions`, defaults, full-jitter backoff math, no-DLQ limitation)
- `refs/agents/packages/agents/src/index.ts` lines 2414-2568 (`schedule()` implementation: `cf_agents_schedules` row insert + `_scheduleNextAlarm()`)

## Current Architecture

`src/organization-agent.ts:446-480`:

```ts
@callable()
deleteInvoice(input: typeof DeleteInvoiceInput.Type) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      yield* assertCallerMember();
      const { invoiceId } =
        yield* Schema.decodeUnknownEffect(DeleteInvoiceInput)(input);
      const repo = yield* OrganizationRepository;
      const invoice = yield* repo.findInvoice(invoiceId);
      if (Option.isNone(invoice)) return;
      if (invoice.value.status !== "ready" && invoice.value.status !== "error")
        return yield* new OrganizationAgentError({ ... });
      const { Q: queue } = yield* CloudflareEnv;
      yield* Effect.tryPromise({
        try: () => queue.send({
          action: "FinalizeInvoiceDeletion",
          organizationId: this.name,
          invoiceId,
          r2ObjectKey: invoice.value.r2ObjectKey,
        }),
        catch: (cause) => new OrganizationAgentError({ ... }),
      });
      yield* repo.deleteInvoice(invoiceId);
    }),
  );
}
```

The queue consumer in `src/lib/Q.ts:91-101` resolves a fresh agent stub and calls `onFinalizeInvoiceDeletion`, which re-applies the (idempotent) DB delete and finalizes R2:

```ts
onFinalizeInvoiceDeletion(input: { invoiceId; r2ObjectKey }) {
  return this.runEffect(
    Effect.gen(function* () {
      const repo = yield* OrganizationRepository;
      yield* repo.deleteInvoice(input.invoiceId);
      if (!input.r2ObjectKey) return;
      const r2 = yield* R2;
      yield* r2.delete(input.r2ObjectKey);
    }),
  );
}
```

The doc-comment on `deleteInvoice` already spells out the invariant: enqueue first so that a crash between enqueue and local delete still completes via the queue consumer.

## Target Architecture

The same invariant, restated against agent scheduling:

1. Persist deletion intent into `cf_agents_schedules` via `this.schedule(0, "onFinalizeInvoiceDeletion", { invoiceId, r2ObjectKey }, { retry: { maxAttempts: 3 } })`.
2. Eagerly delete the local invoice row so reads stop returning it.
3. The agent alarm fires "now" (delay 0 — `refs/agents/docs/scheduling.md` Limits: "Minimum delay: 0 seconds (runs on next alarm tick)") and dispatches `onFinalizeInvoiceDeletion(payload)`.
4. The handler runs idempotently: re-applies the DB delete and deletes the R2 object.

Why this is durable:

- `cf_agents_schedules` rows live in the agent's own SQLite DB, which is the same Durable Object storage as the `Invoice` table. From `refs/cloudflare-docs/.../concepts/what-are-durable-objects.mdx`: *"Each Durable Object has its own durable, transactional, and strongly consistent storage, persisted across requests."*
- The scheduler immediately calls `this.ctx.storage.setAlarm(...)` (research doc, "What Agents persists"). Per `refs/cloudflare-docs/.../api/alarms.mdx`: alarms are durable, survive eviction/restart, and have at-least-once delivery.
- `_scheduleNextAlarm()` reconstructs the next alarm from SQLite on every wake, so an evicted DO that lost its in-memory state still re-arms (research doc, "Re-arming lost alarms after restart/eviction").

### Refactored Code Sketch

```ts
@callable()
deleteInvoice(input: typeof DeleteInvoiceInput.Type) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      yield* assertCallerMember();
      const { invoiceId } =
        yield* Schema.decodeUnknownEffect(DeleteInvoiceInput)(input);
      const repo = yield* OrganizationRepository;
      const invoice = yield* repo.findInvoice(invoiceId);
      if (Option.isNone(invoice)) return;
      if (invoice.value.status !== "ready" && invoice.value.status !== "error")
        return yield* new OrganizationAgentError({
          message: `Invoice cannot be deleted in status=${invoice.value.status}`,
        });
      yield* Effect.tryPromise({
        try: () =>
          this.schedule(
            0,
            "onFinalizeInvoiceDeletion",
            { invoiceId, r2ObjectKey: invoice.value.r2ObjectKey },
            { retry: { maxAttempts: 3 } },
          ),
        catch: (cause) =>
          new OrganizationAgentError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      yield* repo.deleteInvoice(invoiceId);
    }),
  );
}
```

`onFinalizeInvoiceDeletion` is **unchanged** — it is already a plain instance method (not `@callable()`), and the agent scheduler dispatches by name via `this[callback](payload)` (`refs/agents/packages/agents/src/index.ts` schedule()/alarm() flow). No need to rename, decorate, or change the signature.

### Cleanup In `src/lib/Q.ts`

Remove all three pieces:

- `FinalizeInvoiceDeletionQueueMessage` schema (lines 15-20)
- `processFinalizeInvoiceDeletion` (lines 91-101)
- `case "FinalizeInvoiceDeletion":` branch in `processMessage` (lines 120-122)
- The schema's reference in the `QueueMessage` union (line 41)

`enqueue` itself stays — it is still used by `uploadInvoice` for the local-mode `PutObject` notification.

The `CloudflareEnv` import in `organization-agent.ts` is still used elsewhere only via the `Q` env binding for this one call site; after the refactor, audit whether any other code still needs `CloudflareEnv` from this file. (Skim shows it only appears in `deleteInvoice` — confirm during edit.)

## Retry Semantics

User decision: **2 retries with exponential backoff and jitter**.

The Agents SDK exposes this through `RetryOptions.maxAttempts`, where `maxAttempts` is "Maximum number of attempts (including the first)" (`refs/agents/docs/retries.md` `RetryOptions`). So **retry 2x = `maxAttempts: 3`** (1 initial attempt + 2 retries).

> ⚠️ Confirm interpretation: "retry 2x" was read as "two retries after the initial attempt" → `maxAttempts: 3`. If you meant "two attempts total" use `maxAttempts: 2`.

Backoff is full-jitter exponential, computed by the SDK (`refs/agents/docs/retries.md` "How It Works"):

```
delay = random(0, min(2^attempt * baseDelayMs, maxDelayMs))
```

With defaults (`baseDelayMs: 100`, `maxDelayMs: 3000`), the retry budget for `maxAttempts: 3` is:

| Attempt | Upper bound                  | Actual delay     |
| ------- | ---------------------------- | ---------------- |
| 1       | (initial)                    | —                |
| 2       | min(2^1·100, 3000) = 200ms   | random(0, 200ms) |
| 3       | min(2^2·100, 3000) = 400ms   | random(0, 400ms) |

Total worst-case retry window: ~600ms. If R2 is briefly unavailable for more than that, the schedule row is dropped per `refs/agents/docs/retries.md` Limitations: *"No dead-letter queue. If a queued or scheduled task fails all retry attempts, it is removed."*

If we want a longer recovery window without changing the retry count, bump `baseDelayMs` / `maxDelayMs`:

```ts
{ retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 } }
```

That stretches worst-case to ~30s + 60s ≈ 90s without adding more attempts. Worth considering — R2 incidents typically last longer than 600ms.

## Failure Modes

| Failure point                                  | Outcome                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Crash before `this.schedule()` succeeds        | Schedule row not written, invoice row not deleted. Caller error surfaces. User can retry — original state preserved.                     |
| Crash after `schedule()` but before row delete | Schedule row durable in SQLite. On next wake, alarm fires, handler deletes the (still-present) row idempotently and removes R2 object. ✓ |
| Crash after row delete                         | Same as above — handler still runs, DB delete is a no-op, R2 deletion completes. ✓                                                       |
| `r2.delete` throws transiently in handler      | App-level retry via `tryN` re-runs the callback up to `maxAttempts` times with jittered backoff.                                         |
| `r2.delete` fails persistently past retries    | Schedule row removed. R2 object becomes orphaned with no recovery path. **Tradeoff vs. queue's longer DLQ horizon.**                     |
| DO evicted while alarm pending                 | Durable alarm metadata wakes the DO; `_scheduleNextAlarm()` reconstructs the next alarm from `cf_agents_schedules`. ✓                    |
| Concurrent duplicate `deleteInvoice` calls     | Second call sees `Option.isNone(invoice)` (first call already deleted) and returns early. No double-schedule.                            |
| Native DO alarm itself fires twice             | Handler is idempotent (DB delete no-op + R2 delete idempotent). At-least-once is safe here.                                              |

The only meaningfully *new* risk vs. the queue version is the orphaned-R2 case, since Cloudflare Queues offer longer retry horizons and DLQs that we are not currently using but could enable. For invoice file cleanup the cost of an orphaned object is low: it occupies storage but is unreachable from any DB row. Acceptable for this domain.

## Ordering Rationale

Two valid orders exist; pick the one that mirrors current safety:

- **schedule → delete (recommended)**: matches the current "enqueue first" invariant. A crash between the two leaves the deletion intent durable and the row still visible, which converges correctly on next wake.
- **delete → schedule (rejected)**: if `schedule()` fails after the row is gone, the R2 object is orphaned with no recovery hook. Loses the safety net.

`SQLite ops in DOs don't yield the event loop` (per the existing constructor comment in `src/organization-agent.ts:125-127`), so within a single synchronous SQL call there is no interleaving. But `this.schedule()` is async and the Effect chain yields between steps, so the schedule must come first to be the durable anchor.

## Testing Notes

- Vitest helper `runDurableObjectAlarm(stub)` (research doc, "Official test APIs") fires the agent's `alarm()` once, which drains all due `cf_agents_schedules` rows.
- Per the research doc's important caveat, `runDurableObjectAlarm()` does **not** simulate native exponential backoff or `alarmInfo.retryCount`. If the test wants to validate the app-level `tryN` retry path, throw deterministic failures inside the handler and assert the schedule row's `running` / row-removal state — but expect the helper to run the alarm only once per call.
- The known-issue from `refs/cloudflare-docs/.../platform/known-issues.mdx`: *"Durable Object alarms are not reset between test runs and do not respect isolated storage."* Drain alarms between tests with `runDurableObjectAlarm` until it returns `false`.

### Discovered post-implementation: miniflare auto-fires alarms in tests

A first draft of `test/integration/delete-invoice-alarm.test.ts` asserted intermediate state immediately after `deleteInvoice` returned:

```ts
const pendingBefore = yield* countPendingFinalizationSchedules(stub);
expect(pendingBefore).toBe(1);            // expected the schedule row to exist
const ran = await runDurableObjectAlarm(stub);
expect(ran).toBe(true);                    // expected to fire it manually
```

Both assertions failed (`pendingBefore = 0`, `ran = false`). Root cause: **miniflare's Durable Object alarm scheduler runs `setAlarm(now)` callbacks asynchronously in the test runtime.** With `schedule(0, ...)`, the alarm fires within a few hundred milliseconds — before the test code can re-enter and observe the row. By the time `runDurableObjectAlarm` is called, the alarm has already been consumed.

The vitest-pool-workers helpers do not pause or freeze the platform scheduler. There is no documented hook to disable auto-firing for delay-0 schedules, and the agents SDK test fixtures (`refs/agents/packages/agents/src/tests/schedule.test.ts`) work around the same race by either using non-zero delays + backdating rows via `runInDurableObject`, or by manually calling `clearStoredAlarm()` and `setStoredAlarm()` on test-only stub methods to control timing.

**Resolution**: do not assert intermediate state on delay-0 schedules. Verify the end-to-end contract via polling instead — the contract we care about ("alarm-driven R2 cleanup completes") is fully verifiable; precise timing of the alarm fire is not under test control. The implemented test uses two `pollUntil` checks (R2 head returns null, then `cf_agents_schedules` rows drain to 0) instead of asserting which side observed the row first.

This also has a bonus implication: **the `drainAgentAlarms` helper at end-of-test is largely defensive**, since the platform scheduler will normally drain delay-0 alarms before the test ends anyway. It is still worth keeping for tests that schedule alarms with non-zero delays, and as a hedge against future cases where assertions race the scheduler in the other direction.

### Existing tests touched

The `invoice-crud` test "deletes an invoice" and "getInvoices excludes deleted invoice" both call `deleteInvoice` and assert the local row is gone. They continue to pass unchanged because the eager delete path is preserved — they never inspected the queue side, so the alarm refactor is invisible to them.

## Decisions Locked In

1. **Retry budget**: `maxAttempts: 3` (initial + 2 retries), confirmed.
2. **Backoff window**: `baseDelayMs: 1000, maxDelayMs: 30_000` — wider than SDK defaults so the retry span (~90s) outlives typical R2 brownouts. Inline comment in `deleteInvoice` records the rationale.
3. **DLQ gap**: accepted as-is. Documented in the `deleteInvoice` jsdoc as an explicit failure mode rather than worked around. Future option: a `pending_deletion` status column on `Invoice` plus a `scheduleEvery` reconciliation loop, but materially more complexity than warranted today.
4. **Cross-DO scope**: alarm path runs entirely inside the originating DO. Removes one network hop and one worker invocation per delete vs. the queue path. No correctness change.
5. **Other queue paths**: only `FinalizeInvoiceDeletion` removed. `PutObject` (R2 event source — must stay queue-based) and `FinalizeMembershipSync` (cross-DO orchestration with D1 reconciliation) are untouched.
