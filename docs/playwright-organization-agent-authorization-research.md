# Playwright E2E Research: Organization Agent Authorization

## Conclusion

Yes, Playwright e2e tests in `e2e/` are a good fit for this authorization coverage.

- invited member (not owner) should be able to use invoice callables
- non-member should be blocked (either at worker handshake or callable authorization, depending on scenario)

The current code enforces **membership**, not **role**, inside callables.

## Ground Truth From Code

Worker gates agent traffic before it reaches the DO:

`src/worker.ts:307-323`

```ts
const authorizeAgentRequest = Effect.fn("authorizeAgentRequest")(function* (
  request: Request,
) {
  const auth = yield* Auth;
  const session = yield* auth.getSession(request.headers);
  if (Option.isNone(session)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const agentName = extractAgentInstanceName(request);
  const activeOrganizationId = session.value.session.activeOrganizationId;
  if (!activeOrganizationId || agentName !== activeOrganizationId) {
    return new Response("Forbidden", { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set(organizationAgentAuthHeaders.userId, session.value.user.id);
  return new Request(request, { headers });
});
```

Agent stores user identity per socket in connection state:

`src/organization-agent.ts:152-162`

```ts
onConnect(
  connection: Connection<OrganizationAgentConnectionState>,
  ctx: ConnectionContext,
) {
  const userId = ctx.request.headers.get(organizationAgentAuthHeaders.userId);
  if (!userId) {
    connection.close(4001, "Unauthorized");
    return;
  }
  connection.setState({ userId });
}
```

All invoice callables run membership authorization:

`src/organization-agent.ts:510-526`

```ts
const authorizeConnection = Effect.fn("OrganizationAgent.authorizeConnection")(
  function* () {
    const { connection } = getCurrentAgent<OrganizationAgent>();
    if (!connection) return;
    const identity = yield* getConnectionIdentity();
    const repo = yield* OrganizationRepository;
    const authorized = yield* repo.isMember(identity.userId as Domain.UserId);
    if (!authorized) {
      return yield* new OrganizationAgentError({
        message: `Forbidden: userId=${identity.userId} not in Member table`,
      });
    }
    return identity;
  },
);
```

Implication: member/admin/owner are all authorized for these callables today; non-member is denied.

## Callable Surface To Cover

`src/organization-agent.ts` defines invoice callables:

- `createInvoice`
- `updateInvoice`
- `uploadInvoice`
- `deleteInvoice`
- `getInvoices`
- `getInvoice`

For e2e auth, do not duplicate deep CRUD assertions from existing invoice specs. Focus on auth outcomes.

## What To Test

### 1) Invited member (non-owner) is authorized

Recommended assertions (minimal but meaningful):

1. owner invites user with role `member`
2. invitee accepts invite and switches to owner org
3. invitee can perform representative callable flow:
   - read: invoices page loads (uses `getInvoices`)
   - write: click **New Invoice** (uses `createInvoice`)
   - write: save edit on created invoice (uses `updateInvoice`)
   - write: delete created invoice (uses `deleteInvoice`)

Notes:

- this validates non-owner authorization behavior
- `invite.spec.ts` already has reusable invite/login/switch flow patterns

### 2) Non-member is blocked

There are two valid non-member scenarios. Use both if you want full confidence.

#### A. Never-member blocked at worker gate (deterministic)

- login user A (owner org id = `orgA`)
- login unrelated user B (never invited to `orgA`)
- attempt agent access to `orgA` as user B
- expect forbidden (`403`) from worker gate because `activeOrganizationId !== orgA`

This directly tests `src/worker.ts:317-319` behavior.

#### B. Ex-member blocked in callable authorization (stronger end-to-end)

- owner invites member, member accepts and opens invoices (active socket)
- owner removes member in Members page
- member tries callable action (for example `createInvoice`)
- expect failure message containing `Forbidden` (from `authorizeConnection`)

This covers queue sync + DO member cache + callable authorization behavior.

## Why This Matches Agents Docs

`routeAgentRequest` supports pre-routing auth hooks:

`refs/agents/docs/routing.md:280-291`

```ts
const response = await routeAgentRequest(request, env, {
  onBeforeConnect: (req, lobby) => {
    // Return a Response to reject, Request to modify, or void to continue
  },
  onBeforeRequest: (req, lobby) => {
    // Return a Response to reject, Request to modify, or void to continue
  },
});
```

Callables have connection context (not request), so connection state is the right place:

`refs/cloudflare-docs/src/content/docs/agents/api-reference/get-current-agent.mdx:232-239`

```md
| Custom method (via RPC) | `agent` Yes | `connection` Yes | `request` No |
```

Per-connection state is intended for this exact use:

`refs/agents/docs/http-websockets.md:283-323`

```md
Store data specific to each connection using `connection.state` and `connection.setState()`
...

- Per-connection
- Persisted across hibernation
```

## Playwright Implementation Plan

Create `e2e/organization-agent-authorization.spec.ts` with two describes:

1. `member authorization`
2. `non-member authorization`

Suggested structure:

- keep using `scopeEmail(...)` and `/api/e2e/delete/user/$email` cleanup
- create tiny helpers in-file or `e2e/utils.ts` for:
  - `login(page, email)`
  - `inviteAsOwner(...)`
  - `acceptAndSwitchOrganization(...)`
  - `goToInvoicesAndCreateOne(...)`
- for scenario B (ex-member), use two browser contexts in one test so owner/member run concurrently

## Flakiness Risks + Mitigations

- membership removal propagates through queue; callable denial may not be instant
- use `expect.poll` on a small callable action result/error text after removal
- assert on stable text fragments (`Forbidden`) rather than full error string

## Recommended Initial Scope

If you want one high-value test first, do this:

1. invited member can create invoice
2. after owner removes member, same user cannot create invoice and sees `Forbidden`

This single flow proves both allow and deny paths for callable authorization.

## Open Questions To Confirm Before Writing Tests

1. Should we require **all six** callables in auth coverage, or treat `getInvoices + createInvoice` as authorization proxies?

All

2. For non-member, do you want only deterministic worker-level `403`, or also ex-member callable-level denial after removal?

both

3. Should we assert exact error message text, or only stable fragment (`Forbidden`) to reduce brittleness?

stable
