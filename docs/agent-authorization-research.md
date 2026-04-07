# Agent Callable Authorization Research

## Conclusion

Yes: Cloudflare Agents supports the exact auth flow we need for org-scoped callables.

- authenticate in `routeAgentRequest(..., { onBeforeConnect, onBeforeRequest })`
- forward trusted identity on the routed request
- store that identity in `connection.state` during `onConnect`
- read it inside `@callable()` methods with `getCurrentAgent()`
- authorize the operation against org membership

The repo already implements most of this. The remaining auth gap is narrower: the Worker currently trusts `activeOrganizationId` at connect/request time, but it does not authoritatively verify the D1 `Member` row before allowing the agent request through.

## What `refs/agents` Confirms

`refs/agents/docs/routing.md:280-295`:

```ts
const response = await routeAgentRequest(request, env, {
  onBeforeConnect: (req, lobby) => {
    // Return a Response to reject, Request to modify, or void to continue
  },
  onBeforeRequest: (req, lobby) => {
    // Return a Response to reject, Request to modify, or void to continue
  }
});
```

This is the supported place to authenticate and rewrite the request before it reaches the agent.

`refs/agents/docs/http-websockets.md:283-323`:

```ts
onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
  connection.setState({
    username: url.searchParams.get("username") || "Anonymous",
    joinedAt: Date.now(),
    messageCount: 0
  });
}
```

`connection.state` is per-connection and survives hibernation, which makes it the right place for socket identity.

`refs/agents/packages/agents/src/index.ts:587-612`:

```ts
export function getCurrentAgent<...>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
}
```

So a callable can read `getCurrentAgent().connection.state` without extra plumbing.

One more important constraint from the earlier identity research: this org agent is one DO per organization, shared by multiple users. So auth belongs in per-connection state, not `props` or agent state.

## What `refs/cloudflare-docs` Confirms

Cloudflare's Durable Object docs support the current queue + local-sqlite direction.

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/access-durable-objects-storage.mdx:17`:

```md
A Durable Object's in-memory state is preserved as long as the Durable Object is not evicted from memory... use Storage API to persist state durably on disk that needs to survive eviction or restart of Durable Objects.
```

`refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:38-39,59-65`:

```md
the first incoming request or event ... will execute the constructor()
...
In case of an incoming request or event while in the hibernated state, the constructor() will run again
```

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/websockets.mdx:50-56`:

```md
During hibernation:
- WebSocket clients remain connected
- In-memory state is reset
- When an event arrives, the Durable Object is re-initialized and its constructor runs
```

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx:251`:

```md
Creating a stub does not instantiate or wake up the Durable Object. The Durable Object is only activated when you call a method on the stub.
```

Implications for this design:

- the DO-local sqlite `Member` table is durable and survives eviction/restart
- queue-triggered `stub.onMembershipChanged(...)` calls wake the org DO when needed
- hibernation only resets in-memory state, not the sqlite-backed membership cache
- there is no separate cold-start authorization problem caused by the DO sleeping

## What The Repo Already Has

### Worker-side identity handoff

`src/worker.ts:307-323` already authenticates the session, checks the active org, and forwards `userId` to the agent:

```ts
const session = yield* auth.getSession(request.headers);
...
if (!activeOrganizationId || agentName !== activeOrganizationId) {
  return new Response("Forbidden", { status: 403 });
}
const headers = new Headers(request.headers);
headers.set(organizationAgentAuthHeaders.userId, session.value.user.id);
return new Request(request, { headers });
```

And `src/worker.ts:340-343` uses the same guard for both WebSocket and HTTP agent traffic:

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: (req) => runEffect(authorizeAgentRequest(req)),
  onBeforeRequest: (req) => runEffect(authorizeAgentRequest(req)),
});
```

### Agent-side connection identity

`src/organization-agent.ts:152-162` reads that trusted header and stores it on the connection:

```ts
onConnect(connection, ctx) {
  const userId = ctx.request.headers.get(organizationAgentAuthHeaders.userId);
  if (!userId) {
    connection.close(4001, "Unauthorized");
    return;
  }
  connection.setState({ userId });
}
```

### Callable authorization

Every user-facing callable currently runs `authorizeConnection()` first.

Examples:

- `src/organization-agent.ts:238` `createInvoice`
- `src/organization-agent.ts:262` `updateInvoice`
- `src/organization-agent.ts:292` `uploadInvoice`
- `src/organization-agent.ts:351` `deleteInvoice`
- `src/organization-agent.ts:472` `getInvoices`
- `src/organization-agent.ts:483` `getInvoice`

`src/organization-agent.ts:494-526` already resolves the current socket identity via `getCurrentAgent()` and checks membership against the DO-local table:

```ts
const { agent, connection } = getCurrentAgent<OrganizationAgent>();
const identity = connection?.state as OrganizationAgentConnectionState | null | undefined;
...
const authorized = yield* repo.isMember(identity.userId as Domain.UserId);
if (!authorized) {
  return yield* new OrganizationAgentError({
    message: `Forbidden: userId=${identity.userId} not in Member table`,
  });
}
```

### DO-local membership cache

The org agent already has a local sqlite table in `src/organization-agent.ts:143-146`:

```sql
create table if not exists Member (
  userId text primary key,
  role text not null
)
```

And `src/lib/OrganizationRepository.ts:290-309` already has the necessary write/check operations:

```ts
const upsertMember = Effect.fn(...)
const deleteMember = Effect.fn(...)
const isMember = Effect.fn(...)
```

### Queue-driven sync from D1 -> DO

Membership changes are already emitted before Better Auth writes:

- `src/routes/app.$organizationId.index.tsx:85-95` sends `change: "added"`
- `src/routes/app.$organizationId.members.tsx:108-119` sends `change: "removed"`
- `src/routes/app.$organizationId.members.tsx:139-148` sends `change: "removed"` for leave
- `src/routes/app.$organizationId.members.tsx:168-178` sends `change: "role_changed"`
- `src/lib/Auth.ts:154-161` sends `change: "added"` for initial org creation

Those all go through `src/lib/MembershipSync.ts:6-18`:

```ts
env.Q.send({
  action: "MembershipSync",
  organizationId: input.organizationId,
  userId: input.userId,
  change: input.change,
})
```

The worker queue consumer then re-checks D1 before touching the DO in `src/worker.ts:232-283`:

```ts
const d1Member = yield* repository.getMemberByUserAndOrg({
  userId: notification.userId,
  organizationId: notification.organizationId,
});
```

If aligned, it wakes the DO and calls `onMembershipChanged(...)`.

The DO handler in `src/organization-agent.ts:389-408` upserts or deletes the local row:

```ts
yield* input.change === "removed"
  ? repo.deleteMember(input.userId)
  : repo.upsertMember({ userId: input.userId, role: input.role });
```

## Main Gap

Today `authorizeAgentRequest()` only proves:

- the request has a valid Better Auth session
- `session.activeOrganizationId === agentName`

It does not prove D1 still has a matching `Member` row for that user/org at connect time.

That means a revoked member with a stale `activeOrganizationId` can still open the socket. Callable auth will fail later against the DO-local `Member` table, but the handshake itself is not yet authoritative.

## Recommended Design

Use a hybrid approach:

1. authoritative D1 membership check at connect/request time
2. DO-local membership cache for cheap per-callable checks
3. queue sync to keep long-lived sockets accurate after membership changes

### 1. Tighten `authorizeAgentRequest()`

After the existing session and `activeOrganizationId` check, also query D1 via `Repository.getMemberByUserAndOrg({ userId, organizationId: agentName })`.

If no member row exists, return `403` immediately.

This makes the Worker the source of truth at the handshake boundary and fixes the stale-session problem.

### 2. Keep `authorizeConnection()` exactly where it is

Callable methods should still authorize from the DO-local cache, not by hitting D1 every RPC.

That preserves the good part of the current design:

- cheap checks inside a hot DO
- no D1 round-trip per invoice operation
- queue-driven revocation/update for already-connected users

### 3. Keep queue sync for revocation and role changes

The queue remains responsible for updating the DO after the connection is already open:

- member removed
- member added elsewhere
- role changed

That is what closes the gap between “authorized when connected” and “still authorized now”.

## `OrganizationDomain.ts` Recommendation

Yes, `src/lib/OrganizationDomain.ts` should get a schema for the DO-local member row.

But it should not reuse `src/lib/Domain.ts`'s `Member` schema directly.

`Domain.Member` is the D1 row shape:

```ts
{
  id,
  userId,
  organizationId,
  role,
  createdAt,
}
```

The org-agent sqlite row is a different shape:

```ts
{
  userId,
  role,
}
```

So the DO domain model should be a distinct schema, something like:

```ts
export const AgentMember = Schema.Struct({
  userId: Domain.UserId,
  role: Domain.MemberRole,
});
export type AgentMember = typeof AgentMember.Type;
```

I would keep the schema name distinct even if the SQL table stays named `Member`, because this is a cache entry scoped to one organization DO, not the canonical D1 membership row.

## `OrganizationRepository` Recommendation

For the current requirement, the repo already has the minimum useful surface:

- `upsertMember`
- `deleteMember`
- `isMember`

That is enough for boolean callable auth.

Only add read methods if we actually need them. The most likely future addition is:

- `findMember(userId)` returning `Option<OrganizationDomain.AgentMember>`

That would be useful if callables later care about role or if we want better debug tooling. But it is not required for the current member-only authorization check.

## Suggested Implementation Order

1. update `authorizeAgentRequest()` to verify membership in D1, not just `activeOrganizationId`
2. keep `authorizeConnection()` as the per-callable DO-local membership gate
3. add `AgentMember` schema to `src/lib/OrganizationDomain.ts`
4. optionally make `OrganizationRepository.upsertMember()` accept that schema shape directly
5. optionally add queue retry delay (`message.retry({ delaySeconds })` or `retry_delay`) for more explicit backoff

## Bottom Line

The design direction is correct, and the codebase is already mostly there.

The durable object should authorize callables from its local membership cache keyed by the authenticated connection user. The worker should still perform one authoritative D1 membership check at connect/request time. Queue sync then keeps the cache correct over time, and Durable Object sqlite persistence handles wake/hibernate correctly.

That gives us:

- correct first connection behavior
- correct live revocation behavior
- cheap per-callable checks
- no role complexity in callables yet
