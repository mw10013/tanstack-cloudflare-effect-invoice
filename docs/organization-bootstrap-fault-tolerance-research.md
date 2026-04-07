# Organization Bootstrap Fault Tolerance Research

## Problem

The current first-user bootstrap path is not fault tolerant.

Observed symptom: a freshly logged-in user can reach the organization agent before the DO-local `Member` cache has been updated, producing:

```txt
Forbidden: userId=... not in Member table
```

The local reason is in [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L121-L161):

1. `databaseHooks.user.create.after` runs after user creation
2. it calls `organizationApiCreate(...)`
3. it backfills `activeOrganizationId` on sessions
4. only then does it send the `MembershipSync` queue message

That means the queue message is last in the chain, after Better Auth has already created the org/member rows.

## Current Local Flow

Current bootstrap logic in [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L121-L191):

```ts
databaseHooks: {
  user: {
    create: {
      after: (user) =>
        runEffect(
          Effect.gen(function* () {
            const org = yield* Effect.tryPromise(() =>
              organizationApiCreate({ body: { ..., userId: user.id } }),
            );
            yield* repository.initializeActiveOrganizationForUserSessions({
              organizationId,
              userId,
            });
            yield* Effect.tryPromise(() =>
              queue.send({
                action: "MembershipSync",
                organizationId,
                userId,
                change: "added",
              }),
            );
          }),
        ),
    },
  },
}
```

Also note the session ordering in the same file: [src/lib/Auth.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Auth.ts#L166-L191) tries to set `activeOrganizationId` during `session.create.before`, but for the very first session the organization does not exist yet, so the hook has to be repaired later with `initializeActiveOrganizationForUserSessions(...)`.

That is the first sign the flow is split across phases rather than owned atomically by one application-level orchestration.

## Better Auth Findings

### 1. User signup is transactional, but DB after-hooks are post-transaction

Better Auth signup runs inside `runWithTransaction(...)`.

From [refs/better-auth/packages/better-auth/src/api/routes/sign-up.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/api/routes/sign-up.ts#L181-L181):

```ts
return runWithTransaction(ctx.context.adapter, async () => {
```

And database `create.after` hooks are queued for after the transaction commits.

From [refs/better-auth/packages/better-auth/src/db/with-hooks.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/db/with-hooks.ts#L60-L67):

```ts
const toRun = hook[model]?.create?.after;
if (toRun) {
  await queueAfterTransactionHook(async () => {
    await toRun(created as any, context);
  });
}
```

Better Auth's own release notes are explicit.

From [refs/better-auth/docs/content/blogs/1-5.mdx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/docs/content/blogs/1-5.mdx#L774-L778):

```md
Database "after" hooks ... now execute after the transaction commits, not during it.
If your plugin relies on after hooks running inside the transaction for additional atomic database writes, you'll need to use the adapter directly within the main operation instead.
```

So `databaseHooks.user.create.after` is inherently the wrong place for a queue-first invariant.

### 2. `createOrganization` is a separate org API, not part of user creation

Better Auth's public organization API is a separate endpoint.

From [refs/better-auth/docs/content/docs/plugins/organization.mdx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/docs/content/docs/plugins/organization.mdx#L71-L114):

```md
POST /organization/create
...
- With session headers: userId is silently ignored.
- Without session headers (Server-side only): The organization is created for the user specified by userId.
```

That matches what we are doing now: server-side call without session headers, passing `userId`.

### 3. `createOrganization` does multiple writes inline

From [refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts#L179-L278), the route does this in order:

1. create organization
2. create owner member
3. maybe create default team
4. run `afterCreateOrganization`
5. set active organization on the session

Excerpt:

```ts
const organization = await adapter.createOrganization(...);
...
member = await adapter.createMember(data);
...
if (options?.organizationHooks?.afterCreateOrganization) {
  await options?.organizationHooks.afterCreateOrganization({
    organization,
    user,
    member,
  });
}

if (ctx.context.session && !ctx.body.keepCurrentActiveOrganization) {
  await adapter.setActiveOrganization(..., organization.id, ...);
}
```

Important: this route is not wrapped in `runWithTransaction(...)` the way sign-up is. At least in the route implementation, there is no single outer transaction around all those steps.

### 4. Better Auth does provide org lifecycle hooks

Docs: [refs/better-auth/docs/content/docs/plugins/organization.mdx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/docs/content/docs/plugins/organization.mdx#L168-L190)

```ts
organizationHooks: {
  beforeCreateOrganization: async ({ organization, user }) => { ... },
  afterCreateOrganization: async ({ organization, member, user }) => { ... },
}
```

Source types: [refs/better-auth/packages/better-auth/src/plugins/organization/types.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/plugins/organization/types.ts#L374-L396)

These hooks are cleaner than `databaseHooks.user.create.after` because they run in the organization flow and give direct access to `organization.id` and `member`.

But they still do not solve queue-first by themselves, because `afterCreateOrganization` runs after the org and member already exist.

### 5. `organizationId` is not exposed by the public API before creation

Public docs for `createOrganization` do not expose an `id` input. The documented request body is `name`, `slug`, `logo`, `metadata`, optional `userId`, and `keepCurrentActiveOrganization`: [organization docs](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/docs/content/docs/plugins/organization.mdx#L76-L102).

Internally, though, Better Auth's organization schema has a generated `id`, and the adapter allows caller-supplied IDs:

From [refs/better-auth/packages/better-auth/src/plugins/organization/schema.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/plugins/organization/schema.ts#L292-L301):

```ts
export const organizationSchema = z.object({
  id: z.string().default(generateId),
  name: z.string(),
  slug: z.string(),
  ...
});
```

From [refs/better-auth/packages/better-auth/src/plugins/organization/adapter.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/plugins/organization/adapter.ts#L60-L71):

```ts
const organization = await adapter.create({
  model: "organization",
  data: { ...data.organization, ... },
  forceAllowId: true,
});
```

And `beforeCreateOrganization` can merge arbitrary fields into `orgData` before `adapter.createOrganization(...)`: [crud-org.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts#L159-L184).

So there is an internal path to force an ID. But it is not part of the public `createOrganization` contract.

## Why The Current Hook Is Not Fault Tolerant

The failure modes are straightforward.

### Case 1: org creation succeeds, queue send fails

Current order:

1. user transaction commits
2. `databaseHooks.user.create.after` runs
3. `organizationApiCreate(...)` writes org/member rows
4. `initializeActiveOrganizationForUserSessions(...)` updates sessions
5. `queue.send(MembershipSync)` fails

Result:

- D1 says the user owns the organization
- the session points at that organization
- the DO-local `Member` cache never hears about it
- first callable can fail with `not in Member table`

This is exactly the invariant break we are seeing.

### Case 2: first agent RPC beats queue processing

Even when queue send succeeds, it is async. So the first websocket/RPC can arrive before the queue consumer wakes the org DO and calls `onMembershipChanged(...)`.

That is a race, not permanent corruption, but it still breaks the user-visible flow.

### Case 3: `afterCreateOrganization` is cleaner, but still not queue-first

Moving the queue send into Better Auth `organizationHooks.afterCreateOrganization` would give us direct access to `organization.id` and `member.userId`.

But the ordering would still be:

1. org/member written
2. hook runs
3. queue send happens

So it is still not fault tolerant against queue send failure.

## Can We Send The Queue Message Before `createOrganization()`?

### Short answer

Not with Better Auth's public API alone.

To send queue first, the producer needs:

- `organizationId`
- `userId`
- change type (`added`)

We have `userId`. We do not have `organizationId` until Better Auth creates the org.

### The murky internal possibility

There is an implementation-detail path:

1. use `organizationHooks.beforeCreateOrganization`
2. inject a caller-chosen `id`
3. rely on internal merge behavior plus `forceAllowId: true`

That would make queue-first possible in theory.

But it has three problems:

1. it is not documented public API behavior
2. it couples us to Better Auth internals
3. we still need some way for the caller to know the exact ID before calling `createOrganization()`

So this looks more like a hack than a solid foundation.

## Practical Options

### Option 1: Keep Better Auth org creation, make auth tolerant of cache lag

Meaning:

- keep using Better Auth to create org/member/session state
- keep queue sync to update the DO-local cache
- make agent authorization fall back to D1 when the local `Member` row is missing

Pros:

- smallest app change
- fixes both queue lag and first-call race
- does not depend on Better Auth internals

Cons:

- the DO-local cache is no longer the sole source of truth
- first miss pays a D1 read
- does not make the queue path itself fully fault tolerant; it just stops auth from depending on perfect cache propagation

This is the pragmatic option.

### Option 2: Move bootstrap out of `databaseHooks.user.create.after`

Meaning:

- stop creating the default organization from the user DB after-hook
- own the orchestration in application code where we can choose ordering, retries, and idempotency explicitly

Pros:

- clear ownership
- easier to reason about retries and failures
- can be made queue-first if we also own ID generation / writes

Cons:

- hard with the current magic-link flow because [src/lib/Login.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-invoice/src/lib/Login.ts#L16-L31) just calls `auth.api.signInMagicLink(...)`; there is no obvious application-level “user created, now provision org” hook in our own code path before the session is used
- risks reimplementing Better Auth organization behavior

This is the clean architecture option, but it is a bigger redesign.

### Option 3: Use Better Auth internal hook behavior to pre-assign org IDs

Meaning:

- generate `organizationId` ourselves
- force it through `beforeCreateOrganization`
- send queue before calling `createOrganization()`

Pros:

- closest to the queue-first invariant you want

Cons:

- undocumented
- brittle across Better Auth upgrades
- still awkward to wire from the current post-user-create hook shape

This is technically interesting, but not a safe recommendation.

### Option 4: Move from DB hook to `organizationHooks.afterCreateOrganization`

Meaning:

- leave org creation in Better Auth
- move sync logic nearer to org creation

Pros:

- cleaner than `databaseHooks.user.create.after`
- direct access to `organization.id` and `member`

Cons:

- still after-the-fact
- still not queue-first
- if the hook throws, the route can fail after some writes already happened

This improves structure, not fault tolerance.

## Recommendation

If the requirement is strict fault tolerance for org bootstrap, then yes: the current `databaseHooks.user.create.after -> createOrganization -> queue.send` chain is fundamentally the wrong shape.

My recommendation:

1. Do not try to make `databaseHooks.user.create.after` queue-first.
2. Do not rely on undocumented Better Auth ID injection as the primary design.
3. Treat Better Auth org creation as authoritative D1 state.
4. Make agent auth resilient to missing/stale DO cache by falling back to D1 membership on cache miss.
5. Keep queue sync as the fast path / live-update mechanism.

If, later, we want a truly queue-first bootstrap flow, that likely means moving default-org provisioning out of Better Auth's post-user-create database hook and into application-owned orchestration where we own ID generation and write ordering.

## Bottom Line

Yes, I see the issue.

The current bootstrap path is not fault tolerant because it depends on a post-transaction user hook to call a separate org-creation API and only then emits the membership sync message. Better Auth's public org API does not give us `organizationId` before creation, so “send queue first, then call `createOrganization()`” is not cleanly supported.

The safe conclusion is:

- current hook chain is structurally weak
- `afterCreateOrganization` is cleaner but still not queue-first
- pre-assigning org IDs is possible only through internal behavior
- the practical fix is to make auth tolerate DO cache misses, or redesign bootstrap ownership entirely
