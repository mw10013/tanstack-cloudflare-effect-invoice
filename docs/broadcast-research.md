# Broadcast Messages: Research & Analysis

## Architecture Overview

```
R2 Upload → Queue → Worker.queue() → OrganizationAgent.onInvoiceUpload()
                                            ↓
Client RPC (stub.createInvoice, etc.) → OrganizationAgent @callable methods
                                            ↓
                                      broadcastActivity()
                                            ↓
                                      agent.broadcast(JSON)
                                            ↓
                                    WebSocket to all clients
                                            ↓
                              useAgent onMessage → decodeActivityMessage()
                                    ↓                        ↓
                        setQueryData(activity)    invalidateQueries(invoices)
```

## Where broadcasts originate

All broadcasts originate from `OrganizationAgent` (`src/organization-agent.ts`) via the `broadcastActivity` helper, which wraps `agent.broadcast()` from the Cloudflare Agents SDK.

| Trigger | Action | Text | Level |
|---|---|---|---|
| `onInvoiceUpload` | `invoice.uploaded` | `"Invoice uploaded: {fileName}"` | info |
| `createInvoice` | `invoice.created` | `"Invoice created"` | info |
| `updateInvoice` | `invoice.updated` | `"Invoice updated: {name}"` | success |
| `softDeleteInvoice` | `invoice.deleted` | `"Invoice deleted"` | info |
| `saveExtraction` | `invoice.extraction.completed` | `"Invoice extraction completed: {fileName}"` | success |
| `onWorkflowProgress` | Forwarded from workflow | Forwarded from workflow | varies |
| `onWorkflowError` | `invoice.extraction.failed` | `"Invoice extraction failed: {fileName}"` | error |

The workflow (`InvoiceExtractionWorkflow`, `src/invoice-extraction-workflow.ts`) reports progress via `this.reportProgress()` which the Agent SDK routes to `onWorkflowProgress`, which then re-broadcasts as activity.

## Activity type system

### `ActivityMessage`

`src/lib/Activity.ts` defines one schema and one type:

```ts
ActivityMessage = {
  createdAt: string,
  level: "info" | "success" | "error",
  text: string,
  action: "invoice.uploaded" | "invoice.created" | "invoice.updated"
        | "invoice.deleted" | "invoice.extraction.completed"
        | "invoice.extraction.failed" | "invoice.extraction.progress"
}
```

Wire format, display type, and cache type — no wrapping, no unwrapping. The `action` field is a structured discriminator used for query invalidation decisions. The `text` field is human-readable, used only for display in the activity feed.

### How the types flow

**Path A: Direct agent method → broadcast**
```
broadcastActivity(agent, { action, level, text })  // Pick<ActivityMessage, "action" | "level" | "text">
  → adds createdAt → JSON.stringify                 // ActivityMessage
  → agent.broadcast(string) → WebSocket
  → decodeActivityMessage(event)                    // parse JSON, validate ActivityMessageSchema
  → ActivityMessage
```

**Path B: Workflow → agent → broadcast**
```
workflow.reportProgress({ action, level, text })    // Pick<ActivityMessage, "action" | "level" | "text">
  → Agent SDK RPC → onWorkflowProgress(unknown)
  → inline Schema.Struct validation                 // unknown → { action, level, text }
  → broadcastActivity(this, result.value)           // same as Path A
```

## Query invalidation

### TanStack Query invalidation mechanics

`invalidateQueries` does two things in sequence:

1. **Marks ALL matching queries as invalidated** (overrides `staleTime`, even `Infinity`)
2. **Refetches only queries with active observers** (default `refetchType: 'active'`)

"Active" = at least one mounted component observing the query via `useQuery`/`useSuspenseQuery`. When a component unmounts, its observer is removed. Zero observers = inactive.

```
invalidateQueries({ queryKey: ["organization", orgId, "invoices"] })
        │
        ├─ Step 1: Mark stale ──► ALL queries matching prefix, regardless of observer count
        │
        └─ Step 2: Refetch ────► ONLY queries with mounted observers (refetchType: 'active')
                                  Inactive queries refetch lazily when next observed
```

**`refetchType` options** (from `queryClient.ts:293-313`):
- `'active'` (default) — refetch only queries with mounted observers
- `'inactive'` — refetch only queries without observers
- `'all'` — refetch everything matching
- `'none'` — mark stale but don't refetch

**Query key prefix matching**: `invalidateQueries({ queryKey: ["organization", orgId, "invoice"] })` matches `["organization", orgId, "invoice", invoiceId]` — it's a prefix match, not exact. Use `exact: true` for exact matching.

**Lifecycle after invalidation of an inactive query**:
- Query stays in cache for `gcTime` (default 5 minutes)
- If a component mounts and observes it within `gcTime`, stale cached data is returned immediately + background refetch fires
- If `gcTime` expires with no observer, query is garbage collected

### How it interacts with TanStack Start

```
                        SERVER                                    CLIENT
                          │                                         │
Route loader              │                                         │
  ensureQueryData() ──────┤                                         │
    queryFn: getInvoices  │  hydrate ─────────────────────────────► │ query cache populated
                          │                                         │  staleTime: 30s (global default)
                          │                                         │
                          │            after 30s, query is "stale"  │
                          │                                         │
                          │  invalidateQueries() ◄── onMessage ─────┤ broadcast arrives
                          │                                         │  overrides staleTime → stale NOW
                          │                                         │  refetch if active observer exists
```

`setupRouterSsrQueryIntegration` (`router.tsx`) connects the router and query client so that:
- Route loaders call `ensureQueryData` which populates the query cache during SSR
- The global `staleTime: 30_000` prevents the client from re-fetching data that was just hydrated
- `invalidateQueries` bypasses `staleTime` — the comment in `router.tsx:12` explicitly notes this

`router.invalidate()` is a different mechanism — it re-runs route loaders, not query invalidation. Used by non-invoice mutations (members, invitations, billing).

### `ensureQueryData` and invalidated queries — the `revalidateIfStale` gap

`ensureQueryData` (`queryClient.ts:140-164`) has a specific behavior that interacts poorly with query invalidation:

```ts
ensureQueryData(options) {
  const query = this.#queryCache.build(this, defaultedOptions)
  const cachedData = query.state.data

  if (cachedData === undefined) return this.fetchQuery(options)       // no cache → fetch

  if (options.revalidateIfStale &&                                    // stale + opted in → background refetch
      query.isStaleByTime(resolveStaleTime(defaultedOptions.staleTime, query))) {
    void this.prefetchQuery(defaultedOptions)
  }

  return Promise.resolve(cachedData)                                  // ALWAYS returns cached data
}
```

**Key**: `ensureQueryData` returns cached data immediately regardless of staleness or invalidation. It only checks `isStaleByTime` (which returns `true` for invalidated queries — see `query.ts:323`) to decide whether to trigger a **background** prefetch. And it only does that background prefetch if `revalidateIfStale: true`.

**Our loaders don't pass `revalidateIfStale`.** This means:

```
broadcast arrives → invalidateQueries(invoicesQueryKey)
                    → query.state.isInvalidated = true
                    → active observer refetches (works fine while on the page)

user navigates to /invoices/$newInvoiceId →
  loader runs ensureQueryData(invoicesQueryKey)
    → cachedData exists (stale/invalidated but !== undefined)
    → revalidateIfStale not set → returns stale data, NO background refetch
    → component mounts → useQuery observer sees isInvalidated → triggers refetch
```

The loader returns stale data and the component's observer catches it. This **works** but:
1. The loader's "ensure" is a no-op for invalidated data — the component does the real work
2. There's a render cycle with stale data before the refetch completes
3. The loader was supposed to ensure fresh data before render — it's not doing that for invalidated queries

**`revalidateIfStale: true` should be set on all `ensureQueryData` calls in loaders.** Without it, `ensureQueryData` silently returns invalidated data and doesn't trigger a background refetch. The `useQuery` observer eventually catches it, but the loader is failing at its job of ensuring data freshness before render.

With `revalidateIfStale: true`:
```
user navigates to /invoices/$newInvoiceId →
  loader runs ensureQueryData(invoicesQueryKey, { revalidateIfStale: true })
    → cachedData exists, isInvalidated = true → isStaleByTime returns true
    → returns stale data immediately (loader doesn't block)
    → fires void prefetchQuery() in background
    → component mounts with stale data, background fetch completes, component re-renders with fresh data
```

Still not blocking — `ensureQueryData` always returns cached data immediately — but now the background refetch fires from the loader, not waiting for the observer to mount. The difference is small in practice (milliseconds) but the semantics are correct: the loader is responsible for data freshness.

**Done** — `revalidateIfStale: true` added to all 4 `ensureQueryData` calls:
- `app.$organizationId.invoices.tsx` (2 calls)
- `app.$organizationId.invoices.$invoiceId.tsx` (2 calls)

### Current invalidation topology

```
                    ┌─────────────────────────────────────────────────────────┐
                    │              app.$organizationId.tsx                    │
                    │                                                         │
                    │  onMessage handler (WebSocket broadcast)                │
                    │    ├─ setQueryData(activityQueryKey) ◄── always         │
                    │    └─ if shouldInvalidateForInvoice(action):            │
                    │         invalidateQueries(["org", id, "invoices"])      │
                    │         invalidateQueries(["org", id, "invoice"])       │
                    └─────────────────────────────────────────────────────────┘
                                           │
          ┌────────────────────────────────┼────────────────────────────────┐
          │                                │                                │
          ▼                                ▼                                ▼
┌──────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────┐
│ invoices.tsx     │     │ invoices.index.tsx        │     │ invoices.$invoiceId.tsx   │
│ (layout route)   │     │ (list view)              │     │ (detail view)            │
│                  │     │                          │     │                          │
│ loader:          │     │ useQuery:                │     │ loader:                  │
│  ensureQueryData │     │  invoicesQueryKey ◄──────┼──┐  │  ensureQueryData         │
│  (invoices list) │     │  invoiceQueryKey  ◄─────┼──┼──┼── (invoices + invoice)   │
│  ensureQueryData │     │                          │  │  │                          │
│  (first invoice) │     │ mutations:               │  │  │ useQuery:                │
│                  │     │  upload   → onSuccess:  │  │  │  invoicesQueryKey ◄──────┤
│                  │     │    invalidate invoices ──┼──┘  │  invoiceQueryKey  ◄──────┤
│                  │     │  create   → onSuccess:  │     │                          │
│                  │     │    invalidate invoices ──┼──┘  │ mutations:               │
│                  │     │  delete   → (no onSuccess)    │  save → onSuccess:       │
│                  │     │                          │     │   setQueryData(invoice)  │
└──────────────────┘     └──────────────────────────┘     │   invalidate invoices ──┤
                                                          └──────────────────────────┘
```

### Query keys and their observers by route

| Query key | Route(s) with active observers | Loader prefetch |
|---|---|---|
| `["org", id, "activity"]` | `app.$organizationId` (ActivityFeed in sidebar) | none — `queryFn: () => []`, `staleTime: Infinity` |
| `["org", id, "invoices"]` | `invoices.index`, `invoices.$invoiceId` | `invoices.tsx`, `invoices.$invoiceId.tsx` |
| `["org", id, "invoice", invoiceId]` | `invoices.index` (selected), `invoices.$invoiceId` | `invoices.tsx` (first), `invoices.$invoiceId.tsx` |

### Does broadcast invalidation cause unnecessary fetches?

**Short answer: no.** `refetchType: 'active'` (default) means only queries with mounted observers refetch.

**Scenario analysis:**

| User is on | Broadcast arrives | `invoicesQueryKey` | `invoiceQueryKey(x)` |
|---|---|---|---|
| `/app/org/invoices` (list) | invoice.updated | refetch (active) | refetch IF viewing invoice x |
| `/app/org/invoices/abc` (detail) | invoice.updated | refetch (active — component uses it) | refetch for `abc` only |
| `/app/org/members` (no invoice views) | invoice.updated | mark stale only (no observer) | mark stale only |
| `/app/org/invoices` then navigate to `/members` | invoice.updated | mark stale; refetch on return if within gcTime | mark stale; refetch on return |

The `["org", id, "invoice"]` prefix invalidation matches ALL `invoiceQueryKey(id, *)` entries in cache. But only the one with an active observer (the currently-viewed invoice) refetches. Others just get marked stale.

### Dual invalidation: broadcast + mutation onSuccess

| Action | Mutation onSuccess | Broadcast onMessage | Net effect for initiator |
|---|---|---|---|
| Upload invoice | `invalidate(invoicesQueryKey)` | `invalidate(invoicesQueryKey + invoiceQueryKey prefix)` | double invalidation — 2 fetches for invoices list |
| Create invoice | `invalidate(invoicesQueryKey)` | `invalidate(invoicesQueryKey + invoiceQueryKey prefix)` | double invalidation |
| Update invoice | `setQueryData(invoice)` + `invalidate(invoicesQueryKey)` | `invalidate(invoicesQueryKey + invoiceQueryKey prefix)` | triple: setQueryData + 2 invalidations. The broadcast invalidation of the specific invoice key triggers a refetch that overwrites the optimistic setQueryData. |
| Delete invoice | **none** | `invalidate(invoicesQueryKey + invoiceQueryKey prefix)` | single invalidation — relies entirely on broadcast |
| Extraction complete | n/a (server-initiated) | `invalidate(invoicesQueryKey + invoiceQueryKey prefix)` | single invalidation |

**Issues:**
1. **Double/triple invalidation for the initiating client** — mutation `onSuccess` fires, then broadcast `onMessage` fires moments later. TanStack Query deduplicates concurrent fetches for the same key, so the actual network cost is usually 1 fetch, not 2. But the `setQueryData` in update's `onSuccess` gets overwritten by the broadcast-triggered refetch, making it pointless.
2. **`softDeleteInvoiceMutation` has no `onSuccess` invalidation** — relies entirely on broadcast. If WebSocket disconnects briefly, UI won't reflect the delete until manual refresh.
3. **Broadcast invalidation scope is broader than mutation invalidation** — broadcast invalidates both `invoicesQueryKey` AND `invoiceQueryKey` prefix, while mutations only invalidate `invoicesQueryKey`. This means broadcast is doing the right thing (invalidating the detail cache too) while mutations are incomplete.

## Activity feed implementation

`ActivityFeed` (`app.$organizationId.tsx`) uses a TanStack Query with `staleTime: Infinity` and a no-op `queryFn: () => []`. Data is injected purely via `setQueryData` in the `onMessage` handler. Client-only, ephemeral — resets on page refresh.

## Agent connection & auth

1. `useAgent` connects via PartySocket (WebSocket) to `/agents/organization-agent/{organizationId}`
2. `routeAgentRequest` in `worker.ts` intercepts this before TanStack Start's server entry
3. Auth checked in `onBeforeConnect` / `onBeforeRequest` via `authorizeAgentRequest`: validates session, checks `activeOrganizationId === agentName`, injects `x-organization-agent-user-id` header
4. `OrganizationAgent.onConnect` reads that header and sets connection state

## Agent context surface

`OrganizationAgentContext` (`src/lib/OrganizationAgentContext.tsx`) exposes `{ call, stub, ready, identified }` from `useAgent`. Consumer components use `stub` for typed RPC. `OrganizationAgentState` and `initialState` remain in `organization-agent.ts` because the `Agent<Env, State>` base class requires a state type parameter, even though agent state is not consumed on the client.

## Analysis

### What's good

- **`broadcastActivity` as an Effect**: wrapping `agent.broadcast()` in `Effect.sync` composes cleanly inside `Effect.gen` pipelines.
- **Schema-driven message decoding**: `decodeActivityMessage` uses `Schema.fromJsonString` composed with `Schema.decodeUnknownExit` — total function, no try/catch, no type assertion.
- **Centralized broadcast helper**: single `broadcastActivity` function, consistent shape, every broadcast goes through it.
- **Query key factories**: `activityQueryKey`, `invoicesQueryKey`, `invoiceQueryKey` in dedicated modules — consistent, refactor-friendly.
- **Agent SDK integration**: `useAgent` + `@callable()` gives typed RPC with automatic WebSocket lifecycle. Clean separation of transport from domain logic.
- **Single message type**: `ActivityMessage` serves as wire format, display type, and cache type — no envelope ceremony.
- **Structured `action` field**: invalidation decisions are a `Set.has()` lookup — no string-prefix matching, no silent misses from typos.
- **No unnecessary fetches from broadcast invalidation**: `invalidateQueries` defaults to `refetchType: 'active'`, so broadcast-triggered invalidation only refetches queries with mounted observers. If the user is on `/members` when an invoice is updated, the invoice queries get marked stale but no fetch fires until the user navigates back to invoices.

### Where it falls short

#### 1. Broadcast is fire-and-forget with no delivery guarantee
`agent.broadcast()` sends to all currently-connected WebSockets. If a client is disconnected during extraction, it misses the completion broadcast and the invoice stays in "extracting" state until manual refresh.

**Mitigations to consider**:
- Use `useAgent`'s `onOpen` to trigger `queryClient.invalidateQueries()` for stale-prone keys on reconnect
- Persist recent activity server-side (in DO SQLite) and hydrate on connect

#### 2. Dual invalidation is uncoordinated — use `onSettled` invalidation

The initiating client gets two invalidations for upload/create/update: one from mutation `onSuccess`, one from broadcast `onMessage`. The mutation path is also incomplete — it only invalidates `invoicesQueryKey` (the list), not the invoice detail cache. The broadcast path does the right thing (both list + detail prefix).

**Approach: `onSettled` invalidation, no `setQueryData`.**

Mutations use `onSettled` to invalidate the same query keys that broadcast invalidates. No `setQueryData` — let invalidation + refetch be the single data flow. `onSuccess` is reserved for side effects only (navigation, toast, form reset).

```ts
useMutation({
  mutationFn: (data) => stub.updateInvoice(data),
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: invoicesQueryKey(organizationId) })
    queryClient.invalidateQueries({ queryKey: invoiceQueryKey(organizationId, invoiceId) })
  },
  onSuccess: () => {
    // side effects only: navigate, reset form, etc.
  },
})
```

Why this works:
- **For the initiating client**: `onSettled` fires immediately after the mutation resolves — fast path, no WebSocket dependency.
- **For other clients**: broadcast `onMessage` fires — they don't have a mutation to settle.
- **Double invalidation causes two fetches**: `onSettled` fires immediately; the broadcast arrives over WebSocket tens/hundreds of ms later — different ticks. If the first fetch completes before the broadcast arrives, the broadcast triggers a second fetch. TanStack Query only deduplicates concurrent in-flight fetches (reuses the pending promise), not sequential ones. This is wasteful but not harmful — the second fetch returns identical data. Acceptable tradeoff for the resilience of having both paths (mutation doesn't depend on WebSocket, other clients don't depend on being the mutation initiator).
- **`onSettled` over `onSuccess`**: runs on both success AND error, so error recovery doesn't need separate handling.
- **No `setQueryData` to get overwritten**: the current `saveMutation.onSuccess` calls `setQueryData` which the broadcast immediately overwrites via refetch. Removing it simplifies the flow with no visible difference to the user (the refetch returns in ~the same time).

**Done** — all 4 mutations updated:
- `uploadMutation` (`invoices.index.tsx`) — moved `invalidateQueries` from `onSuccess` to `onSettled`
- `createInvoiceMutation` (`invoices.index.tsx`) — moved `invalidateQueries` from `onSuccess` to `onSettled`
- `saveMutation` (`invoices.$invoiceId.tsx`) — moved to `onSettled`, dropped `setQueryData`, added `invoiceQueryKey` invalidation
- `softDeleteInvoiceMutation` (`invoices.index.tsx`) — added `onSettled` with `invoicesQueryKey` (previously had no invalidation)

#### 3. `broadcastActivity` takes `this` (agent instance) as an argument
Every call site does `yield* broadcastActivity(this, { ... })`. Could be a method on `OrganizationAgent` for cleaner `this` binding.

#### 4. `OrganizationAgentContext` exposes transport primitives
`useOrganizationAgent()` returns raw WebSocket/RPC primitives. A domain-oriented hook like `useInvoiceActions()` would encapsulate RPC calls and handle error normalization, loading states, and invalidation.

#### 5. No backpressure or deduplication on rapid broadcasts
During batch upload, each file triggers its own broadcast and invalidation. TanStack Query deduplicates concurrent fetches, but the activity feed could flood.

#### 6. Deferred: `entityId` for targeted invalidation
Adding `entityId?: string` to `ActivityMessage` would enable targeted single-invoice invalidation (`["organization", orgId, "invoice", entityId]`) instead of the current broad prefix match on `["organization", orgId, "invoice"]`. Not needed at current scale — broad invalidation is fine. Revisit if invoice count grows or if single-invoice cache precision becomes valuable.

#### 7. Update mutation's `setQueryData` is overwritten by broadcast
`saveMutation.onSuccess` calls `setQueryData(invoiceQueryKey(...), invoice)` to optimistically update the detail cache, then `invalidateQueries(invoicesQueryKey)` for the list. Moments later, the broadcast arrives and calls `invalidateQueries(["org", id, "invoice"])` which triggers a refetch of the detail — overwriting the `setQueryData`. The optimistic update is pointless in practice because the broadcast-triggered refetch replaces it almost immediately. Addressed by the `onSettled` approach above — drop `setQueryData`, use invalidation only.

#### 8. `ensureQueryData` in loaders ignores invalidated queries without `revalidateIfStale`
See detailed analysis in "the `revalidateIfStale` gap" section above. All loader `ensureQueryData` calls should set `revalidateIfStale: true`.

## `router.invalidate()` vs `queryClient.invalidateQueries()`

Two different invalidation mechanisms are used in this codebase:

| Mechanism | Used by | What it does |
|---|---|---|
| `queryClient.invalidateQueries()` | Invoice mutations, broadcast handler | Marks matching TanStack Query cache entries stale, refetches active ones |
| `router.invalidate()` | Member, invitation, billing, admin mutations | Re-runs route loaders (which call `ensureQueryData`), effectively refreshing all loader-fetched data |

Non-invoice routes (members, invitations, billing) don't use TanStack Query directly — their data comes from route loaders via `Route.useLoaderData()`. So `router.invalidate()` is the correct mechanism for those. Invoice routes use TanStack Query for finer-grained cache control.

## Open questions

1. Do we want server-side activity persistence (DO SQLite) so clients can hydrate history on reconnect?
2. Do we need to handle WebSocket reconnect more explicitly (invalidate stale queries on `onOpen`)?

## Reference material consulted

- **Agents SDK**: `refs/agents/packages/agents/src/workflows.ts` — `AgentWorkflow<Agent, Params, ProgressType>` generic, `reportProgress(progress: ProgressType)`
- **Agents SDK**: `refs/agents/packages/agents/src/index.ts` — `onWorkflowProgress(name, id, progress: unknown)` receives untyped progress
- **Agents SDK**: `refs/agents/docs/client-sdk.md` — `useAgent` hook, `onMessage`, RPC via `stub`
- **Agents SDK**: `refs/agents/docs/state.md` — state sync, `broadcast()` — state sync uses separate internal channel, not `onMessage`
- **Cloudflare Docs**: `refs/cloudflare-docs/.../durable-objects/best-practices/websockets.mdx` — WebSocket hibernation, broadcast patterns
- **TanStack Query**: `refs/tan-query/docs/framework/react/guides/query-invalidation.md` — invalidation marks stale + refetches active
- **TanStack Query**: `refs/tan-query/packages/query-core/src/queryClient.ts:293-313` — `invalidateQueries` implementation, `refetchType` defaults to `'active'`
- **TanStack Query**: `refs/tan-query/packages/query-core/src/query.ts:272-276` — `isActive()` = has observers with enabled !== false
- **TanStack Query**: `refs/tan-query/docs/framework/react/guides/important-defaults.md` — `gcTime: 5min`, `staleTime: 0`, `refetchOnWindowFocus: true`
- **TanStack Query**: `refs/tan-query/docs/framework/react/guides/caching.md` — query lifecycle, active/inactive/gc states
- **TanStack Query**: `refs/tan-query/packages/query-core/src/queryClient.ts:140-164` — `ensureQueryData` implementation, `revalidateIfStale` behavior
- **TanStack Query**: `refs/tan-query/packages/query-core/src/query.ts:313-328` — `isStaleByTime()`, invalidated queries always return stale
- **TanStack Query**: `refs/tan-query/docs/framework/react/guides/invalidations-from-mutations.md` — idiomatic `onSettled` invalidation pattern
- **TanStack Query**: `refs/tan-query/docs/framework/react/guides/optimistic-updates.md` — optimistic update patterns, `cancelQueries` before `setQueryData`
