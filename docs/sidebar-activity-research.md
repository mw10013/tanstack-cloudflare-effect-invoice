# Sidebar Activity UI Research

## Problem

Add a persistent activity feed to the sidebar so it's visible across all `/app/$organizationId/*` routes. Must coexist with the existing activity card on the invoices route without creating duplicate WebSocket connections.

## Critical Finding: Duplicate WebSocket Risk

`useAgent` wraps `usePartySocket` (line 459 of `refs/agents/.../react.tsx`) which creates a **new WebSocket per hook instance**. There is no built-in connection deduplication. Two `useAgent` calls with the same `{agent, name}` = two WebSocket connections to the same Durable Object.

```tsx
// refs/agents/packages/agents/src/react.tsx:459
const agent = usePartySocket({
  ...socketOptions,
  enabled: socketEnabled,
  onMessage: (message) => { ... },
});
```

This means naively adding `useAgent` in both the sidebar and the invoices route **will** create 2 concurrent WebSockets.

## Architecture Options

### Option A: Lift `useAgent` to Layout Route, Share via Query Cache (Recommended)

Move the single `useAgent` call to `app.$organizationId.tsx` (the layout route that renders `<AppSidebar>` + `<Outlet>`). Use React Query cache as the shared data bus.

**How it works:**

1. `useAgent` in the layout route's `RouteComponent` handles the single WebSocket
2. `onMessage` callback writes activity messages into the query cache via `queryClient.setQueryData(activityQueryKey(organizationId), ...)`
3. `onMessage` also calls `router.invalidate()` + `queryClient.invalidateQueries(...)` for invoice-related activity (same logic as today)
4. Sidebar reads from query cache via `useQuery({ queryKey: activityQueryKey(organizationId) })`
5. Invoices route reads from the same query cache — no more `useAgent` needed there

```
app.$organizationId.tsx (layout)
├── useAgent (single WebSocket)
│   └── onMessage → queryClient.setQueryData(activityQueryKey, ...)
│                  → router.invalidate() (when invoice-related)
│                  → queryClient.invalidateQueries(invoiceItems)
├── <AppSidebar>
│   └── useQuery(activityQueryKey) → renders activity feed
└── <Outlet>
    └── invoices.tsx
        └── useQuery(activityQueryKey) → renders activity card (reads same cache)
```

**Pros:**

- Single WebSocket, zero duplication
- Both consumers read from the same React Query cache entry
- Activity feed persists across route navigations (sidebar never unmounts)
- Follows TanStack pattern: layout route manages shared concerns, query cache is the data bus
- Invoices route simplifies (removes useAgent, keeps useQuery)

**Cons:**

- Moves WebSocket lifecycle up to layout — all child routes get invalidation even if they don't care
- Tighter coupling between layout route and invoice-specific invalidation logic

**Migration path:**

1. Add `useAgent` + `onMessage` logic to `app.$organizationId.tsx` RouteComponent
2. Add activity UI to AppSidebar (reads from query cache)
3. Remove `useAgent` from invoices route, keep `useQuery(activityQueryKey)` for the existing activity card
4. Extract `shouldInvalidateForActivity` + invalidation logic to shared module

### Option B: Shared Context Provider

Create a React context that wraps `useAgent` and provides the connection + messages to the tree.

```tsx
// src/lib/OrganizationActivityProvider.tsx
const OrganizationActivityContext = React.createContext<{
  messages: readonly ActivityMessage[];
} | null>(null);

function OrganizationActivityProvider({ organizationId, children }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [messages, setMessages] = React.useState<readonly ActivityMessage[]>(
    [],
  );

  useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      // decode, update cache, invalidate...
    },
  });

  return (
    <OrganizationActivityContext value={{ messages }}>
      {children}
    </OrganizationActivityContext>
  );
}
```

**Pros:**

- Clean API for consumers (`useOrganizationActivity()`)
- Encapsulates WebSocket + decoding logic

**Cons:**

- Redundant with query cache (context duplicates what setQueryData already provides)
- Extra abstraction layer with minimal benefit over Option A
- React context re-renders all consumers on every message

### Option C: Conditional `useAgent` with `enabled` Flag

Keep `useAgent` in both locations but disable the invoices one when sidebar is active.

```tsx
// sidebar
useAgent({ agent: "organization-agent", name: organizationId, enabled: true });

// invoices route
useAgent({ agent: "organization-agent", name: organizationId, enabled: false });
```

**Cons:**

- Fragile coordination (which one is "primary"?)
- Invoices route loses real-time updates when sidebar owns the connection
- Doesn't solve the data sharing problem

**Not recommended.**

## Recommendation: Option A

Option A is the simplest, uses existing TanStack primitives (query cache as shared state), and requires the least new abstraction. The layout route already manages the sidebar and organization context — adding the WebSocket connection there is natural.

## Sidebar UI Considerations

The sidebar uses the Base UI sidebar component system (`src/components/ui/sidebar.tsx`). Activity feed placement options:

**Below nav menu, above footer:**

```
┌──────────────────────┐
│ Logo + Org Switcher   │  SidebarHeader
├──────────────────────┤
│ Home                  │
│ Agent                 │  SidebarContent > SidebarGroup
│ Invoices              │
│ ...                   │
├──────────────────────┤
│ ● Invoice uploaded    │
│ ● Extraction done     │  SidebarContent > SidebarGroup (new)
│ ● ...                 │  (ScrollArea, compact badges)
├──────────────────────┤
│ user@email.com ▾      │  SidebarFooter
└──────────────────────┘
```

Use a second `SidebarGroup` at the bottom of `SidebarContent` with `className="mt-auto"` to push it down. Keep items compact — small text, dot indicators instead of full badges, relative timestamps.

When sidebar is collapsed (icon mode), the activity group could show a dot/badge indicator for unread count, or hide entirely.

## Key Files to Modify

1. `src/routes/app.$organizationId.tsx` — add `useAgent`, pass activity to sidebar
2. `src/routes/app.$organizationId.invoices.tsx` — remove `useAgent`, keep `useQuery(activityQueryKey)`
3. `src/lib/Activity.ts` — potentially add shared helpers (activityQueryKey, shouldInvalidateForActivity, decodeActivityMessage)

## Open Questions

1. Should the sidebar activity show all messages or just recent N? (Currently capped at 100 in query cache)

show all with scroll. most recent at top. cap should probably be smaller in the cache

2. Unread indicator when sidebar is collapsed?

yes

3. Should clicking an activity message navigate to the relevant invoice?

no

4. Should the invoices route activity card be removed entirely once sidebar has it, or keep both?

will be removed.

5. Filter by type? (e.g., sidebar shows all, invoices card shows only invoice-related)

no filter

I agree we should push on Option A (lift useAgent). remove the other options to make the md more concise.

The tricky thing about lifting useAgent is that I think we'll need other aspects of it in nested components, not just the messages which will be handled by tanstack query. So I have a concern about that. I would like to lift and have only one useAgent, of course, but how to do that correctly.

In the cons, i don't understand what all child routes get invalidation means. explain with examples and negative impacts. use mermaid diagrams if helpful

You also mention a tighter coupling between layout route and invoice invalidation logic. Say more about that. we will have many other routes that need useAgent functionality in the future.
