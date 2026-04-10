# `user.create.after` Hook Fault Tolerance Research

## Problem

`src/lib/Auth.ts:127-174` provisions a new user via `databaseHooks.user.create.after`:

1. `organizationApiCreate({ body: { ..., userId } })` — creates `Organization` row + `Member` row in D1
2. `repository.initializeActiveOrganizationForUserSessions({ organizationId, userId })` — backfills `activeOrganizationId` on existing sessions
3. `organizationAgent.idFromName(organizationId)` + `stub.setName(organizationId)` — initializes the DO instance name
4. `queue.send({ action: "FinalizeMembershipSync", organizationId, userId, change: "added" })` — durable safety-net message
5. `stub.syncMembership({ userId, change: "added" })` — eager DO-local Member row sync

These run **after** the `User` row (and any plugin-related rows like `Account`) are already committed to D1. If the worker crashes between steps, D1 is left in a corrupted state: a real user with no Organization, no Member, no active session org, no DO state, and no queue message to repair them. The "enqueue → operation → finalize" recovery pattern (see `src/organization-agent.ts:520-549` and `src/lib/Q.ts:103-113`) is bypassed for the most damaging failure window — between user write and `queue.send`.

## How Better Auth Actually Handles This

### Magic-link `signUp` flow

`refs/better-auth/packages/better-auth/src/plugins/magic-link/index.ts:389-422`:

```ts
let user = await ctx.context.internalAdapter
  .findUserByEmail(email)
  .then((res) => res?.user);

if (!user) {
  if (!opts.disableSignUp) {
    const newUser = await ctx.context.internalAdapter.createUser({
      email: email,
      emailVerified: true,
      name: name || "",
    });
    isNewUser = true;
    user = newUser;
    ...
  }
}
...
const session = await ctx.context.internalAdapter.createSession(user.id);
```

`internalAdapter.createUser` is a thin wrapper over `createWithHooks` that runs `databaseHooks.user.create.before`, writes the row, then queues `databaseHooks.user.create.after` (see `refs/better-auth/packages/better-auth/src/db/with-hooks.ts:18-71`). The magic-link plugin writes nothing extra in the `Account` table for new users — it only mints an emailVerified user + session.

### `createWithHooks` lifecycle (`refs/better-auth/packages/better-auth/src/db/with-hooks.ts:18-71`)

```ts
for (const hook of hooks) {
  const toRun = hook[model]?.create?.before;
  if (toRun) {
    const result = await toRun(actualData, context);
    if (result === false) return null;
    if ("data" in result) actualData = { ...actualData, ...result.data };
  }
}

created = await (await getCurrentAdapter(adapter)).create({ model, data: actualData, forceAllowId: true });

for (const hook of hooks) {
  const toRun = hook[model]?.create?.after;
  if (toRun) {
    await queueAfterTransactionHook(async () => {
      await toRun(created, context);
    });
  }
}
```

Key facts:

- `before` hooks run synchronously **before** the row is written. Returning `false` aborts. Returning `{ data }` lets you mutate the payload.
- `after` hooks are queued via `queueAfterTransactionHook` and drained at the end of the request scope.

### `queueAfterTransactionHook` (`refs/better-auth/packages/core/src/context/transaction.ts:43-136`)

```ts
export const runWithAdapter = async <R>(adapter, fn) => {
  ...
  const pendingHooks: Array<() => Promise<void>> = [];
  let result: Awaited<R>;
  let error: unknown;
  let hasError = false;
  try {
    result = await als.run({ adapter, pendingHooks }, fn);
  } catch (err) { error = err; hasError = true; }
  for (const hook of pendingHooks) {
    await hook();
  }
  if (hasError) throw error;
  return result!;
};
```

`refs/better-auth/packages/better-auth/src/auth/base.ts:110` wraps every request handler in `runWithAdapter`, so `pendingHooks` drains right before the response is returned. **Even if the request handler threw**, after-hooks still run. If a pending hook throws, the loop bails and the error propagates — the response is whatever Better Auth's outer error handler decides, but the row is already in the DB.

### D1 has no transactions — and "native D1 support" does not change that

`refs/better-auth/packages/kysely-adapter/src/d1-sqlite-dialect.ts:63-79`:

```ts
async beginTransaction(): Promise<void> {
  throw new Error(
    "D1 does not support interactive transactions. Use the D1 batch() API instead.",
  );
}
```

So `runWithTransaction` (the variant that uses `adapter.transaction(...)`) is unavailable. Every Better Auth write under D1 is autocommitted. There is no rollback path. This is the structural reason this hook is fragile.

#### Are we using Better Auth's "native D1 support"? Yes — and it does not help.

`src/lib/Auth.ts:41-44, 107-112` passes `database: env.DB` directly. `refs/better-auth/packages/kysely-adapter/src/dialect.ts:147-153` auto-detects this via the duck-type check `"batch" in db && "exec" in db && "prepare" in db` and constructs a `D1SqliteDialect`. This is the path Better Auth's v1.5 blog post calls "first-class D1 support" (`refs/better-auth/docs/content/blogs/1-5.mdx:524-541`), introduced by PR [better-auth/better-auth#7519](https://github.com/better-auth/better-auth/pull/7519).

The blog post says:

> The built-in D1 dialect handles query execution, batch operations, and introspection through D1's native API. Note that D1 does not support interactive transactions — Better Auth uses D1's `batch()` API for atomicity instead.

**The second sentence is misleading.** Inspecting the D1 dialect (`refs/better-auth/packages/kysely-adapter/src/d1-sqlite-dialect.ts`), the only place `db.batch()` is invoked is inside the `D1SqliteIntrospector` for migration-time `pragma_table_info` lookups (line 166). It is **not** wired into per-request CRUD writes. PR [better-auth/better-auth#7517](https://github.com/better-auth/better-auth/pull/7517) (the underlying dialect PR) describes the same thing: *"no interactive transactions or streaming (use db.batch())"* — meaning the dialect itself does not use batches; it advises callers to use `db.batch()` if they want atomicity.

The auto-detection in `createKyselyAdapter` (`refs/better-auth/packages/kysely-adapter/src/dialect.ts:155-159`) returns `transaction: undefined` for D1, and `kysely-adapter.ts:641` then sets `transaction: false` on the resulting adapter. This is the resolution of [#4732](https://github.com/better-auth/better-auth/issues/4732) ("Defaulting Kysely `transaction` to true with 1.3.10+ breaks Cloudflare D1") — Better Auth opts D1 *out* of the transaction system entirely. The `Adapter.transaction(cb)` feature added in [#4062](https://github.com/better-auth/better-auth/issues/4062) ("feat: database transaction support") explicitly lists "opt-out transactions (D1 Compatibility)" in its TODO and ships with D1 disabled.

I checked every release between v1.5.1 (our pinned version) and v1.6.2 (latest as of 2026-04-09): none add batch-backed atomicity to D1 writes. The only D1 changelog entry is "Removed deprecated `numUpdatedOrDeletedRows` from D1 dialect" in v1.6.0. There are no open PRs proposing to wire D1 `batch()` into the per-request adapter.

**Conclusion**: upgrading Better Auth to 1.6.2 or any other current version does not give us atomic multi-row writes on D1. "Native D1 support" means "auto-detected Kysely dialect", not "transactional writes". The fault tolerance picture below is unchanged by version bumps. If we wanted batch-backed atomicity we would have to write our own adapter (or open a PR to Better Auth that exposes a transaction wrapper that pipelines pending writes through `D1Database.batch()` — non-trivial because the adapter API is per-statement, not deferred).

### Where membership lives in Better Auth

There is no separate "add member" call when an org is created server-side. `refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:179-219`:

```ts
const organization = await adapter.createOrganization({ ... });

let data = {
  userId: user.id,
  organizationId: organization.id,
  role: ctx.context.orgOptions.creatorRole || "owner",
};
if (options?.organizationHooks?.beforeAddMember) { ... }
member = await adapter.createMember(data);
if (options?.organizationHooks?.afterAddMember) { ... }
```

Calling `auth.api.createOrganization({ body: { name, slug, userId } })` writes both the `Organization` and `Member` rows in two sequential adapter calls (no transaction). There is **no public API** for "add the creator as a member" separately — `createOrganization` is the only entrypoint that mints the owner Member row. `addMember` (`refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-members.ts`) exists but expects the org to already exist.

Important corollaries:

- `database.hooks` (`user`/`session`/`account`) **do not** fire for `Member`, `Organization`, or `Invitation` writes — those have their own `organizationHooks` (see `refs/better-auth/docs/content/docs/plugins/organization.mdx:153-294`).
- `organizationLimit: 1` is enforced inside `createOrganization` (`refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:134-147`). Re-running `createOrganization` for the same user fails with `YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS`.
- The slug check (`findOrganizationBySlug`) fails with `ORGANIZATION_ALREADY_EXISTS` on a re-run, so naive retries also blow up. Any retry path must short-circuit when the user already owns an org.

## The Failure Window

```
+-------------------------+   t0
| internalAdapter         |
| .createUser()           |
| → User row in D1        |
+-------------------------+
            |
+-------------------------+   t1   <-- response not yet sent; pending hooks draining
| user.create.after hook  |
|   1. createOrganization |   <-- writes Organization + Member (2 sep calls, no tx)
|   2. init session orgs  |
|   3. DO setName         |
|   4. queue.send()       |   <-- THIS is where the durable safety net begins
|   5. stub.syncMembership|
+-------------------------+
            |
            v
   queueAfterTransactionHook
   loop continues / response returned
```

Any failure between t0 and step 4 leaves D1 with a `User` row but no `Organization`, no `Member`, possibly a half-written `Member` (e.g. org row written, member row not), no DO state, and **no queue message** to repair anything later. The user can sign in again (the magic-link `findUserByEmail` branch will skip `createUser`), but every subsequent request will hit `getOwnerOrganizationByUserId` returning `Option.none`, and the session will have `activeOrganizationId = undefined` (`src/lib/Auth.ts:178-201`).

There is also a partial-write window inside `createOrganization` itself: the `Organization` row is written first (`adapter.createOrganization`), then `adapter.createMember` is called separately. A crash between those two calls leaves a dangling `Organization` with no owner. A retry will fail the slug-uniqueness check.

## Available Levers

### A. `databaseHooks.user.create.before`

Runs **before** the `User` row is written. Can mutate payload or abort. **Does not** see a freshly-created userId — Better Auth's default ID generator runs inside `adapter.create` after the `before` hook returns. That's fine: `email` is unique by schema and is already in the payload by the time the hook fires.

`internalAdapter.createUser` (`refs/better-auth/packages/better-auth/src/db/internal-adapter.ts:122-140`) sets `email: user.email?.toLowerCase()` *before* calling `createWithHooks`, which then passes `actualData` to the before hook (`refs/better-auth/packages/better-auth/src/db/with-hooks.ts:30-34`). So the hook reliably sees the lowercased email and can use it as the enqueue key. The consumer resolves `email → user → owner-org` via `Repository.getUser(email)`.

This is the only place we can enqueue with a guarantee that the queue message exists **before** the user row is committed.

#### `createUser` is not idempotent at the adapter level

`internalAdapter.createUser` is a thin wrapper over `createWithHooks` → plain `adapter.create({ model: "user", data, forceAllowId: true })`. No existence check. Email is unique in the User schema, so a second call with the same email throws a unique-constraint violation.

The magic-link plugin makes the flow *appear* idempotent at the plugin level by calling `findUserByEmail` first (`refs/better-auth/packages/better-auth/src/plugins/magic-link/index.ts:389-396`). That's exactly the trap: a retry after a failed `user.create.after` will hit the `findUserByEmail` branch, skip `createUser` entirely, and **never re-fire the after hook**. Plugin-level idempotency on `createUser` is what makes the after-hook failure permanent rather than self-healing.

### B. `databaseHooks.user.create.after`

Runs after commit, before the response. Currently used. Best-effort eager provisioning. Stays as-is — failures here are no longer fatal because the durable safety net is the queue message enqueued in the `before` hook.

### C. Queue (`Q`) handler

The existing pattern in `src/lib/Q.ts` for `FinalizeMembershipSync` (idempotent, reads truth from D1, ack on success / retry on failure) is the model. A new sibling handler `FinalizeUserProvisioning` performs the **full** provisioning step idempotently: ensure org exists → ensure Member exists → ensure session backfill → ensure DO sync.

## Implementation Plan

The plan: enqueue a `FinalizeUserProvisioning` message keyed by email in the `before` hook. Leave the `after` hook untouched as best-effort eager provisioning. Add a queue handler that re-runs the full provisioning chain idempotently.

### Step 1 — Add the queue message schema

In `src/lib/Q.ts`, add a new message variant alongside the existing ones:

```ts
const FinalizeUserProvisioningQueueMessage = Schema.Struct({
  action: Schema.Literals(["FinalizeUserProvisioning"]),
  email: Domain.User.fields.email,
});

export const QueueMessage = Schema.Union([
  R2PutObjectNotification,
  FinalizeInvoiceDeletionQueueMessage,
  FinalizeMembershipSyncQueueMessage,
  FinalizeUserProvisioningQueueMessage,
]);
```

Email is the only field — the consumer resolves `email → user → owner-org` from D1 truth.

### Step 2 — Enqueue from `databaseHooks.user.create.before`

Add a `before` hook to `src/lib/Auth.ts:125-175` that enqueues before the row is written:

```ts
databaseHooks: {
  user: {
    create: {
      before: (user) =>
        runEffect(
          Effect.gen(function* () {
            if (user.role !== "user") return;
            yield* Effect.logInfo("databaseHooks.user.create.before", {
              email: user.email,
            });
            yield* Effect.tryPromise(() =>
              queue.send({
                action: "FinalizeUserProvisioning" as const,
                email: user.email,
              }),
            );
          }),
        ),
      after: /* unchanged */,
    },
  },
  session: { /* unchanged */ },
}
```

The hook signature follows the same `(payload) => runEffect(...)` shape as the existing hooks. The hook returns `void` (not `false` or `{ data }`), so Better Auth proceeds with the `User` row write. If `queue.send` throws, the hook propagates the error and the row is never written — the magic-link verify endpoint returns an error and the user retries.

The `user.role !== "user"` guard mirrors the existing after-hook exactly — same filter, same semantics.

### Step 3 — Leave the `after` hook as-is

The current after-hook in `src/lib/Auth.ts:127-174` continues to do the eager 5-step provisioning. Failures inside it remain swallowed by `runEffect`'s error handling (per existing behavior). The queue handler is the durable backstop — any failure mode the after-hook hits will be re-attempted by the queue.

Per-user happy path: `before` enqueues → user row written → `after` does eager provisioning → request returns → queue processes the message → consumer reads "already provisioned" → no-op ack. The eager path keeps first-login latency unchanged.

### Step 4 — Where the handler lives

This is the architectural decision. The handler needs:

1. `Repository` — to look up `getUser(email)` and `getOwnerOrganizationByUserId(userId)`
2. `Auth.api.createOrganization` — to write Organization + Member rows
3. `Auth.api.addMember` — for the partial-recovery branch (org row exists, member row missing)
4. `CloudflareEnv.ORGANIZATION_AGENT` — to get the DO stub
5. The existing `getOrganizationAgentStubTrusted` from `Q.ts` itself

#### Recommendation: handler lives inline in `Q.ts`, alongside the other `process*` functions

Q.ts already owns queue routing and is the natural seam. The cost is that **`Q.ts` must add `Auth` (and its transitive deps `Repository`, `Stripe`, `KV`) to its runtime layer**. Today (`src/lib/Q.ts:132-135`):

```ts
const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  return Layer.mergeAll(envLayer, makeLoggerLayer(env));
};
```

Becomes (mirroring `src/worker.ts:59-76`'s `makeRunEffect`):

```ts
const makeRuntimeLayer = (env: Env) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const kvLayer = Layer.provideMerge(KV.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const stripeLayer = Layer.provideMerge(
    Stripe.layer,
    Layer.merge(repositoryLayer, Layer.merge(d1Layer, kvLayer)),
  );
  const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
  return Layer.mergeAll(authLayer, makeLoggerLayer(env));
};
```

The cost: every queue batch instantiates Stripe + KV + Repository + Auth. Stripe construction is local (just `new StripeClient.Stripe(...)` in `src/lib/Stripe.ts:24-30`, no network), but it does consume `STRIPE_SECRET_KEY` from the config. KV and Repository are thin wrappers. This is a few milliseconds per batch — acceptable.

Caveats:

- **Auth.layer transitively imports `Request`** (`src/lib/Auth.ts:25`). Look for any code path inside `auth.api.createOrganization` or its hooks that reads from `Request` service — if so, the queue runtime needs to provide a synthetic Request or we need to refactor. Spot check: the current `databaseHooks.user.create.after` runs inside an HTTP request scope, so `Request` is available; the queue handler is not in a request scope. Likely fine because `createOrganization` doesn't depend on incoming headers when called with `body.userId`, but verify.
- **Stripe ensure-billing-portal hook** (`src/lib/Auth.ts:204-225`) only runs for `/subscription/*` paths, so it won't trigger from queue-driven `auth.api.createOrganization` calls. Safe.
- **Recursive queue messages**: the queue handler calls `auth.api.createOrganization`, which today does NOT enqueue anything itself. The current `user.create.after` hook is what enqueues `FinalizeMembershipSync` — but the queue handler is invoking `createOrganization`, not `createUser`, so the user.create hooks do not re-fire. No recursion.
- **`runWithAdapter` scope**: `auth.api.createOrganization` triggers `createWithHooks` for the Organization model, which queues `organizationHooks` after the row write. Outside an HTTP request, there is no active `runWithAdapter` store, so `queueAfterTransactionHook` executes hooks immediately (`refs/better-auth/packages/core/src/context/transaction.ts:118-136`). We have no `organizationHooks` configured, so this is a no-op. Safe.

#### Alternatives considered (and rejected)

- **Separate `UserProvisioning` module**: cleaner separation but introduces import cycles (the module needs `Auth`, and exposing the same code path to the after-hook would require Auth to import it back). Defer until the after-hook actually needs to share code with the queue handler — for now, the after-hook stays inline and the queue handler is its own implementation.
- **Method on `Auth` service**: works, but mixes the request-scoped Auth surface with a queue-only operation. Q.ts is the better home because it already owns queue routing.

### Step 5 — Implement `processFinalizeUserProvisioning`

Sketch (in `src/lib/Q.ts`):

```ts
const processFinalizeUserProvisioning = Effect.fn(
  "processFinalizeUserProvisioning",
)(function* (message: typeof FinalizeUserProvisioningQueueMessage.Type) {
  const repository = yield* Repository;
  const userOpt = yield* repository.getUser(message.email);
  if (Option.isNone(userOpt)) {
    yield* Effect.logInfo("finalizeUserProvisioning.userNotFound", {
      email: message.email,
    });
    return;
  }
  const user = userOpt.value;

  const ownerOrgOpt = yield* repository.getOwnerOrganizationByUserId(user.id);
  let organizationId: Domain.Organization["id"];
  if (Option.isSome(ownerOrgOpt)) {
    organizationId = ownerOrgOpt.value.id;
    yield* Effect.logInfo("finalizeUserProvisioning.alreadyProvisioned", {
      userId: user.id,
      organizationId,
    });
  } else {
    const auth = yield* Auth;
    const slug = user.email.replaceAll(/[^a-z0-9]/g, "-").toLowerCase();
    const name = `${user.email.charAt(0).toUpperCase() + user.email.slice(1)}'s Organization`;
    const created = yield* Effect.tryPromise(() =>
      auth.api.createOrganization({ body: { name, slug, userId: user.id } }),
    );
    organizationId = Schema.decodeUnknownSync(Domain.Organization.fields.id)(
      created.id,
    );
  }

  yield* repository.initializeActiveOrganizationForUserSessions({
    organizationId,
    userId: user.id,
  });

  const stub = yield* getOrganizationAgentStubTrusted(organizationId);
  yield* Effect.tryPromise(() =>
    stub.syncMembership({ userId: user.id, change: "added" }),
  );
});
```

Then add the case to `processMessage`:

```ts
case "FinalizeUserProvisioning": {
  return yield* processFinalizeUserProvisioning(message);
}
```

The existing batch loop in `src/lib/Q.ts:137-160` already handles ack/retry/SchemaError and provides the runtime layer — no changes needed there beyond extending `makeRuntimeLayer`.

### Idempotency contract

Each step must be safely re-runnable:

| Step | Idempotent? | Notes |
| --- | --- | --- |
| `getUser(email)` | yes | read |
| `getOwnerOrganizationByUserId(user.id)` | yes | read |
| `auth.api.createOrganization` | guarded | not idempotent on its own (throws `ORGANIZATION_ALREADY_EXISTS` on slug collision), but the `getOwnerOrganizationByUserId` short-circuit above is the guard |
| `initializeActiveOrganizationForUserSessions` | yes | already idempotent (`src/lib/Repository.ts:87-104`) — only updates rows where `activeOrganizationId is null` |
| `stub.syncMembership` | yes | reads D1 truth and aligns DO-local Member table (`src/organization-agent.ts:506-549`) |

### Known limitation: partial write inside `createOrganization`

`auth.api.createOrganization` writes the `Organization` row and the `Member` row as two separate autocommitted statements (`refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:179-219`, no transaction on D1). If the worker dies between those two writes — most plausibly during the eager `after` hook hitting a CPU limit — we end up with an `Organization` row but no `Member` row.

On retry, the queue handler's `getOwnerOrganizationByUserId` check joins through `Member`, so it returns `none` and the handler calls `createOrganization` again. The slug-uniqueness check inside the API hits the existing `Organization` row and throws `ORGANIZATION_ALREADY_EXISTS`. The message retries forever on that user.

We are explicitly **not** handling this in v1. It is rare, bounded to a single user, and manually recoverable by deleting the orphan `Organization` row. If we start observing it, the fix is a catch branch that re-looks up the org by slug and calls `auth.api.addMember({ body: { userId, role: "owner", organizationId } })`.

### Failure handling

The existing batch loop (`src/lib/Q.ts:137-160`):

- Acks on success
- Acks on `SchemaError` (so malformed messages don't loop forever)
- Retries on every other failure

For `FinalizeUserProvisioning`, the user-not-found case (Step 5, `Option.none`) returns successfully → ack. Slug collision against a different user's existing slug would retry forever → wants a DLQ. Defer DLQ wiring until we observe it in practice; today's Q handler retries everything else, which is fine for this message because the worst case is repeated work.

## Open Questions

1. **`role !== "user"` guard timing**: In the existing `after` hook, `user.role === "user"` gates provisioning. When does the admin plugin's default role get assigned — before the `before` hook runs, or in between `before` and `after`? If after, the `before` hook can't gate on role and must always enqueue. The consumer's idempotency makes always-enqueue safe (admin users that gain an owner org via the consumer is undesirable, though), so we want a real answer here. Check `refs/better-auth/packages/better-auth/src/plugins/admin/`.
2. **Slug strategy**: The current slug derivation `email.replaceAll(/[^a-z0-9]/g, "-")` will collide for `u@u.com` and `u-u-com@x.com`. Is the intent to keep this as-is and let `ORGANIZATION_ALREADY_EXISTS` be a real error, or should the provisioning routine append a discriminator (uuid, ts) on collision?
3. **`createOrganization` from queue handler**: Confirm `auth.api.createOrganization({ body: { userId } })` works when called outside any HTTP request scope (no `runWithAdapter` store, no `Request` service). The current `after` hook calls it from inside a request scope; the queue handler will not. The expected behavior is that `queueAfterTransactionHook` executes any inner hooks immediately when no store is active (`refs/better-auth/packages/core/src/context/transaction.ts:118-136`), which is fine since we have no `organizationHooks` configured. Verify there's no other code path that requires `Request` or session headers.
4. **Half-write recovery (org row written but member row not)**: Implement the `ORGANIZATION_ALREADY_EXISTS` catch branch — re-look up the org by slug, check `getMemberByUserAndOrg`, then `auth.api.addMember({ body: { userId, role: "owner", organizationId } })` if missing. The Better Auth `addMember` API (`refs/better-auth/docs/content/docs/plugins/organization.mdx:1177-1199`) is server-only and supports this.
5. **`Auth.layer` in queue runtime**: Does adding `Auth.layer` to the queue handler's runtime introduce any code path that depends on the `Request` service? Spot-check `auth.api.createOrganization` and its hook chain. If yes, either (a) provide a synthetic `Request` to the queue runtime layer, or (b) extract a slimmer auth surface that the queue handler can use without the full request stack.
6. **Dead-letter behavior**: Today's `src/lib/Q.ts:152-157` retries indefinitely on non-schema failures. For `FinalizeUserProvisioning`, a permanently broken message (e.g. slug collision against an unrelated user's existing org) will retry forever. Want a max-retry + DLQ + admin alert? Defer until observed.
7. **DO state on retry**: `stub.setName(organizationId)` and `syncMembership` are both idempotent today. Confirm that double-running them on the recovery path has no observable side effects (broadcasts, workflow starts, etc.). The current `syncMembershipImpl` only writes to the local Member table and reads D1, so this looks fine, but worth verifying against the broadcast/workflow logic in `src/organization-agent.ts`.
8. **Consumer should call `stub.setName` too?** The current `after` hook calls `stub.setName(organizationId)` before `syncMembership` to ensure the DO instance name is set (per the comment in `src/lib/Q.ts:53-55` about workerd issue #2240). The `getOrganizationAgentStubTrusted` helper in Q.ts already does this — confirmed by reading lines 56-64. So the consumer gets `setName` for free.
