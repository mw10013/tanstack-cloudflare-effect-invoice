# Invoice Index Waterfall Fix

## The Problem

The invoice index page has a waterfall: the detail fetch cannot start until the list fetch finishes and selection is derived.

### Current fetch sequence (wall-clock)

```
[--- getInvoices (server fn) ---]
                                  [--- derive selectedInvoice ---]
                                  [--- getInvoice (server fn, component useQuery) ---]
```

Two serial round trips. The second one can't start until the first one returns because:

1. `getInvoices` returns `InvoiceListItem[]`
2. Component derives `selectedInvoice` from that list + `selectedInvoiceId` search param
3. Only then does `useQuery` for `getInvoice` become `enabled`

This is in `src/routes/app.$organizationId.invoices.index.tsx` lines 84-149.

The detail query is component-level, gated by `enabled`:

```tsx
const invoiceQuery = useQuery<InvoiceWithItems | null>({
  queryKey: [...invoiceQueryKey(organizationId, selectedInvoice?.id ?? ""), getInvoiceFn],
  queryFn: () => getInvoiceFn({ data: { organizationId, invoiceId: selectedInvoice?.id ?? "" } }),
  enabled: selectedInvoice !== null && selectedInvoice.status === "ready",
});
```

## The Fix

Move both fetches into the route loader. Use `loaderDeps` to key on `selectedInvoiceId` from search params.

### Why this works

When `selectedInvoiceId` is in the URL, the loader knows which invoice to fetch without waiting for the list. It can `Promise.all` both fetches. Zero waterfall.

When `selectedInvoiceId` is NOT in the URL, the loader fetches the list, picks the first invoice, and `throw redirect`s to include that ID in the URL. The redirected load then hits the parallel path.

### Fetch sequence after fix

With `selectedInvoiceId` in URL (the common case):

```
[--- getInvoices ---]
[--- getInvoice ----]      <- parallel, not serial
```

Without `selectedInvoiceId` in URL (first landing only):

```
[--- getInvoices ---]
                     [redirect to ?selectedInvoiceId=first.id]
                     [--- getInvoices ---]  <- cached/fast, already fetched
                     [--- getInvoice ----]  <- parallel
```

The redirect path only happens once per session. After that, every navigation has `selectedInvoiceId` in the URL.

## Decision: Always Normalize the URL

When the user lands on `/app/$organizationId/invoices/` with no `selectedInvoiceId`:

**Redirect to include `selectedInvoiceId` of the first invoice.**

No ambiguity. URL is always the single source of truth. The loader never has to guess or return a "virtual" selection that isn't reflected in the URL.

This is how TanStack Router handles it — `throw redirect` from a loader:

```tsx
// from refs/tan-start/e2e/react-start/basic/src/routes/redirect/$target/via-loader.tsx
loader: ({ params: { target } }) => {
  switch (target) {
    case 'internal':
      throw redirect({ to: '/posts' })
  }
},
```

## Concrete Route Shape

### Parent route (structural only)

`src/routes/app.$organizationId.invoices.tsx` becomes structural. No loader, no data.

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
```

Why: if the parent loader owns invoice list data, `router.invalidate` for the index route also re-runs the parent loader, which re-runs for the form route too. Parent must be empty to get selective invalidation.

### Index route

`src/routes/app.$organizationId.invoices.index.tsx`:

```tsx
const invoiceSearchSchema = Schema.Struct({
  selectedInvoiceId: Schema.optional(Schema.String),
});

export const Route = createFileRoute("/app/$organizationId/invoices/")({
  validateSearch: Schema.toStandardSchemaV1(invoiceSearchSchema),
  loaderDeps: ({ search }) => ({ selectedInvoiceId: search.selectedInvoiceId }),
  loader: async ({ params: { organizationId }, deps: { selectedInvoiceId } }) => {
    // case 1: selectedInvoiceId is known — parallel fetch
    if (selectedInvoiceId) {
      const [invoices, invoice] = await Promise.all([
        getInvoices({ data: { organizationId } }),
        getInvoice({ data: { organizationId, invoiceId: selectedInvoiceId } }),
      ]);
      return { invoices, selectedInvoiceId, invoice };
    }

    // case 2: no selectedInvoiceId — fetch list, redirect to first
    const invoices = await getInvoices({ data: { organizationId } });
    const first = invoices[0];
    if (first) {
      throw redirect({
        to: "/app/$organizationId/invoices",
        params: { organizationId },
        search: { selectedInvoiceId: first.id },
        replace: true,
      });
    }

    // case 3: no invoices at all
    return { invoices: [], selectedInvoiceId: undefined, invoice: null };
  },
  component: RouteComponent,
});
```

### What `loaderDeps` does here

`loaderDeps` declares that `selectedInvoiceId` is a cache key for this route's loader.

From `refs/tan-start/docs/router/guide/data-loading.md` line 92:

> `deps` - The object value returned from the `Route.loaderDeps` function

When `selectedInvoiceId` changes (user clicks a row, URL updates), the router sees the deps changed and re-runs the loader. This is how search-param-driven loading works in TanStack Router.

### Component reads loader data only

```tsx
function RouteComponent() {
  const { invoices, selectedInvoiceId, invoice } = Route.useLoaderData();
  // ...render from loader data, no useQuery needed for list or detail
}
```

No `useQuery` for invoices list. No `useQuery` for invoice detail. Both come from the loader.

## What About the `getInvoice` `enabled` Guard?

Currently, the detail query only fires when `selectedInvoice.status === "ready"`. In the loader version:

```tsx
if (selectedInvoiceId) {
  const [invoices, invoice] = await Promise.all([
    getInvoices({ data: { organizationId } }),
    getInvoice({ data: { organizationId, invoiceId: selectedInvoiceId } }),
  ]);
  return { invoices, selectedInvoiceId, invoice };
}
```

This fetches the detail even if the invoice isn't `ready`. Two options:

**Option A: Always fetch detail, let it return null for non-ready invoices.**

The server fn `getInvoice` already returns `null` when appropriate. The component already handles null. This is simpler — no conditional logic in the loader.

**Option B: Fetch list first, check status, then conditionally fetch detail.**

```tsx
const invoices = await getInvoices({ data: { organizationId } });
const selected = invoices.find(i => i.id === selectedInvoiceId);
const invoice = selected?.status === "ready"
  ? await getInvoice({ data: { organizationId, invoiceId: selectedInvoiceId } })
  : null;
return { invoices, selectedInvoiceId, invoice };
```

This re-introduces the waterfall. Only do this if fetching detail for a non-ready invoice is expensive or errors.

**Recommendation: Option A.** Fetch in parallel unconditionally. The server fn is cheap for non-ready invoices (it just returns the row, which has empty fields). The component already handles `invoice: null` and non-ready statuses.

If `getInvoice` actually errors for non-ready invoices (rather than returning null), wrap it:

```tsx
const invoiceResult = await getInvoice({ data: { organizationId, invoiceId: selectedInvoiceId } })
  .catch(() => null);
```

## What About Live Updates (Websocket Broadcasts)?

Currently: broadcasts trigger `queryClient.invalidateQueries(...)` in `src/routes/app.$organizationId.tsx`.

After this change: broadcasts trigger `router.invalidate(...)` with a filter.

```tsx
// in src/routes/app.$organizationId.tsx onMessage handler
if (shouldInvalidateForInvoice(message.action)) {
  void router.invalidate({
    filter: (match) => match.routeId === "/app/$organizationId/invoices/",
  });
}
```

From `refs/tan-start/docs/router/api/router/RouterType.md` line 139:

> `.invalidate` - Invalidates route matches by forcing their `beforeLoad` and `load` functions to be called again.
> if `filter` is supplied, only matches for which `filter` returns `true` will be invalidated.

This means:
- When user is on the index route: loader re-runs, list and detail refresh
- When user is on the form route (`/invoices/$invoiceId`): index loader does NOT re-run
- When user navigates back to index: stale match triggers a reload

## What About Row Clicks?

Row clicks update `selectedInvoiceId` in the URL:

```tsx
void navigate({
  to: "/app/$organizationId/invoices",
  params: { organizationId },
  search: { selectedInvoiceId: invoice.id },
  replace: true,
});
```

Because `loaderDeps` includes `selectedInvoiceId`, changing it re-runs the loader. The loader fetches both list and detail in parallel.

**Tradeoff vs current behavior:** Currently, switching rows reads the list from query cache (instant) and only fetches the detail. With the loader approach, switching rows re-runs the full loader (list + detail). The list fetch is fast (same worker, same D1), but it's not a local cache read.

This is acceptable because:
- Both fetches happen server-side in the same worker, not over the internet
- The list query hits D1 which is fast
- The loader result is cached by the router until deps change or invalidation

## What Gets Removed

1. `useQuery` for invoices list in the index component
2. `useQuery` for invoice detail in the index component  
3. `ensureQueryData` in the parent invoices route loader
4. `queryClient.invalidateQueries` calls for invoice keys (replaced by `router.invalidate`)
5. The parent route's loader entirely

## What Stays

1. `useMutation` for upload, create, delete — these are user actions, not data loading
2. `useAgent` / websocket in the organization layout — still the notification channel
3. Mutation `onSuccess` handlers that navigate or set search params
4. Mutation `onSettled` handlers change from `queryClient.invalidateQueries` to `router.invalidate`

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| List fetch | Parent loader → query cache → `useQuery` | Index loader → `Route.useLoaderData()` |
| Detail fetch | Component `useQuery` with `enabled` guard | Index loader, parallel with list |
| Selection source | URL search params | URL search params (unchanged) |
| No `selectedInvoiceId` in URL | Falls back to `invoices[0]` silently | `throw redirect` to include first invoice ID |
| Waterfall | Two serial round trips | One parallel fetch (or redirect + parallel) |
| Live updates | `queryClient.invalidateQueries` | `router.invalidate({ filter })` |
| Row switch cost | Cache read (list) + fetch (detail) | Loader re-run (list + detail, same worker) |
