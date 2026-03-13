# Organization Agent Spike Research

Question: how is the `refs/tca` organization agent organized and wired into the worker + Wrangler config, and what is the cleanest way to introduce a similar `organization agent` spike here without chat capabilities?

## Short Answer

`refs/tca` wires its organization agent in three layers:

1. an agent class exported from the worker entry
2. `routeAgentRequest(...)` handling agent HTTP/WebSocket traffic in the worker fetch handler
3. Wrangler durable object + migration bindings for the agent class

The main thing we should *not* copy is the chat ancestor.

`OrganizationAgent` in `refs/tca` extends `AIChatAgent<Env>`:

```ts
export class OrganizationAgent extends AIChatAgent<Env> {
```

For this repo's organization-agent spike, the better fit is a plain `Agent<Env, State>` with a tiny state shape and one or two `@callable()` methods. That keeps the spike aligned with the requirement: no chat, no `useAgentChat`, no chat persistence tables, no chat-specific UI.

## What `refs/tca` Is Doing

### Agent class choice

In `refs/tca/src/organization-agent.ts:284`:

```ts
export class OrganizationAgent extends AIChatAgent<Env> {
```

That choice pulls in chat-specific behavior. The chat docs make this explicit in `refs/agents/docs/chat-agents.md:106`:

```ts
The `new_sqlite_classes` migration is required — `AIChatAgent` uses SQLite for message persistence and stream chunk buffering.
```

And the same doc says `AIChatAgent` is just a higher-level layer on top of base agents in `refs/agents/docs/chat-agents.md:134`:

```ts
Extends `Agent` from the `agents` package. Manages conversation state, persistence, and streaming.
```

So for this repo's `OrganizationAgent`, if we do not want chat, we should stop one level lower and extend `Agent` directly.

### Agent capabilities used by the org agent

Even though `OrganizationAgent` is chat-based, a lot of what it uses is actually base-agent behavior:

- `this.sql` for sqlite-backed local tables
- `@callable()` RPC methods like `bang()`
- workflow callbacks like `onWorkflowProgress`
- `this.broadcast(...)` for realtime updates

The base-agent docs cover those primitives directly.

From `refs/agents/docs/agent-class.md:213`:

```ts
State is stored in the `cf_agents_state` SQL table.
```

From `refs/agents/docs/agent-class.md:245`:

```ts
To make a method callable through WS, developers can use the `@callable` decorator.
```

From `refs/agents/docs/agent-class.md:217`:

```ts
The Agent provides a convenient `sql` template tag for executing queries against the Durable Object's SQL storage.
```

That is enough for the spike.

## How It Is Wired Into The Worker

`refs/tca/src/worker.ts` uses two pieces from `agents`:

```ts
import { getAgentByName, routeAgentRequest } from "agents";
```

Then inside `fetch`, before handing off to TanStack Start:

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: async (req) => { ... },
  onBeforeRequest: async (req) => { ... },
});
if (routed) {
  return routed;
}
```

Grounding:

- `refs/tca/src/worker.ts:137` calls `routeAgentRequest(request, env, ...)`
- `refs/tca/src/worker.ts:173` returns early when the request belongs to an agent
- `refs/tca/src/worker.ts:182` only calls `serverEntry.fetch(...)` after agent routing does not match

It also exports the agent class from the worker entry so Wrangler can bind it:

```ts
export {
  OrganizationAgent,
  OrganizationWorkflow,
  OrganizationImageClassificationWorkflow,
} from "./organization-agent";
```

For the organization-agent spike, the same pattern should hold:

- export `OrganizationAgent` from `src/worker.ts`
- add `routeAgentRequest(request, env, ...)` in `fetch`
- keep TanStack Start as the fallback

## How It Is Wired Into Wrangler

In `refs/tca/wrangler.jsonc:30`:

```json
"durable_objects": {
  "bindings": [
    {
      "name": "ORGANIZATION_AGENT",
      "class_name": "OrganizationAgent"
    }
  ]
}
```

In `refs/tca/wrangler.jsonc:50`:

```json
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["OrganizationAgent"]
  }
]
```

It also has workflows:

```json
"workflows": [
  {
    "name": "OrganizationWorkflow",
    "binding": "OrganizationWorkflow",
    "class_name": "OrganizationWorkflow"
  }
]
```

But those are only needed because the org agent runs workflows.

For the organization-agent spike, the minimal config is smaller:

- add a durable object binding like `ORGANIZATION_AGENT`
- add a migration entry for `OrganizationAgent`
- do *not* add workflows unless the spike actually tests workflows

## What The Current App Needs

Current app worker has no agent routing yet.

`src/worker.ts` currently goes straight from rate-limit handling to `serverEntry.fetch(...)`:

```ts
const runEffect = makeHttpRunEffect(env, request);
return serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
  },
});
```

So the worker integration work for the future spike is real, not just copy/paste.

Current app sidebar also has no `agent` item yet. In `src/routes/app.$organizationId.tsx`, the menu currently includes:

- `Organization Home`
- `Invitations`
- `Members`
- `Billing`

There are only three child org routes today:

- `src/routes/app.$organizationId.index.tsx`
- `src/routes/app.$organizationId.invitations.tsx`
- `src/routes/app.$organizationId.members.tsx`
- `src/routes/app.$organizationId.billing.tsx`

So the future spike will need both:

- a new route file `src/routes/app.$organizationId.agent.tsx`
- a new sidebar entry in `src/routes/app.$organizationId.tsx`

## Recommended Organization Agent Shape

The docs show the plain-agent shape clearly in `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx:357`:

```ts
import { Agent } from "agents";

export class ResearchAgent extends Agent<Env, State> {
  initialState: State = {};
}
```

And the core SDK readme has the same pattern in `refs/agents/packages/agents/README.md:45`:

```ts
import { Agent, callable } from "agents";

export class CounterAgent extends Agent<Env, State> {
  initialState: State = { count: 0 };
}
```

For this repo, a good spike shape is:

```ts
interface OrganizationAgentState {
  readonly message: string;
}

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  initialState = { message: "Organization agent ready" } as const;

  @callable()
  getTestMessage() {
    return this.state.message;
  }
}
```

Why this shape:

- plain `Agent` matches the requirement exactly
- tiny immutable state gives us something to sync later if useful
- one `@callable()` method is enough to prove routing + binding + client hookup
- no chat transport or chat persistence is needed

Important nuance: the class name now matches `refs/tca`, but the base class intentionally does not. The reference app uses `AIChatAgent`; this spike should still use plain `Agent` because chat is out of scope.

## Recommended UI Spike

The route should be a normal TanStack file route under the existing org shell:

- path: `/app/$organizationId/agent`
- file: `src/routes/app.$organizationId.agent.tsx`

Minimal first pass:

- page title like `Agent`
- short description that this is an organization-agent spike
- render a test message from the organization agent, ideally via `useAgent(...).stub.getTestMessage()`

Unlike `refs/tca/src/routes/app.$organizationId.agent.tsx`, we should not use:

- `useAgentChat`
- `AIChatAgent`
- multiple RPC demo buttons unless needed

That keeps the spike focused on transport and app integration, not agent feature breadth.

## Effect v4 And TanStack Start Notes

This repo already uses Effect v4 service/layer style in `src/worker.ts`, and the current research in `docs/effect4-use-pattern-research.md:15` recommends:

```md
1. model the integration as `ServiceMap.Service`
2. build layers explicitly with `Layer.effect(...)`
3. wrap foreign boundaries with `Effect.try`, `Effect.tryPromise`, ...
4. access services mostly with `yield*`
```

For this spike, that means:

- keep auth checks and worker request plumbing in Effect pipelines where they already exist
- keep route data fetching in `createServerFn` / loader patterns, not ad hoc client fetches
- if auth-gating agent requests is added, mirror the `refs/tca` pattern but adapt it to this repo's current `Request`/`Auth`/`runEffect` setup

TanStack Start pattern also stays simple here:

- use the existing `/app` and `/app/$organizationId` route guards
- use a child route for `/agent`
- only add a loader if the page truly needs server-side data before render

## Proposed Spike Scope

Smallest useful spike:

1. add `OrganizationAgent extends Agent<Env, OrganizationAgentState>`
2. export it from `src/worker.ts`
3. add `routeAgentRequest(...)` to `src/worker.ts`
4. add Wrangler durable object binding + migration
5. add `src/routes/app.$organizationId.agent.tsx`
6. add sidebar link in `src/routes/app.$organizationId.tsx`
7. show a test message from `agent.stub.getTestMessage()`

Deliberately out of scope for spike v1:

- chat
- workflows
- queues
- R2 integration
- background scheduling
- broader organization-agent behavior beyond one test RPC

## Open Design Choices To Review In Next Iteration

These are the few choices worth deciding before implementation:

1. binding name: `ORGANIZATION_AGENT` to mirror `refs/tca`, or a different local name
2. instance key: one organization agent per organization (`organizationId`) vs one global test instance
3. auth gate: whether to protect agent HTTP/WS traffic with the same active-organization check `refs/tca` uses
4. state vs pure RPC: whether the spike should exercise synced `state` or only a callable method

## Recommendation

Recommended default for the first implementation pass:

- class: `OrganizationAgent extends Agent<Env, OrganizationAgentState>`
- instance name: current `organizationId`
- transport: `useAgent` + one `@callable()` method
- auth: yes, mirror the org-bound check from `refs/tca`
- UI: one `/app/$organizationId/agent` page with one visible test message

That is the smallest spike that proves the full stack:

- Wrangler binding works
- worker routing works
- organization-scoped agent addressing works
- TanStack route wiring works
- sidebar integration works
- no accidental chat complexity leaks in
