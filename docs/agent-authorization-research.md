# Agent Callable Authorization Research

## Problem

`connection.state` gives us `userId` per socket (see `agent-connection-identity-research.md`). But callable methods need to verify the user is a member of the organization before executing. The agent instance name is the `organizationId`, so we need: is `userId` a member of this org?

## Current Auth Flow

`worker.ts:236-252` — `authorizeAgentRequest` checks:
1. valid Better Auth session
2. `session.activeOrganizationId === agentName`
3. forwards `userId` via `x-organization-agent-user-id` header

This checks session claims but does **not** verify the user is actually in the `Member` table. A stale session with a revoked membership would pass.

## Membership Data

D1 `Member` table (`migrations/0001_init.sql:86-98`):
```sql
create table Member (
  id text primary key,
  userId text not null references User (id) on delete cascade,
  organizationId text not null references Organization (id) on delete cascade,
  role text not null references MemberRole (memberRoleId),
  createdAt text not null default (datetime('now'))
);
```

Roles: `owner`, `admin`, `member` (`migrations/0001_init.sql:12-20`).

`Repository.ts` already has `getMemberByUserAndOrg({ userId, organizationId })`.

## Membership Mutation Points

All membership changes go through server functions calling better-auth API:
- `acceptInvitation` → `auth.api.acceptInvitation()` — `app.$organizationId.index.tsx:68-91`
- `removeMember` → `auth.api.removeMember()` — `app.$organizationId.members.tsx:96-111`
- `leaveOrganization` → `auth.api.leaveOrganization()` — `app.$organizationId.members.tsx:116-131`
- `updateMemberRole` → `auth.api.updateMemberRole()` — `app.$organizationId.members.tsx:136-152`
- auto-create on signup → `organizationApiCreate()` — `Auth.ts:121-152`

## Approach: Application-Level Queue Sync

Each server function that mutates membership does two things **in order**:
1. Send queue message with indication (`added`, `removed`, or `role_changed`)
2. Call better-auth API (writes to D1)

Queue send happens **before** better-auth. If the queue send fails, we stop — better-auth never runs.

Queue consumer:
1. Receives message with `{ organizationId, userId, change: "added" | "removed" | "role_changed" }`
2. Checks D1 to confirm the indication aligns with current D1 state
3. If aligned → update DO SQLite (waking the DO if hibernated)
4. If not aligned → explicitly retry with delay

The queue consumer wakes the DO via RPC (`stub.onMembershipChanged()`), same as `processInvoiceDelete` wakes the DO via `stub.deleteInvoiceRecord()`.

### Alignment Check

The consumer always reads D1 before updating the DO. The queue message carries no role — the consumer reads the authoritative role from D1.

**`added` / `role_changed`**: Query D1 for the member row. If exists → upsert into DO SQLite with the role from D1. If not exists → not aligned, retry. These two indications have identical consumer behavior. Keeping them distinct is useful for logging.

**`removed`**: Query D1 for the member row. If not exists → delete from DO SQLite. If exists → not aligned, retry.

### The Race: Message Processed Before Better-Auth Commits

The queue message is async. It can be processed before the better-auth API call even starts:

1. Server function sends queue message
2. Consumer picks it up, reads D1 → sees old state → not aligned with indication
3. Meanwhile, better-auth hasn't been called yet (or is in-flight)

The consumer must retry with enough delay for better-auth to commit to D1.

### Retry Timing

Current queue config (`wrangler.jsonc:78-85`):
```jsonc
"max_batch_size": 10,
"max_batch_timeout": 5,
"max_retries": 3,
"dead_letter_queue": "dlq"
```

No `retry_delay` configured. Current consumer (`worker.ts:329-333`) calls `message.retry()` with no `delaySeconds`. Without a configured `retry_delay`, retries are delivered in the next batch — which can be near-immediate (governed by `max_batch_timeout` of 5 seconds). All 3 retries could fire within ~15 seconds.

A better-auth API call (D1 write) typically takes single-digit milliseconds. But the server function is a TanStack Start server function running in a Worker request — the queue send, better-auth call, and response all happen in one request. The consumer could pick up the message before the originating request has completed its better-auth call.

**How much time do the retries give?**

With no delay: ~5s between retries (max_batch_timeout). 3 retries = ~15s total window. A better-auth D1 write should complete well within that. The server function sends the queue message, then immediately calls better-auth — better-auth should commit within milliseconds, long before even the first retry.

But to be safe, adding a `retry_delay` or using `msg.retry({ delaySeconds })` gives explicit control:

- `msg.retry({ delaySeconds: 2 })` — 2s delay per retry, 3 retries = ~6s window
- `retry_delay: 5` in wrangler.jsonc — 5s delay per retry, 3 retries = ~15s window

Even the default (no delay, ~5s batch timeout) is likely sufficient. A better-auth call that takes more than 5 seconds to commit to D1 would indicate something seriously wrong.

**If all 3 retries fail**, the message goes to DLQ. This means D1 didn't reach the expected state within ~15 seconds. Likely causes:
- Better-auth call failed (D1 never changed) — correct to give up, DO shouldn't update
- D1 is down or severely degraded — bigger problems than membership sync
- Bug in the alignment check logic

In any of these cases, the DO having stale membership data is the least of the problems.

### Trade-Offs

**Pros:**
- Queue-send-first eliminates "D1 changed but no queue message."
- Alignment check prevents incorrect DO state — consumer never trusts the indication alone.
- Consumer always reads role from D1, never from the queue message.
- Retries handle the race between queue processing and better-auth commit.
- Zero-latency auth checks in callables.

**Cons:**
- 5 mutation points must send queue messages. Miss one → DO doesn't know.
- Auto-create on signup (`Auth.ts:121-152`) is inside `databaseHooks.user.create.after` — already a hook. For initial org creation, the owner is the sole member and the one connecting. Could skip queue for this case.
- DLQ messages from edge cases need monitoring (but indicate real problems).

## Role in the DO

### Current State

Agent callables (`createInvoice`, `uploadInvoice`, `updateInvoice`, `deleteInvoice`, `getInvoices`, `getInvoice`) do **zero** role or permission checks. All members can do everything. Role-based authorization only happens in server functions via `auth.api.hasPermission()` against D1 directly:
- `members.tsx:63-70` — checks `member: ["update", "delete"]`
- `invitations.tsx:70-75` — checks `invitation: ["create", "cancel"]`

### Should the DO Store Role?

For current needs: no. The agent only needs "is this user a member?" — a boolean.

For future needs: store it. The consumer reads role from D1 anyway, so writing it to DO SQLite costs nothing extra. Avoids a migration later if callables need role-based checks.

### DO SQLite Schema

```sql
create table if not exists AgentMember (
  userId text primary key,
  role text not null
);
```

No `organizationId` — each DO instance is scoped to one org.

### Queue Message Schema

```ts
{
  action: "MembershipSync",
  organizationId: string,
  userId: string,
  change: "added" | "removed" | "role_changed",
}
```

No role in the message. The `change` field tells the consumer what to verify against D1. `added` and `role_changed` have identical consumer behavior (read D1, upsert). `removed` has inverse behavior (read D1, expect absence, delete).

## Cloudflare Primitives Referenced

- **D1 read replicas / Sessions API**: `refs/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`
- **DO SQLite**: `refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx`
- **DO lifecycle / hibernation**: `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx`
- **Queue retries / delays**: `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx` — `msg.retry({ delaySeconds })`, `retry_delay` config, `msg.attempts` for backoff
- **Queues**: `wrangler.jsonc:71-87` — max_retries: 3, dead_letter_queue: dlq
- **Existing queue consumer**: `worker.ts:310-333` — `message.retry()` with no delay currently
- **Existing queue pattern**: `worker.ts:212-234` (delete invoice), `organization-agent.ts:340-370`
