# User Provisioning via Cloudflare Workflows — Research

> Sibling doc: `user-create-after-hook-fault-tolerance-research.md` (the queue-only proposal). This doc evaluates a Workflows-based alternative.

## TL;DR

Move the 5-step provisioning chain out of `databaseHooks.user.create.after` into a `UserProvisioningWorkflow` (extends `WorkflowEntrypoint`). Use **`user.id` as the deterministic workflow instance id** — never email. The before-hook only enqueues a `{ email }` queue message; both the after-hook and the queue handler resolve email → user → `user.id` before touching the workflow API, so email is never a workflow id.

Drive the lifecycle with three complementary touchpoints:

- `user.create.before` enqueues a `EnsureUserProvisioning` queue message keyed by email — durable entry point that survives a crash between user-row write and workflow kickoff. Uses the typed `enqueue` helper from `src/lib/Q.ts:38-41`, not the raw queue binding.
- `user.create.after` calls `kickoffOrRestart(env.USER_PROVISIONING_WORKFLOW, user.id, params)` and returns immediately — fire-and-forget. The kickoff helper handles the errored-workflow-restart case (see §3.2). The hook does **not** wait for the workflow.
- The dashboard route loader awaits the workflow's terminal state (via `instance.status()` polling) with a bounded timeout. The wait lives in the loader, not the auth hook, because TanStack Router already gives us a loading state and Suspense boundary for free — see §3.3 / §6 for the rationale and §3.3 for the discarded "after-hook waits" alternative.
- Queue consumer drains `EnsureUserProvisioning` messages: it **first checks the user was actually written** (`Option.isNone(userOpt)` ⇒ ack and return — handles the case where the before-hook fired but the user-row write failed), then runs the same `kickoffOrRestart` call.

The UI gate works as follows. The dashboard loader calls a `getProvisioningStatus(userId)` server fn. The server fn fast-paths on D1 (`getOwnerOrganizationByUserId` returns `Some` ⇒ done) and only falls back to `instance.status()` for `errored` detection — at which point the loader can call `instance.restart()` inline for self-healing. Cleanup is automatic — Workflows retain completed instance state for **30 days on Paid / 3 days on Free** (`refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx:35`). After retention the instance is gone and `.get()` throws `instance.not_found` (verified in `refs/workers-sdk/packages/workflows-shared/src/binding.ts:91-94`).

The project already uses Workflows (`InvoiceExtractionWorkflow`, `wrangler.jsonc:45-51`) so the binding/wrangler/runtime patterns are in place.

---

## 1. Why the queue-only proposal is a bad fit

The current sibling doc proposes a `FinalizeUserProvisioning` queue handler that re-runs the entire 5-step chain. Reviewing it against what Workflows give us:

1. **Manual idempotency for every step.** The queue handler hand-rolls "check D1 for org, then call `createOrganization`, then call `syncMembership`...". Workflows already cache step results — once `step.do("createOrganization", ...)` succeeds, a retry replays from the next step. We get idempotency-by-replay for free.
2. **`Auth.layer` in the queue runtime.** The queue handler needs to construct `Auth → Stripe → KV → Repository` on every batch (sibling doc §Step 4 discusses the cost). Workflows are their own Worker entrypoint with their own runtime layer; the auth surface only gets paid for during actual provisioning.
3. **No observability.** Queue retries are opaque. Workflow runs have per-step status, errors, retry counts, and a debug visualizer (`refs/cloudflare-docs/src/content/docs/workflows/build/visualizer.mdx`).
4. **Synchronous "is provisioning done?" is hard.** With queue-only, the after-hook either waits (with no API surface to wait on) or returns and the frontend has nothing to poll. With Workflows, `instance.status()` is a first-class API.
5. **Half-write inside `createOrganization`** (sibling doc §Known limitation): the queue handler retries forever on `ORGANIZATION_ALREADY_EXISTS`. In a Workflow, the `createOrganization` step can catch this exact error and `step.do("addMember", ...)` instead — this is just normal control flow.

**Conclusion**: Workflows are a strict upgrade for this use case if we still keep the queue message as the "ensure-started" entry point.

---

## 2. Cloudflare Workflows — primer (only what we need)

### 2.1 Definition

A Workflow is a class extending `WorkflowEntrypoint<Env, Params>`. The `run` method receives a `WorkflowEvent<Params>` (immutable, with `payload`, `timestamp`, `instanceId`) and a `WorkflowStep` (`refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:18-36`, `events-and-parameters.mdx:194-202`). State must be threaded through `step.do` return values; in-memory variables are lost on hibernation (`rules-of-workflows.mdx:123-216`).

The project already has one (`src/invoice-extraction-workflow.ts:35-173`), wired via `agents/workflows`'s `AgentWorkflow` wrapper. For user provisioning we want a **plain `WorkflowEntrypoint`** because the org agent does not exist yet — `AgentWorkflow` requires an agent context.

### 2.2 Wrangler binding

`wrangler.jsonc:45-51` already declares one workflow. Add a second:

```jsonc
"workflows": [
  {
    "name": "invoice-extraction-workflow",
    "binding": "INVOICE_EXTRACTION_WORKFLOW",
    "class_name": "InvoiceExtractionWorkflow"
  },
  {
    "name": "user-provisioning-workflow",
    "binding": "USER_PROVISIONING_WORKFLOW",
    "class_name": "UserProvisioningWorkflow"
  }
]
```

The class must also be re-exported from `src/worker.ts` (mirroring `worker.ts:25` re-export of `InvoiceExtractionWorkflow`).

### 2.3 Workers-API surface (cited)

From `refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:447-475`:

```ts
declare abstract class WorkflowInstance {
  public id: string;
  public pause(): Promise<void>;
  public resume(): Promise<void>;
  public terminate(): Promise<void>;
  public restart(): Promise<void>;
  public status(): Promise<InstanceStatus>;
}
```

`InstanceStatus` (`workers-api.mdx:557-575`):

```ts
type InstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};
```

Key API calls:

- `env.WF.create({ id, params })` — `workers-api.mdx:316-340`. **Throws if `id` already exists** within the retention window.
- `env.WF.createBatch([{ id, params }, ...])` — `workers-api.mdx:378-402`. **Idempotent.** Existing-ID instances are silently skipped: *"this operation is idempotent and will not fail if an ID is already in use. If an existing instance with the same ID is still within its retention limit, it will be skipped and excluded from the returned array."*
- `env.WF.get(id)` — `workers-api.mdx:404-411`. Throws if id does not exist.
- `instance.status()` — returns the snapshot above. Polling this is the *only* way to await completion from outside the workflow.

### 2.4 Steps, retries, errors

`step.do(name, config?, callback)` (`workers-api.mdx:76-131`). Default retry config (`sleeping-and-retrying.mdx:56-66`):

```ts
{ retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes" }
```

`NonRetryableError` from `cloudflare:workflows` aborts retries (`sleeping-and-retrying.mdx:106-135`). `try/catch` around a `step.do` lets the workflow continue past a non-retryable failure (`sleeping-and-retrying.mdx:137-169`), which is the lever we use for the half-write recovery branch.

Step results must be JSON-serializable and ≤1 MiB (`limits.mdx:26`). Step name is the cache key — must be deterministic (`rules-of-workflows.mdx:321-362`).

### 2.5 Limits to be aware of

`refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx`:

| Concern | Free | Paid |
|---|---|---|
| Compute time per step | 10 ms | 30 s default / configurable to 5 min |
| Wall clock per step | unlimited (I/O doesn't count) | unlimited |
| Step result size | 1 MiB | 1 MiB |
| Max steps per instance | 1,024 | 10,000 (configurable to 25,000) |
| Concurrent **running** instances | 100 | 10,000 |
| Instance creation rate | 100/s (HTTP 429 above) | 100/s |
| **Retention of completed instances** | **3 days** | **30 days** |
| Max instance id | 100 chars | 100 chars |

Concurrency note (`limits.mdx:62-66`): only `running` instances count toward the cap. `waiting`/`queued` don't. User provisioning is short-lived and entirely `running`, so we'll only ever consume one slot per concurrent signup — fine.

User id length: better-auth ids are ~36 chars (uuid-style). Well under the 100-char instance id limit. Safe to use directly as the workflow id.

### 2.6 Lifecycle and cleanup

**Who cleans up?** Cloudflare. There is no manual cleanup, no DELETE API surface in the Workers binding (`workers-api.mdx:447-475` lists pause/resume/terminate/restart/status/sendEvent — no delete). Completed instance state is retained until the retention window expires, then it's gone. After expiry, `env.WF.get(id)` throws an error matching `instance.not_found` (verified in `refs/workers-sdk/fixtures/workflow/tests/index.test.ts:96-103`).

**Implication for our design**: A `UserProvisioningWorkflow` instance with `id = user.id` will be queryable for 30 days post-completion on Paid. That's plenty for "user just signed in, frontend needs to know if provisioning is done". After 30 days, if any code still tries to look up the workflow it'll throw — we should treat `instance.not_found` as "done long ago" by joining against D1 (org exists for that user) before falling back to the workflow query. See §6.

---

## 3. Triggering and waiting patterns

### 3.1 The fundamental constraint

`env.WF.create()` and `createBatch()` **return as soon as the instance is enqueued**, with status typically `queued` or `running` — not `complete`. There is **no documented "create and await completion" call**. The fixture test confirms this (`refs/workers-sdk/fixtures/workflow/tests/index.test.ts:51-82`):

```ts
await expect(fetchJson(`http://${ip}:${port}/create?workflowName=test`))
  .resolves.toMatchInlineSnapshot(`
  {
    "__LOCAL_DEV_STEP_OUTPUTS": [{ "output": "First step result" }],
    "output": null,
    "status": "running",
  }
`);

await vi.waitFor(
  async () => {
    await expect(fetchJson(`http://${ip}:${port}/status?workflowName=test`))
      .resolves.toMatchInlineSnapshot(/* ... */);
  },
  { timeout: 5000 }
);
```

So "wait for completion" = "poll `instance.status()` in a loop until terminal state" (terminal states: `complete`, `errored`, `terminated`).

### 3.2 Idempotent kickoff with errored-instance recovery

`createBatch` is the built-in idempotent kickoff API (`workers-api.mdx:402`): existing-id instances within retention are silently skipped and excluded from the returned array. Critically, **errored instances are also "still within retention" and get skipped** — `createBatch` will not re-run them. The only way to re-run an errored instance with the same id is `instance.restart()` (`trigger-workflows.mdx:165-172`):

> Restarting an instance will immediately cancel any in-progress steps, erase any intermediate state, and treat the Workflow as if it was run for the first time.

This matters because Better Auth's magic-link `signUp` short-circuits on `findUserByEmail` for any subsequent sign-in attempts (`refs/better-auth/packages/better-auth/src/plugins/magic-link/index.ts:389-396`), so a user whose first sign-in left an errored workflow will never re-fire `user.create.after` and will be permanently stuck unless we proactively restart the workflow on the next contact.

The kickoff helper bakes the recovery into one call:

```ts
const kickoffUserProvisioning = Effect.fn("kickoffUserProvisioning")(
  function* (params: UserProvisioningParams) {
    const env = yield* CloudflareEnv;
    const created = yield* Effect.tryPromise(() =>
      env.USER_PROVISIONING_WORKFLOW.createBatch([
        { id: params.userId, params },
      ]),
    );
    if (created[0]) return created[0]; // freshly created
    // Existing instance — fetch it and restart if it errored.
    const instance = yield* Effect.tryPromise(() =>
      env.USER_PROVISIONING_WORKFLOW.get(params.userId),
    );
    const snapshot = yield* Effect.tryPromise(() => instance.status());
    if (snapshot.status === "errored" || snapshot.status === "terminated") {
      yield* Effect.logWarning("userProvisioning.restart", {
        userId: params.userId,
        previousStatus: snapshot.status,
        previousError: snapshot.error,
      });
      yield* Effect.tryPromise(() => instance.restart());
    }
    return instance;
  },
);
```

This is called from both the after-hook and the queue handler. Because the queue message is durable and re-delivered on transient failure, *and* every contact runs this kickoff helper, the worst case is "errored workflow gets restarted on the next sign-in attempt or queue retry" — bounded recovery without manual intervention.

**Note on the OSS source**: `refs/workers-sdk/packages/workflows-shared/src/binding.ts:30-115` shows that the local-dev `WorkflowBinding` actually suppresses *all* `init` errors via `.catch(() => {})` and forwards to a single per-id Engine DO, so duplicate-id behavior in `wrangler dev` is more permissive than the docs describe. For correctness we trust the docs (production behavior); for local-dev assertions in tests we should not rely on duplicate-id throwing.

### 3.3 Where to wait: dashboard loader, not the after-hook

Two places could plausibly host the wait:

| Location | Pros | Cons |
|---|---|---|
| `databaseHooks.user.create.after` | Single user-perceived spinner (the magic-link verify request). On happy path, redirect lands directly on dashboard. | Couples auth-hook responsibilities with provisioning observability. Consumes the magic-link verify request's CPU/wall budget. Errors inside the wait propagate to the auth response (`runWithAdapter` propagates after-hook errors per `refs/better-auth/packages/core/src/context/transaction.ts:85-89`). Re-running provisioning on subsequent sign-ins is impossible because Better Auth's magic-link plugin short-circuits on `findUserByEmail` and never re-fires the after-hook. |
| Dashboard route loader | TanStack Router already provides loader pending-state UI and Suspense boundaries. Wait runs on every navigation, so a user whose previous wait timed out automatically resumes waiting on the next dashboard hit. The auth hook stays narrow (just kicks off the workflow). The loader can `restart()` an errored workflow inline. | One extra redirect hop visible in the network tab (verify → dashboard route → loader awaits). |

**Recommendation: loader.** The recovery story alone justifies it — re-running the wait on every dashboard navigation gives us free retry semantics that the after-hook approach cannot match.

The after-hook becomes pure fire-and-forget:

```ts
after: (user) =>
  runEffect(
    Effect.gen(function* () {
      if (user.role !== "user") return;
      yield* kickoffUserProvisioning({ userId: user.id, email: user.email });
    }),
  ),
```

The dashboard loader awaits via the `getProvisioningStatusServerFn` defined in §6.1, with bounded polling. The polling helper (used by both the loader and tests) is:

```ts
const waitForTerminalStatus = Effect.fn("waitForTerminalStatus")(
  function* (
    instance: WorkflowInstance,
    { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
  ) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const snapshot = yield* Effect.tryPromise(() => instance.status());
      if (
        snapshot.status === "complete" ||
        snapshot.status === "errored" ||
        snapshot.status === "terminated"
      ) {
        return snapshot;
      }
      if (Date.now() >= deadline) return snapshot;
      yield* Effect.sleep(`${intervalMs} millis`);
    }
  },
);
```

The loader-side wait is bounded by Worker request budget, same as the after-hook would be (30 s default fetch handler wall clock on Paid). With provisioning being sub-second to a few seconds in practice, a 10 s timeout / 500 ms interval (= 20 polls) is well under the subrequest budget.

### 3.4 Triggering from a queue handler

`refs/cloudflare-docs/src/content/docs/workflows/build/trigger-workflows.mdx:13-27` confirms Workflows can be created from a queue consumer's `queue` handler. This is the durable backstop:

```ts
case "EnsureUserProvisioning": {
  const userOpt = yield* repository.getUser(message.email);
  if (Option.isNone(userOpt)) return; // user row never committed; nothing to do
  const user = userOpt.value;
  // Idempotent: skipped if already running/completed within retention window
  yield* Effect.tryPromise(() =>
    env.USER_PROVISIONING_WORKFLOW.createBatch([
      { id: user.id, params: { userId: user.id, email: user.email } },
    ]),
  );
}
```

The queue handler does NOT wait for the workflow to complete — it just ensures the workflow has been kicked off. Once `createBatch` succeeds, the queue message is acked, the workflow runs durably to completion on its own.

---

## 4. Architecture

### 4.1 Lifecycle

```
t-1  user.create.before hook
       → enqueue { action: "EnsureUserProvisioning", email }
       → queue.send returns; user row is about to be written
                                      |
                                      v
t-0  Better Auth writes User row to D1
                                      |
                                      v
t-1  user.create.after hook
       → createBatch([{ id: user.id, params }])  -- idempotent kickoff
       → wait for workflow status to be terminal (with bounded timeout)
       → return successfully whether or not it completed in time
                                      |
                                      v
     Magic-link verify endpoint returns; cookies set; redirect happens
                                      |
                                      v
     Frontend route guard polls /api/getProvisioningStatus until "complete"
     then enters the dashboard

     Meanwhile, in parallel, the queue consumer eventually picks up the
     EnsureUserProvisioning message and runs the same createBatch call —
     no-op if the workflow already exists, otherwise the recovery path
     that catches a crash between t-0 and the after-hook's createBatch.
```

### 4.2 The Workflow itself

```ts
// src/user-provisioning-workflow.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

interface UserProvisioningParams {
  readonly userId: string;
  readonly email: string;
}

export class UserProvisioningWorkflow extends WorkflowEntrypoint<Env, UserProvisioningParams> {
  async run(event: WorkflowEvent<UserProvisioningParams>, step: WorkflowStep) {
    const { userId, email } = event.payload;

    // Step 1: idempotently ensure the Organization+Member rows exist.
    // This is the only step that's not naturally idempotent inside Better Auth,
    // so we wrap it with the existence check + half-write recovery.
    const organizationId = await step.do("ensure-organization", async () => {
      // ... read this.env.D1 to check if user already has an org via the
      // owner-org join through Member. If so, return its id.
      // If not, call auth.api.createOrganization({ body: { userId, name, slug } }).
      // Catch ORGANIZATION_ALREADY_EXISTS — re-look up by slug and call addMember.
    });

    // Step 2: backfill activeOrganizationId on existing sessions for this user.
    // Already idempotent in Repository (only updates rows where activeOrganizationId is null).
    await step.do("initialize-active-organization-for-sessions", async () => {
      // ... repository.initializeActiveOrganizationForUserSessions
    });

    // Step 3: set the DO instance name (workerd #2240 workaround).
    await step.do("init-organization-agent", async () => {
      const id = this.env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = this.env.ORGANIZATION_AGENT.get(id);
      await stub.setName(organizationId);
    });

    // Step 4: eager DO-local Member sync. Already idempotent — reads D1 truth.
    await step.do("sync-membership", async () => {
      const id = this.env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = this.env.ORGANIZATION_AGENT.get(id);
      await stub.syncMembership({ userId, change: "added" });
    });

    return { organizationId };
  }
}
```

Needs to be idiomatic effect v4. scan refs/effect4 to ground the patterns to use

The runtime layer follows the existing project pattern (`src/invoice-extraction-workflow.ts:40-55`) — build an Effect runtime layer inside `run` and use `Effect.runPromise` per step. Auth is the awkward dependency: see §5.

### 4.3 The before hook

```ts
databaseHooks: {
  user: {
    create: {
      before: (user) =>
        runEffect(
          Effect.gen(function* () {
            if (user.role !== "user") return;
            yield* Effect.tryPromise(() =>
              queue.send({ action: "EnsureUserProvisioning", email: user.email }),
            );
          }),
        ),
      after: /* see §4.4 */,
    },
  },
}
```

Don't use raw queue binding. There's no type checking. Use enqueue in Q.ts

If `queue.send` throws, the before-hook propagates the error — the user row is never written and the magic-link verify endpoint returns an error. Retry is at the user level (they click the link again).

### 4.4 The after hook

```ts
after: (user) =>
  runEffect(
    Effect.gen(function* () {
      if (user.role !== "user") return;

      const created = yield* Effect.tryPromise(() =>
        env.USER_PROVISIONING_WORKFLOW.createBatch([
          { id: user.id, params: { userId: user.id, email: user.email } },
        ]),
      );
      const instance = created[0] ?? (yield* Effect.tryPromise(() =>
        env.USER_PROVISIONING_WORKFLOW.get(user.id),
      ));

      // Bounded wait. We don't propagate errors — frontend polls as the backstop.
      yield* Effect.tryPromise(() =>
        waitForWorkflow(instance, { timeoutMs: 10_000, intervalMs: 250 }),
      ).pipe(Effect.catchAll(() => Effect.void));
    }),
  ),
```

### 4.5 The queue consumer

```ts
const FinalizeUserProvisioningQueueMessage = Schema.Struct({
  action: Schema.Literals(["EnsureUserProvisioning"]),
  email: Domain.User.fields.email,
});

const processEnsureUserProvisioning = Effect.fn("processEnsureUserProvisioning")(
  function* (message: typeof FinalizeUserProvisioningQueueMessage.Type) {
    const repository = yield* Repository;
    const userOpt = yield* repository.getUser(message.email);
    if (Option.isNone(userOpt)) return; // before-hook fired but user row never written
    const env = yield* CloudflareEnv;
    yield* Effect.tryPromise(() =>
      env.USER_PROVISIONING_WORKFLOW.createBatch([
        { id: userOpt.value.id, params: { userId: userOpt.value.id, email: message.email } },
      ]),
    );
  },
);
```

This consumer does NOT need `Auth` in its runtime layer (the workflow handles that). It only needs `Repository` and `CloudflareEnv` — both already provided to `Q.ts`'s runtime via `makeEnvLayer` plus a small Repository layer addition. Much smaller surface than the queue-only sibling proposal.

---

## 5. The "Auth from inside a Workflow" problem

The current `databaseHooks.user.create.after` calls `auth.api.createOrganization({ body: { userId, name, slug } })`. We need to do the same from a step inside the workflow. Three options:

### 5.1 Option A: Workflow constructs its own `Auth` instance

The Workflow is its own Worker entrypoint with its own env. It can construct an Effect runtime layer that includes `Auth → Stripe → KV → Repository`, identical to how `worker.ts:59-76` builds `runEffect`. Inside `step.do("ensure-organization", ...)`, the step callback runs an Effect that yields `Auth` and calls `auth.api.createOrganization`.

**Pros**: full Better Auth surface available, no contortions.
**Cons**: every workflow instance pays the Auth construction cost (Stripe client, KV layer, etc.) — but this happens at most once per user signup, not per request, so it's amortized.

Is this a large cost? Mainly js objects?

**Verify before implementing** (sibling doc §Open Questions item 3): does `auth.api.createOrganization({ body: { userId } })` work when called outside an HTTP request scope? The current after-hook calls it from inside a request scope. `runWithAdapter` falls back to running pending hooks immediately when no AsyncLocalStorage store is active (`refs/better-auth/packages/core/src/context/transaction.ts:118-136`). The `organization` plugin's `createOrganization` route (`refs/better-auth/packages/better-auth/src/plugins/organization/routes/crud-org.ts:179-219`) reads from `ctx.context` for the org options and `ctx.body` for the inputs — neither requires HTTP headers when `body.userId` is supplied.

Spot check: the existing `subscription/*` `before` hook (`src/lib/Auth.ts:204-225`) only fires for those paths, so workflow-driven `auth.api.createOrganization` won't trigger it. Confirmed safe.

### 5.2 Option B: Workflow calls Repository directly, bypasses Better Auth

Hand-write the org+member inserts via `Repository`. This sidesteps the Auth dependency entirely but loses Better Auth's plugin hooks (e.g. any `organizationHooks` we might add later) and re-implements internal Better Auth plumbing.

We don't want to re-implement better auth

**Verdict**: reject. The whole point of Better Auth is that we don't reinvent these primitives.

### 5.3 Option C: Workflow callbacks via the Worker's existing Auth instance

Workflows can't call back into the parent Worker's runtime. Each workflow instance has its own isolate.

**Verdict**: not possible.

**Recommendation**: Option A. Spot-check that `Request` service is not pulled in by `auth.api.createOrganization`'s code path before implementing. If it is, provide a synthetic `Request` to the workflow's runtime layer, or extract a thinner "auth surface for queue/workflow callers".

Agreed. Can remove the other options.

---

## 6. UI / route guard pattern

### 6.1 The provisioning gate

The dashboard route needs to wait until the user has an active organization before rendering. Today, `databaseHooks.session.create.before` (`src/lib/Auth.ts:177-201`) reads the owner org for the session — once the workflow completes, this works. Until then, `activeOrganizationId` is `undefined` and the dashboard route guard fires.

We add a `provisioningStatus` server fn:

```ts
export const getProvisioningStatusServerFn = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const session = yield* /* read current session */;
        const repository = yield* Repository;

        // Fast path: if D1 already has the owner org, we're done — no workflow lookup needed.
        const ownerOrg = yield* repository.getOwnerOrganizationByUserId(session.userId);
        if (Option.isSome(ownerOrg)) {
          return { status: "complete" as const, organizationId: ownerOrg.value.id };
        }

        // Slow path: poll the workflow.
        const env = yield* CloudflareEnv;
        const instance = yield* Effect.tryPromise(() =>
          env.USER_PROVISIONING_WORKFLOW.get(session.userId),
        ).pipe(
          Effect.catchAll(() =>
            // instance.not_found means it was never created (queue finalizer hasn't fired
            // yet) or it expired (>30d ago). Treat as "still pending" and let the client
            // re-poll; the queue handler will eventually create it.
            Effect.succeed(null),
          ),
        );
        if (!instance) return { status: "queued" as const };
        const snapshot = yield* Effect.tryPromise(() => instance.status());
        return { status: snapshot.status, error: snapshot.error };
      }),
    ),
);
```

Why would we poll the workflow? how is that necessary? or is it to check workflow error.

### 6.2 Route guard

In a `beforeLoad` for `/_authed/*` (the project uses TanStack Start file routes, `CLAUDE.md`):

```ts
beforeLoad: async ({ context }) => {
  const status = await getProvisioningStatusServerFn();
  if (status.status === "complete") return { organizationId: status.organizationId };
  if (status.status === "errored") throw redirect({ to: "/provisioning-error" });
  // Otherwise pending — redirect to a /provisioning gate page that polls
  throw redirect({ to: "/provisioning" });
},
```

The `/provisioning` route is a thin shell that polls `getProvisioningStatusServerFn` via TanStack Query (`refetchInterval: 500`) and on `status === "complete"` navigates to the dashboard.

Because the after-hook already waited up to ~10 seconds, the **happy path doesn't render `/provisioning` at all** — provisioning is done by the time the magic-link verify endpoint redirects. The `/provisioning` route is only reached when:

1. The after-hook timed out (provisioning is slow), or
2. The after-hook crashed between user-row write and `createBatch` (queue finalizer is the recovery path).

### 6.3 Why not push notifications via the org agent?

The existing `InvoiceExtractionWorkflow → OrganizationAgent.onWorkflowProgress` callback (`src/organization-agent.ts:595-614`) broadcasts step progress to connected websocket clients via the Agents SDK. **This pattern is unavailable for user provisioning** because the org agent does not exist yet — it gets created *as part of* provisioning. By the time it exists, provisioning is essentially done. Polling is simpler and matches the gate semantics.

---

## 7. Idempotency contract

| Step | Mechanism |
|---|---|
| `ensure-organization` | Read `getOwnerOrganizationByUserId` first; only call `createOrganization` if none. Catch `ORGANIZATION_ALREADY_EXISTS` (half-write recovery) → re-read by slug, call `addMember`. |
| `initialize-active-organization-for-sessions` | Already idempotent in Repository (only updates rows where `activeOrganizationId is null`, see sibling doc §Idempotency contract). |
| `init-organization-agent` (`stub.setName`) | Idempotent — same name is a no-op. |
| `sync-membership` | Idempotent — reads D1 truth, aligns DO Member table. |
| Workflow kickoff (`createBatch`) | Documented idempotent on duplicate id. |
| Queue message (`EnsureUserProvisioning`) | Resolves email→user; triggers idempotent `createBatch`. Safe to re-deliver. |

The workflow's per-step caching gives us replay-idempotency for free: a retry after a step succeeds picks up at the next step, never re-running the side effect.

---

## 8. Testing

`@cloudflare/vitest-pool-workers` v0.9.0+ ships first-class workflow testing utilities (`refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx:238-414`):

- `introspectWorkflowInstance(env.WF, instanceId)` — known id case. Returns a `WorkflowInstanceIntrospector` with:
  - `modify(fn)` — apply a `WorkflowInstanceModifier`: `disableSleeps`, `mockStepResult`, `mockStepError`, `forceStepTimeout`, `mockEvent`, `forceEventTimeout`.
  - `waitForStepResult({ name })` / `waitForStatus("complete")` / `getOutput()` / `getError()`.
  - `dispose()` (or `await using`) — required for test isolation.
- `introspectWorkflow(env.WF)` — unknown id case. Captures all instances created after introspection starts. Use this for end-to-end "magic-link verify → after hook → workflow" tests since the after-hook generates the id.

Example test outline (mirrors `test-apis.mdx:265-285`):

```ts
import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";

it("provisioning workflow runs through end-to-end on first sign-in", async () => {
  await using introspector = await introspectWorkflow(env.USER_PROVISIONING_WORKFLOW);

  // Trigger the magic-link verify endpoint, which fires the after-hook
  await fetch(`http://${ip}:${port}/api/auth/magic-link/verify?token=...`);

  const [instance] = await introspector.get();
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  const output = await instance.getOutput();
  expect(output).toMatchObject({ organizationId: expect.any(String) });
});

it("ensure-organization step recovers from a half-write", async () => {
  await using instance = await introspectWorkflowInstance(
    env.USER_PROVISIONING_WORKFLOW,
    "user-id-123",
  );
  await instance.modify(async (m) => {
    await m.mockStepError(
      { name: "ensure-organization" },
      Object.assign(new Error("ORGANIZATION_ALREADY_EXISTS"), { name: "BetterAuthError" }),
      1, // fail once, then succeed
    );
  });
  await env.USER_PROVISIONING_WORKFLOW.create({
    id: "user-id-123",
    params: { userId: "user-id-123", email: "u@u.com" },
  });
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
});
```

The fixture pattern from `refs/workers-sdk/fixtures/workflow/tests/index.test.ts` (using `vi.waitFor` against a `wrangler dev` instance) is the alternate path if pool-workers introspection is too restrictive.

`pnpm test` currently only runs d1-adapter tests per `CLAUDE.md`. Adding workflow tests will require enabling them in the vitest workspace config.

---

## 9. Implementation plan

1. **New file** `src/user-provisioning-workflow.ts` — `UserProvisioningWorkflow extends WorkflowEntrypoint<Env, UserProvisioningParams>`. Mirror the Effect runtime pattern from `src/invoice-extraction-workflow.ts:40-173`. The runtime layer must include `Auth` (see §5.1 caveat to verify first).
2. **Re-export** the class from `src/worker.ts` (mirror the existing `export { InvoiceExtractionWorkflow } from "./invoice-extraction-workflow"` at line 25).
3. **Update wrangler.jsonc** — add the workflow binding to both the local and `env.production` blocks (mirror the existing `INVOICE_EXTRACTION_WORKFLOW` entries at lines 45-51 and 179-185).
4. **Run `pnpm typecheck`** — this regenerates `worker-configuration.d.ts` and adds `USER_PROVISIONING_WORKFLOW: Workflow<UserProvisioningParams>` to the `Env` interface.
5. **Replace `databaseHooks.user.create.after`** in `src/lib/Auth.ts:127-174`:
   - Move the `if (user.role !== "user") return` guard (keep it).
   - Replace the body with `createBatch` + `waitForWorkflow` (§4.4).
6. **Add `databaseHooks.user.create.before`** that enqueues `EnsureUserProvisioning` (§4.3).
7. **Update `src/lib/Q.ts`**:
   - Add `EnsureUserProvisioningQueueMessage` schema (§4.5).
   - Add `processEnsureUserProvisioning` handler.
   - Wire it into `processMessage`'s switch.
   - Add `Repository.layer` to `makeRuntimeLayer` (the queue handler now needs Repository — much smaller dependency add than the queue-only sibling proposal which needed Auth too).
8. **Add `getProvisioningStatusServerFn`** to a new `src/lib/UserProvisioning.ts` (§6.1).
9. **Add `/provisioning` route** in `src/routes/` that uses TanStack Query polling against the server fn.
10. **Update the `/_authed/*` route guard** to redirect to `/provisioning` when status is not `complete` (§6.2).
11. **Tests** — enable workflow tests in vitest workspace, write the two tests outlined in §8.
12. **Run `pnpm typecheck` and `pnpm lint`** per `CLAUDE.md`.

---

## 10. Open questions

1. **`auth.api.createOrganization` outside an HTTP request scope** — needs spot-checking for hidden `Request`-service dependencies inside the organization plugin's `before`/`after` hook chains. (Same question as sibling doc §Open Questions item 3, more pressing here because the workflow definitively runs without an HTTP request.)
2. **Auth runtime cost in workflows** — every workflow instance constructs Stripe + KV + Repository + Auth on cold start. Acceptable per-signup, but if we ever see workflow cold start regressions, consider Option B (direct Repository writes) for the `ensure-organization` step.
3. **Polling timeout in the after-hook** — 10 s is a guess. The realistic provisioning wall time is sub-second to ~3 s in dev. We should measure once implemented and tune. The exact value matters less than the fact that the timeout is non-fatal.
4. **`/provisioning` route UX** — what does it look like? Spinner + "setting up your account..."? How long before we surface a "this is taking longer than expected, support contact" path? Defer until we observe real-world wall times.

Provisioning should be fast. we're not doing much.

5. **Workflow id collision after retention expiry** — if a user signs up, gets provisioned, comes back 35 days later, and triggers some path that calls `createBatch([{ id: user.id }])` again: the old instance is gone, a new instance is created. This could happen if we ever add a "re-provision" admin action. Not a bug, just a design constraint to be aware of: workflow ids = user ids only works as long as we never need to re-provision an existing user mid-retention. If we do, use a composite id (`${user.id}:${epoch}`) and store the latest id alongside the user.
6. **Monitoring** — `instance.status()` polling from the after-hook adds N subrequests per signup (where N = `timeoutMs / intervalMs`). Default Worker subrequest limit is 50/request on free, 1000+ on paid. With 10s/250ms = 40 polls, we're under the free limit but eating into it. Tune `intervalMs` upward (500 ms?) before deploying.
7. **Cleanup of the queue message after the workflow completes** — there is none. The queue message is acked once `createBatch` returns, regardless of whether the workflow itself succeeds. The workflow's own retry/failure handling is what governs eventual consistency. Q's at-least-once delivery means we may run `createBatch` multiple times, which is fine because it's idempotent.
8. **Should the existing `FinalizeMembershipSync` queue message be folded into the workflow?** Currently `databaseHooks.user.create.after` enqueues `FinalizeMembershipSync` as a safety net (`Auth.ts:161-168`). If the workflow's `sync-membership` step takes over that job, the existing queue message is redundant *for the user-creation path* — but it's still used by other code paths (org member add/remove) and stays. The new `EnsureUserProvisioning` message replaces the user-creation usage of `FinalizeMembershipSync` entirely.
