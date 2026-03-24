# Agent Connection Identity

## Approach

This is our approach for agent WebSocket identity:

1. the Worker authenticates the WebSocket in `onBeforeConnect`
2. the Worker derives trusted identity claims from the Better Auth session
3. the Worker forwards those claims on the routed request
4. the agent reads them in `onConnect(connection, ctx)`
5. the agent stores them in `connection.state`
6. `@callable()` methods read `getCurrentAgent().connection.state`
7. privileged methods authorize from that identity

## Why not `props`

`props` go to `onStart`, not to a specific connection.

Evidence:

`refs/agents/docs/routing.md:254`

```ts
class MyAgent extends Agent<Env, State> {
  async onStart(props?: { userId: string }) {
    this.userId = props?.userId;
  }
}
```

`refs/agents/docs/http-websockets.md:326`

```ts
`onStart()` is called once when the agent first starts, before any connections are established
```

`refs/cloudflare-docs/src/content/docs/agents/api-reference/agents-api.mdx:58`

```ts
| `onStart(props?)` | When the instance starts, or wakes from hibernation |
| `onConnect(connection, ctx)` | When a WebSocket connection is established |
```

Our org agent is one instance per org, with many users potentially connected to the same instance. So `props` is not the right place for `userId`.

## What the agent gets per connection

`onConnect` gets the original request.

`refs/agents/docs/http-websockets.md:145`

```ts
onConnect(connection: Connection, ctx: ConnectionContext) {
  // ctx.request contains the original HTTP request (for auth, headers, etc.)
  const url = new URL(ctx.request.url);
}
```

And each connection has its own state.

`refs/agents/docs/http-websockets.md:186`

```ts
interface Connection<TState = unknown> {
  id: string;
  state: TState | null;
  setState(state: TState | ((prev: TState | null) => TState)): void;
}
```

`refs/agents/docs/http-websockets.md:283`

```ts
Store data specific to each connection using `connection.state` and `connection.setState()`
```

That is the bridge we use: request -> `onConnect` -> `connection.state`.

## What callables can see

Custom RPC methods have `connection`, but not `request`.

`refs/cloudflare-docs/src/content/docs/agents/api-reference/get-current-agent.mdx:232`

```ts
| Custom method (via RPC) | `agent` Yes | `connection` Yes | `request` No |
```

So identity has to be copied into `connection.state` during `onConnect`.

## Worker -> agent handoff

`onBeforeConnect` may return a modified `Request`.

`refs/agents/docs/routing.md:283`

```ts
const response = await routeAgentRequest(request, env, {
  onBeforeConnect: (req, lobby) => {
    // Called before WebSocket connections
    // Return a Response to reject, Request to modify, or void to continue
  },
});
```

So the Worker can:

- verify the Better Auth session
- derive `userId`, `sessionId`, `organizationId`
- add those to the request the agent receives in `ctx.request`

Yes, this modified request is internal to the Worker -> agent routing path. It is not a second browser request.

## Concrete shape

### Worker

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: async (req) => {
    const session = await runEffect(/* Better Auth session lookup */);
    if (Option.isNone(session)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const activeOrganizationId = session.value.session.activeOrganizationId;
    if (!activeOrganizationId) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    url.searchParams.set("cfUserId", session.value.user.id);
    url.searchParams.set("cfSessionId", session.value.session.id);
    url.searchParams.set("cfOrganizationId", activeOrganizationId);

    return new Request(url, req);
  },
});
```

### Agent

```ts
interface OrgConnectionState {
  userId: string;
  sessionId: string;
  organizationId: string;
}

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  onConnect(
    connection: Connection<OrgConnectionState>,
    ctx: ConnectionContext,
  ) {
    const url = new URL(ctx.request.url);
    const userId = url.searchParams.get("cfUserId");
    const sessionId = url.searchParams.get("cfSessionId");
    const organizationId = url.searchParams.get("cfOrganizationId");

    if (!userId || !sessionId || !organizationId) {
      connection.close(4001, "Unauthorized");
      return;
    }

    connection.setState({ userId, sessionId, organizationId });
  }
}
```

### Callable

```ts
import { getCurrentAgent } from "agents";

@callable()
softDeleteInvoice(invoiceId: string) {
  const { connection } = getCurrentAgent<OrganizationAgent>();
  const auth = connection?.state;
  if (!auth) throw new Error("Unauthorized");

  // authorize using auth.userId + auth.organizationId
  // then perform delete
}
```

## Stored identity

Store only lookup keys:

- `userId`
- `sessionId`
- `organizationId`

Optionally:

- `role`
- `permissionsVersion`

## Authorization

`connection.state` answers:

- who is this socket?

Privileged methods still need a fresh permission check for the action being performed.

## Bottom line

The agent should not discover identity from cookies on its own.

The Worker authenticates the WebSocket, forwards trusted identity on the routed request, and the agent stores that identity in `connection.state` for later RPC authorization.
