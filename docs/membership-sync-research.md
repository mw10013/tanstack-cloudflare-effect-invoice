# Membership Synchronization Research

## Problem

The organization agent has a local `Member` sqlite table that mirrors D1's authoritative `Member` table (managed by better-auth). Currently, sync is eventual-consistent via Cloudflare Queue. This creates a **gap between when better-auth commits the membership change to D1 and when the organization agent's local table reflects it**, causing:

1. **User can't access organization agent immediately after accepting invitation** — `authorizeConnection()` checks the DO-local Member table, returns 403 until queue delivers and processes.
2. **Hard to test** — tests need timeouts/polling to wait for eventual sync.
3. **Confusing naming** — `MembershipSync` is vague; it's unclear whether it's the sync itself or a notification that triggers sync.

## Current Architecture

```
User Action → enqueue(MembershipSync) → better-auth API call → D1 updated
                     ↓ (async, at-least-once)
              Queue Consumer → stub.onMembershipSync() → DO sqlite updated
```

### Current Flow for Each Operation

| Operation | Server fn | Pattern |
|-----------|-----------|---------|
| Sign up (owner) | `Auth.ts:124-163` | better-auth creates org+member in D1 → **direct** `stub.onMembershipSync()` (no queue) |
| Accept invitation | `index.tsx:69-108` | enqueue → `auth.api.acceptInvitation()` → queue eventually syncs |
| Remove member | `members.tsx:98-123` | enqueue → `auth.api.removeMember()` → queue eventually syncs |
| Leave org | `members.tsx:128-154` | enqueue → `auth.api.leaveOrganization()` → queue eventually syncs |
| Update role | `members.tsx:159-185` | enqueue → `auth.api.updateMemberRole()` → queue eventually syncs |

**Key observation**: Sign-up already uses eager direct sync. All other operations use queue-first.

### Current `onMembershipSync` Handler (`organization-agent.ts:505-552`)

Validates against D1 before mutating local state:
- `added`/`role_changed`: D1 must have the member → upsert locally
- `removed`: D1 must NOT have the member → delete locally

This validation is what makes at-least-once delivery safe — stale events get rejected.

### Current Queue-First Ordering Issue

```
enqueue(MembershipSync, change: "added")   ← queued BEFORE D1 has the member
auth.api.acceptInvitation()                ← D1 member created HERE
```

If the queue delivers before `acceptInvitation()` completes, `onMembershipSync` checks D1, finds no member, and **fails**. The queue retries, and eventually D1 has the member, so it succeeds. This works but is fragile and adds latency.

## Proposed Architecture: Eager Sync + Enqueue-First Finalization

```
User Action → enqueue(FinalizeMembershipSync)          ← durable safety net first
            → better-auth API call → D1 updated
            → direct stub.syncMembership() → DO sqlite updated (eager, best-effort)
                     ↓ (async, at-least-once)
              Queue Consumer → stub.onFinalizeMembershipSync() → validate D1 ↔ DO alignment
```

### Principles

1. **Enqueue first for durability**: The queue message is persisted before any state change. If the process crashes at any point after enqueue, finalization will eventually run and reconcile.
2. **Eager sync after D1 write**: Call the organization agent directly after better-auth updates D1, same as sign-up already does. User gets immediate access.
3. **Queue as safety net, not primary path**: The queued `FinalizeMembershipSync` verifies D1 and DO are aligned. If eager sync succeeded, finalization is a no-op. If eager sync failed (network blip, agent restart), finalization fixes it.
4. **D1 remains authoritative**: Both eager sync and finalization read from D1 to determine truth.

### Fault Tolerance

The enqueue-first ordering is critical. Every crash scenario stays consistent:

| Crash point | D1 state | Queue | DO state | Outcome |
|---|---|---|---|---|
| After enqueue, before API call | No member | Message in flight | No member | Finalization checks D1, finds no member, rejects for `added`. Consistent — membership was never created. |
| After API call, before eager sync | Member exists | Message in flight | Stale | Finalization delivers, syncs DO. Temporarily laggy (same as today's behavior). |
| After eager sync | Member exists | Message in flight | Synced | Finalization runs, validates D1 matches DO, no-op. |
| Happy path (no crash) | Member exists | Message in flight | Synced immediately | Finalization is a no-op. User has immediate access. |

Contrast with a naive API-first-then-enqueue approach: if the process crashes after the API call but before enqueue, D1 has the member but no queue message exists and no eager sync happened — DO is permanently out of sync with no mechanism to fix it.

### Granularity: Per-Member

Sync operates at the individual member level:

```typescript
syncMembership(input: { userId: string; change: "added" | "removed" | "role_changed" })
```

- Finalization can validate intent: "was userId actually added/removed in D1?" — if not, it rejects the stale event.
- Minimal writes — only touches one row.
- Change type gives semantic meaning for logging/debugging.
- The current `onMembershipSync` handler already works this way — validates per-member against D1. We just split it into eager + finalization.

### Proposed Flow for Each Operation

```typescript
// Accept invitation
yield* enqueue({ action: "FinalizeMembershipSync", organizationId, userId, change: "added" });
yield* Effect.tryPromise(() => auth.api.acceptInvitation({ ... }));
yield* Effect.tryPromise(() => stub.syncMembership({ userId, change: "added" }))
  .pipe(Effect.catchAll((e) => Effect.logWarning("eager sync failed, relying on finalization", e)));
```

```typescript
// Remove member
yield* enqueue({ action: "FinalizeMembershipSync", organizationId, userId, change: "removed" });
yield* Effect.tryPromise(() => auth.api.removeMember({ ... }));
yield* Effect.tryPromise(() => stub.syncMembership({ userId, change: "removed" }))
  .pipe(Effect.catchAll((e) => Effect.logWarning("eager sync failed, relying on finalization", e)));
```

```typescript
// Update role
yield* enqueue({ action: "FinalizeMembershipSync", organizationId, userId, change: "role_changed" });
yield* Effect.tryPromise(() => auth.api.updateMemberRole({ ... }));
yield* Effect.tryPromise(() => stub.syncMembership({ userId, change: "role_changed" }))
  .pipe(Effect.catchAll((e) => Effect.logWarning("eager sync failed, relying on finalization", e)));
```

### Naming

| Current | Proposed | Why |
|---------|----------|-----|
| `MembershipSync` (queue action) | `FinalizeMembershipSync` | Clarifies it's a verification/cleanup step, not the primary sync |
| `onMembershipSync` (agent method) | Split into `syncMembership` + `onFinalizeMembershipSync` | Separates eager path (direct call, must succeed for UX) from background path (validation, can retry) |
| `membershipSyncChangeValues` | Keep `"added" \| "removed" \| "role_changed"` | Still useful for both eager and finalization |

## WebSocket Disconnection on Removal

When a member is removed, both `syncMembership` and `onFinalizeMembershipSync` forcibly close all WebSocket connections belonging to that user (close code `4003`, reason `"Membership revoked"`). This runs after `syncMembershipImpl` deletes the Member row.

**Why**: Without this, removed members continue receiving `broadcastActivity` messages (invoice names, extraction status) until they refresh — a minor authorization gap. The close event also gives the client a clear signal to show "removed from org" UI instead of cryptic RPC errors.

**Implementation**: `disconnectUser(agent, userId)` iterates `agent.getConnections()`, matching `conn.state?.userId`, and calls `conn.close(4003, "Membership revoked")`.

## Error Handling

### What if eager sync fails?

The eager sync failure should NOT fail the overall operation. The user's membership is committed in D1 (authoritative). If eager sync fails, the user temporarily can't access the agent — same as today's eventual consistency, but now it's an edge case instead of the default. The enqueue-first finalization will catch up.

### What if better-auth API call fails?

No sync needed — D1 wasn't changed. The server fn should propagate the error to the client. The already-enqueued finalization message will fire, check D1, find no change, and no-op (for `added`) or reject (for `removed`). Harmless.

## Implementation Changes

### 1. Organization Agent (`organization-agent.ts`)

```typescript
// Eager sync — called directly, not from queue
syncMembership(input: { userId: Domain.User["id"]; change: MembershipSyncChange }) {
  // Same logic as current onMembershipSync: validate against D1, upsert/delete locally
}

// Finalization — called from queue consumer
onFinalizeMembershipSync(input: { userId: Domain.User["id"]; change: MembershipSyncChange }) {
  // Same logic — validate against D1, upsert/delete locally
  // Effectively identical to syncMembership but:
  // - Different logging prefix for observability
  // - Errors trigger queue retry (via queue consumer error handling)
}
```

In practice these share the same internal implementation. The distinction is calling context (direct vs queue) and error handling semantics.

### 2. Queue (`Q.ts`)

- Rename `MembershipSync` action → `FinalizeMembershipSync`
- Rename `MembershipSyncQueueMessage` → `FinalizeMembershipSyncQueueMessage`
- Update `processMembershipSync` → `processFinalizeMembershipSync`, calls `stub.onFinalizeMembershipSync()`

### 3. Server Functions (route files)

Reorder to: enqueue → better-auth API call → eager sync.

```typescript
// Accept invitation (index.tsx)
yield* enqueue({ action: "FinalizeMembershipSync", organizationId, userId, change: "added" });
yield* Effect.tryPromise(() => auth.api.acceptInvitation({ ... }));
const stub = yield* getOrganizationAgentStub(invitation.value.organizationId);
yield* Effect.tryPromise(() => stub.syncMembership({ userId, change: "added" }))
  .pipe(Effect.catchAll((e) => Effect.logWarning("eager sync failed", e)));
```

### 4. Auth Sign-Up Hook (`Auth.ts`)

Already uses direct sync. Add finalization enqueue as safety net:

```typescript
yield* enqueue({ action: "FinalizeMembershipSync", organizationId, userId, change: "added" });
yield* Effect.tryPromise(() => stub.syncMembership({ userId, change: "added" }));
```

## Testing Impact

Eager sync makes tests deterministic:

```typescript
// Before: need to poll/wait for queue
await expect.poll(() => agentCall(), { timeout: 90_000 }).toBeTruthy();

// After: membership is synced before server fn returns
await agentCall(); // works immediately
```

## Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| Primary sync | Queue (async) | Direct call after D1 write (sync) |
| Fallback | None (queue IS the path) | Queue finalization (verify + correct) |
| Fault tolerance | Enqueue-first ensures queue message survives crashes | Same enqueue-first ordering preserved, plus eager sync on top |
| User experience | Lag after accepting invitation | Immediate access |
| Testability | Requires polling/timeouts | Deterministic |
| Naming | `MembershipSync` (ambiguous) | `syncMembership` (eager) + `FinalizeMembershipSync` (queue) |
| Sign-up consistency | Already eager (special case) | All operations use same pattern |
