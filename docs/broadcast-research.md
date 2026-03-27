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

All broadcasts originate from `OrganizationAgent` (`src/organization-agent.ts`) via the `broadcastActivity` helper (L59-74), which wraps `agent.broadcast()` from the Cloudflare Agents SDK.

| Trigger | Text prefix | Level | Source line |
|---|---|---|---|
| `onInvoiceUpload` | `"Invoice uploaded: {fileName}"` | info | L190 |
| `createInvoice` | `"Invoice created"` | info | L226 |
| `updateInvoice` | `"Invoice updated: {name}"` | success | L262 |
| `softDeleteInvoice` | `"Invoice deleted"` | info | L321 |
| `saveExtraction` | `"Invoice extraction completed: {fileName}"` | success | L341 |
| `onWorkflowProgress` | Forwarded from workflow | varies | L360 |
| `onWorkflowError` | `"Invoice extraction failed: {fileName}"` | error | L377 |

The workflow itself (`InvoiceExtractionWorkflow`, `src/invoice-extraction-workflow.ts`) reports progress via `this.reportProgress()` which the Agent SDK routes to `onWorkflowProgress`, which then re-broadcasts as activity.

## Message schema & decoding

Defined in `src/lib/Activity.ts`:

```ts
// Envelope over the wire (JSON string in WebSocket message)
ActivityEnvelope = { type: "activity", message: ActivityMessage }
ActivityMessage  = { createdAt: string, level: "info"|"success"|"error", text: string }
WorkflowProgress = { level: ..., text: ... }  // subset for workflow reporting
```

Decoding uses Effect Schema: `Schema.decodeUnknownExit(Schema.fromJsonString(ActivityEnvelopeSchema))` — clean, composable, returns Exit so null on failure.

## Do broadcasts trigger query invalidation?

**Yes.** In `src/routes/app.$organizationId.tsx` L120-136:

```ts
onMessage: (event) => {
  const message = decodeActivityMessage(event);
  if (!message) return;
  // 1. Append to activity feed cache
  queryClient.setQueryData(activityQueryKey(organizationId), ...);
  // 2. Conditionally invalidate invoice-related queries
  if (shouldInvalidateForInvoice(message.text)) {
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoices"] });
    queryClient.invalidateQueries({ queryKey: ["organization", organizationId, "invoice"] });
  }
}
```

`shouldInvalidateForInvoice` (Activity.ts L38-42) checks for these prefixes:
- `"Invoice uploaded:"`
- `"Invoice extraction completed:"`
- `"Invoice extraction failed:"`
- `"Invoice updated:"`
- `"Invoice deleted"`

**Notable:** `"Invoice created"` does NOT trigger invalidation via broadcast. The `createInvoiceMutation.onSuccess` handles it locally instead.

## Dual invalidation: broadcast + mutation onSuccess

Several mutations invalidate queries in BOTH their `onSuccess` AND via broadcast:

| Action | Mutation onSuccess invalidation | Broadcast invalidation |
|---|---|---|
| Upload invoice | `invoicesQueryKey` (invoices.index L107) | `shouldInvalidateForInvoice("Invoice uploaded:")` → yes |
| Create invoice | `invoicesQueryKey` (invoices.index L117) | `shouldInvalidateForInvoice("Invoice created")` → **no** (no match) |
| Update invoice | `invoicesQueryKey` (invoices.$invoiceId L166) | `shouldInvalidateForInvoice("Invoice updated:")` → yes |
| Delete invoice | **none** | `shouldInvalidateForInvoice("Invoice deleted")` → yes |
| Extraction complete | n/a (server-initiated) | yes |

**Issues:**
1. Upload and update invoke double-invalidation for the initiating client — once from mutation `onSuccess` and again from broadcast `onMessage`. This is harmless but wasteful.
2. `softDeleteInvoiceMutation` has no `onSuccess` invalidation — relies entirely on broadcast. If the WebSocket disconnects briefly, the UI won't reflect the delete until manual refresh.
3. `"Invoice created"` misses broadcast invalidation entirely — it's not in the `shouldInvalidateForInvoice` check list. The mutation `onSuccess` is the only invalidation path for the initiating client, and other connected clients won't see the new invoice until their next query refetch.

## Activity feed implementation

`ActivityFeed` (`app.$organizationId.tsx` L299-341) uses a TanStack Query with `staleTime: Infinity` and a no-op `queryFn: () => []`. Data is injected purely via `setQueryData` in the `onMessage` handler. This is a client-only, ephemeral feed — no persistence, no server fetch, resets on page refresh.

## Agent connection & auth

1. `useAgent` connects via PartySocket (WebSocket) to `/agents/organization-agent/{organizationId}`
2. `routeAgentRequest` in `worker.ts` L240 intercepts this before TanStack Start's server entry
3. Auth is checked in `onBeforeConnect` / `onBeforeRequest` via `authorizeAgentRequest` (worker.ts L207-222): validates session, checks `activeOrganizationId === agentName`, injects `x-organization-agent-user-id` header
4. `OrganizationAgent.onConnect` (L138-148) reads that header and sets connection state

## Agent context surface

`OrganizationAgentContext` (`src/lib/OrganizationAgentContext.tsx`) exposes `{ call, stub, ready, identified }` from `useAgent`. Consumer components use `stub` for typed RPC (e.g., `stub.uploadInvoice(...)`, `stub.createInvoice()`). `OrganizationAgentState` and `initialState` remain in `organization-agent.ts` because the `Agent<Env, State>` base class requires a state type parameter, even though agent state is not consumed on the client.

## Analysis: functional / idiomatic patterns

### What's good

- **`broadcastActivity` as an Effect**: wrapping `agent.broadcast()` in `Effect.sync` composes cleanly inside `Effect.gen` pipelines — broadcasts are just another step in the effect chain.
- **Schema-driven message decoding**: `decodeActivityMessage` uses `Schema.fromJsonString` composed with `Schema.decodeUnknownExit` — total function, no try/catch, no type assertion.
- **Centralized broadcast helper**: single `broadcastActivity` function, consistent envelope shape, every broadcast goes through it.
- **Query key factories**: `activityQueryKey`, `invoicesQueryKey`, `invoiceQueryKey` in dedicated modules — consistent, refactor-friendly.
- **Agent SDK integration**: `useAgent` + `@callable()` gives typed RPC with automatic WebSocket lifecycle. Clean separation of transport from domain logic.

### Where it falls short

#### 1. String-based message discrimination is fragile
`shouldInvalidateForInvoice` pattern-matches on `text.startsWith("Invoice uploaded:")` etc. Adding a new broadcast requires coordinating a string literal in the agent AND a prefix check on the client. A typo or missing colon (see "Invoice created" above) silently breaks invalidation.

**Alternative**: Add a structured `action` field to `ActivityEnvelope`:
```ts
ActivityEnvelope = {
  type: "activity",
  action: "invoice.uploaded" | "invoice.created" | "invoice.updated" | "invoice.deleted" | "invoice.extraction.completed" | "invoice.extraction.failed" | "workflow.progress",
  message: ActivityMessage,
  entityId?: string  // invoice id for targeted invalidation
}
```
Then `shouldInvalidateForInvoice` becomes a set lookup on `action`, and targeted single-invoice invalidation becomes possible.

#### 2. No message-type discrimination beyond "activity"
The `type` field is always `"activity"`. If we ever need non-activity broadcasts (e.g., presence, notifications), the current envelope is too narrow. Custom message types would need the envelope to be extensible — a discriminated union with `Schema.Union`.

#### 3. Broadcast is fire-and-forget with no delivery guarantee
`agent.broadcast()` sends to all currently-connected WebSockets. If a client is disconnected during an extraction workflow (which can take seconds), it misses the completion broadcast and the invoice stays in "extracting" state until manual refresh. 

**Mitigations to consider**:
- On WebSocket reconnect, refetch active queries (TanStack Query's `refetchOnWindowFocus` covers tab-switch, but not WebSocket reconnect specifically)
- Use `useAgent`'s `onOpen` to trigger `queryClient.invalidateQueries()` for stale-prone keys
- Persist recent activity server-side (in DO SQLite) and hydrate on connect

#### 4. Dual invalidation is uncoordinated
The initiating client gets two invalidations for upload/update: one from mutation `onSuccess`, one from broadcast. Other clients only get the broadcast one. This asymmetry isn't harmful but suggests the invalidation strategy isn't principled.

**Principled approach**: mutations should NOT invalidate — let broadcast be the single source of truth for cache freshness. The mutation `onSuccess` should handle optimistic UI updates (navigate, select) only. This way all clients have the same invalidation path.

Exception: `createInvoice` doesn't broadcast an invalidation-triggering message, so if we remove `onSuccess` invalidation, the initiating client wouldn't see the new invoice. Fix: make "Invoice created" trigger invalidation too (add to `shouldInvalidateForInvoice` or, better, add the structured `action` field).

#### 5. `broadcastActivity` takes `this` (agent instance) as an argument
```ts
const broadcastActivity = (agent: OrganizationAgent, input: { level, text }) =>
  Effect.sync(() => { agent.broadcast(...) })
```
Every call site does `yield* broadcastActivity(this, { ... })`. In Effect v4 idiomatic patterns, this would typically be a service method or use `Effect.fn` with context. Since `broadcastActivity` depends on the agent instance (not an Effect service), it's more of a utility, but it could be a method on `OrganizationAgent` itself for cleaner `this` binding:
```ts
private broadcastActivity = Effect.fn("broadcastActivity")(
  ({ level, text }: { level: WorkflowProgress["level"]; text: string }) =>
    Effect.sync(() => { this.broadcast(JSON.stringify({ type: "activity", message: { ... } })) })
);
```

#### 6. `OrganizationAgentContext` exposes transport primitives
`useOrganizationAgent()` returns `{ call, stub, ready, identified }` — raw WebSocket/RPC primitives. Consumer components like `invoices.index.tsx` do `stub.uploadInvoice(...)` directly. A domain-oriented hook like `useInvoiceActions()` would encapsulate the RPC calls and could handle error normalization, loading states, and invalidation in one place.

#### 7. Activity data isn't typed beyond display text
The `ActivityMessage` carries `{ createdAt, level, text }` — purely for display. There's no structured payload for consumers to act on. The `text` field doubles as both display label AND invalidation discriminator. Separating concerns (display text vs. machine-readable action + entity) would be cleaner.

#### 8. No backpressure or deduplication on rapid broadcasts
During a batch upload (multiple files), each file triggers its own broadcast. The client's `onMessage` fires `invalidateQueries` per message. TanStack Query deduplicates concurrent fetches for the same query key, so this is mostly fine, but the activity feed could flood. Consider batching or debouncing invalidation.

## Reference material consulted

- **Agents SDK**: `refs/agents/docs/client-sdk.md` — `useAgent` hook, `onMessage`, RPC via `stub`
- **Agents SDK**: `refs/agents/docs/state.md` — state sync, `broadcast()`, `onStateChanged`
- **Cloudflare Docs**: `refs/cloudflare-docs/.../durable-objects/best-practices/websockets.mdx` — WebSocket hibernation, `getWebSockets()`, broadcast patterns
- **Cloudflare Docs**: `refs/cloudflare-docs/.../r2/buckets/event-notifications.mdx` — R2 → Queue flow
- **Effect v4**: `refs/effect4/ai-docs/src/01_effect/06_pubsub/` — PubSub for fan-out messaging (not currently used; could be relevant for in-process broadcast coordination)
- **Effect v4**: `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Users.ts` — `Effect.fn` + service patterns
- **TanStack Query**: invalidation patterns, `setQueryData`, `invalidateQueries`

## Dead code removed

- **`onStateUpdate` + `agentState` query key**: `useAgent`'s `onStateUpdate` callback wrote to `["organization", organizationId, "agentState"]` — never consumed by any component. Removed callback and query key. `OrganizationAgentState` and `initialState` remain in `organization-agent.ts` because the `Agent<Env, State>` base class requires them.
- **`setState` from context**: `OrganizationAgentContext` exposed `setState` — never called by any consumer. Removed from interface and provider value.
- **`invoiceItems` query key invalidation**: `onMessage` invalidated `["organization", organizationId, "invoiceItems"]` — this query key was never used by any `useQuery`. Invoice items are fetched via `invoiceQueryKey` (`getInvoiceWithItems`), which is already invalidated via the `"invoice"` prefix. Removed.

## Questions for iteration

1. Should we adopt a structured `action` discriminator on the envelope, or keep string-matching and just fix the gaps?
2. Do we want server-side activity persistence (DO SQLite) so clients can hydrate history on reconnect?
3. Should mutations stop doing their own invalidation and defer entirely to broadcast? Or keep the dual path as a "fast path" optimization?
4. Do we need to handle WebSocket reconnect more explicitly (invalidate stale queries on `onOpen`)?
