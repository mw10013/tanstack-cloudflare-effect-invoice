# Invoice Index Data Loading Research

## Recommendation

Move invoice index **reads** to TanStack Start/TanStack Router loaders and `Route.useLoaderData()`. Keep invoice **writes** in `useMutation`.

Also make `selectedInvoiceId` a strict URL concern with these rules:

- no `selectedInvoiceId`: render the index page with **no selection**
- valid `selectedInvoiceId`: render that selection
- invalid `selectedInvoiceId`: treat it as an **invalid optional selection**, normalize the URL, and render with **no selection**

Do **not** silently fall back to the first invoice when the URL asks for a different one.

Do **not** turn the whole index route into a 404 for a stale `selectedInvoiceId` search param.

The path route `/app/$organizationId/invoices/$invoiceId` is different: its `invoiceId` is route identity, so missing data there should keep using `notFound()`.

## Why Change It

Today the invoices index route mixes two data-loading models.

Current parent route:

`src/routes/app.$organizationId.invoices.tsx`

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: async ({ params: { organizationId }, context }) => {
    await context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
      revalidateIfStale: true,
    });
  },
  component: RouteComponent,
});
```

Current index route:

`src/routes/app.$organizationId.invoices.index.tsx`

```tsx
const invoicesQuery = useQuery({
  queryKey: invoicesQueryKey(organizationId),
  queryFn: () => getInvoices({ data: { organizationId } }),
});

const selectedInvoice =
  invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? invoices[0] ?? null;

const invoiceQuery = useQuery<InvoiceWithItems | null>({
  queryKey: [
    ...invoiceQueryKey(organizationId, selectedInvoice?.id ?? ""),
    getInvoiceFn,
  ],
  queryFn: () =>
    getInvoiceFn({
      data: { organizationId, invoiceId: selectedInvoice?.id ?? "" },
    }),
  enabled: selectedInvoice !== null && selectedInvoice.status === "ready",
});
```

That creates three problems:

- read path is split across loader-prefetch, `useQuery` for list, and `useQuery` for detail
- selection semantics are muddy because the URL can say one invoice while the UI shows `invoices[0]`
- broadcast refresh is wired to query keys, not route boundaries

The current fallback is the biggest conceptual problem:

```tsx
const selectedInvoice =
  invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? invoices[0] ?? null;
```

If `selectedInvoiceId` is absent, that fallback auto-selects the first invoice.

If `selectedInvoiceId` is present but invalid, it also auto-selects the first invoice.

Those are two different states and they should not collapse into the same behavior.

## TanStack Grounding

TanStack Router's data-loading guide makes the intended model explicit:

`refs/tan-router/docs/router/guide/data-loading.md`

```md
Using these dependencies as keys, TanStack Router will cache the data returned
from a route's `loader` function...
```

```md
To consume data from a `loader`, use the `useLoaderData` hook defined on your
Route object.
```

It also explicitly calls out `loaderDeps` for search-param-driven loading:

```md
loaderDeps: ({ search: { offset, limit } }) => ({ offset, limit })
```

And:

```md
Only include dependencies you actually use in the loader.
```

That matches this invoice case well. `selectedInvoiceId` is already URL state, so the index route can own it through `validateSearch` + `loaderDeps` + `loader` + `Route.useLoaderData()`.

TanStack Start examples also show plain loader data as a normal route pattern:

`refs/tan-start/examples/react/authenticated-routes/src/routes/_auth.invoices.tsx`

```tsx
export const Route = createFileRoute('/_auth/invoices')({
  loader: async () => ({
    invoices: await fetchInvoices(),
  }),
  component: InvoicesRoute,
})

function InvoicesRoute() {
  const { invoices } = Route.useLoaderData()
}
```

For mutations, TanStack Router docs keep the story separate:

`refs/tan-router/docs/router/guide/data-mutations.md`

```md
When mutations related to loader data are made, we can use `router.invalidate`
to force the router to reload all of the current route matches
```

And the Start tutorial uses exactly that pattern:

`refs/tan-router/docs/start/framework/react/tutorial/reading-writing-file.md`

```tsx
await addJoke({ ... })
router.invalidate()
```

That lines up with your desired split:

- loader data for reads
- `useMutation` for writes

## Why Query Is Not Buying Much Here

TanStack Router's external-data-loading guide recommends loaders when you do use Query:

`refs/tan-router/docs/router/guide/external-data-loading.md`

```md
The easiest way to integrate external caching/data library into Router is to use
`route.loader`s to ensure that the data required inside of a route has been loaded
and is ready to be displayed.
```

That is a good fit when you want Query's cache semantics on top of route coordination.

But on this page, the current Query usage is mostly compensating for page design choices that can be expressed more directly in the route loader:

- list fetch
- derive selected row from URL
- optionally fetch selected invoice detail
- render loader data

Also, the current detail query relies on `enabled`. TanStack Query docs say:

`refs/tan-query/docs/framework/react/guides/disabling-queries.md`

```md
When `enabled` is `false`:
- The query will not automatically fetch on mount.
- The query will not automatically refetch in the background.
- The query will ignore query client `invalidateQueries` ... calls
```

That is part of why the current model feels indirect. If an invoice is selected but not `ready`, the detail query ignores invalidation until the list query updates first and flips the gate.

Moving the read model into the index loader removes that split-brain behavior.

## Recommended Route Shape

Make the parent invoices route structural only.

Keep:

`src/routes/app.$organizationId.invoices.tsx`

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
```

Move the index page data ownership into:

- `src/routes/app.$organizationId.invoices.index.tsx`

That route should own:

- `validateSearch`
- `loaderDeps: ({ search: { selectedInvoiceId } }) => ({ selectedInvoiceId })`
- the list fetch
- selected-invoice resolution
- optional selected-invoice detail fetch

This gives clean invalidation boundaries:

- index route owns index screen data
- edit route `/app/$organizationId/invoices/$invoiceId` owns edit screen data

That boundary matters for broadcasts.

## Recommended Selection Semantics

Treat `selectedInvoiceId` as **optional view state**, not route identity.

That means:

| URL state | Meaning | Behavior |
| --- | --- | --- |
| no `selectedInvoiceId` | no invoice selected | show list + empty detail panel |
| valid `selectedInvoiceId` | user selected an invoice | show that invoice |
| invalid `selectedInvoiceId` | stale or invalid optional UI state | normalize URL to no selection |

### Why invalid search should not become `notFound()`

Because the page is still valid.

`/app/$organizationId/invoices` is the resource.

`selectedInvoiceId` is optional state for that resource.

A stale search param should not blow away the entire invoices workspace.

### Why invalid search should not fall back to the first invoice

Because that makes the URL lie.

If the URL says `selectedInvoiceId=abc` and the UI shows invoice `xyz`, the URL is no longer the source of truth.

### Recommended normalization rule

If `selectedInvoiceId` is present but does not match an invoice in the list, redirect to the same route with `selectedInvoiceId` removed.

That is the same general pattern already used elsewhere in this repo for invalid search state:

`src/routes/admin.users.tsx`

```tsx
if (deps.page > result.pageCount) {
  throw redirect({
    to: "/admin/users",
    search: { page: result.pageCount, filter: deps.filter },
  });
}
```

Use the same idea here:

- invalid optional search input gets canonicalized
- canonical URL matches rendered state

## Suggested Loader Shape

Sketch:

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices/")({
  validateSearch: Schema.toStandardSchemaV1(invoiceSearchSchema),
  loaderDeps: ({ search: { selectedInvoiceId } }) => ({ selectedInvoiceId }),
  loader: async ({ params: { organizationId }, deps: { selectedInvoiceId } }) => {
    const invoices = await getInvoices({ data: { organizationId } });

    if (!selectedInvoiceId) {
      return {
        invoices,
        selectedInvoiceId: null,
        selectedInvoice: null,
        invoice: null,
      };
    }

    const selectedInvoice =
      invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? null;

    if (!selectedInvoice) {
      throw redirect({
        to: "/app/$organizationId/invoices",
        params: { organizationId },
        search: {},
      });
    }

    const invoice =
      selectedInvoice.status === "ready"
        ? await getInvoice({ data: { organizationId, invoiceId: selectedInvoice.id } })
        : null;

    return {
      invoices,
      selectedInvoiceId: selectedInvoice.id,
      selectedInvoice,
      invoice,
    };
  },
  component: RouteComponent,
});
```

Important detail: if no selection is present, do not fetch detail.

That is both simpler and cheaper.

## Waterfall Discussion

There is still a dependency here:

1. load invoices list
2. resolve whether `selectedInvoiceId` exists and what its status is
3. maybe load full selected invoice detail

That dependency does **not** disappear.

But it moves from a client-side component/query relationship into the route loader.

That is a good trade here:

- first render comes from loader data
- the component does not coordinate data fetching itself
- selection logic lives in one place

## Broadcast / Agent Invalidation

Cloudflare Agents docs describe `useAgent` as:

`refs/agents/docs/client-sdk.md`

```md
| `useAgent`    | React hook with automatic reconnection and state management |
```

and:

```md
- Auto-reconnection - Built on PartySocket for reliable connections
```

Broadcasting is standard WebSocket fan-out:

`refs/agents/docs/http-websockets.md`

```tsx
this.broadcast(JSON.stringify({ type: "update", data: "..." }));
```

Routing is instance-based:

`refs/agents/docs/routing.md`

```txt
/agents/{agent-name}/{instance-name}
```

So the current organization-level `useAgent({ agent: "organization-agent", name: organizationId })` placement is correct and should stay.

What should change is the invalidation target.

Today the layout invalidates Query keys:

`src/routes/app.$organizationId.tsx`

```tsx
if (shouldInvalidateForInvoice(message.action)) {
  void queryClient.invalidateQueries({
    queryKey: ["organization", organizationId, "invoices"],
  });
  void queryClient.invalidateQueries({
    queryKey: ["organization", organizationId, "invoice"],
  });
}
```

For a loader-data index route, switch that policy to route invalidation.

TanStack Router supports route-filtered invalidation in its router type:

`refs/tan-router/packages/router-core/src/router.ts`

```ts
export type InvalidateFn<TRouter extends AnyRouter> = (opts?: {
  filter?: (d: MakeRouteMatchUnion<TRouter>) => boolean
  sync?: boolean
  forcePending?: boolean
}) => Promise<void>
```

Recommended policy:

- keep `useAgent` in `src/routes/app.$organizationId.tsx`
- on invoice broadcast messages, invalidate the **invoice index route match**
- do **not** automatically invalidate the edit route on generic invoice broadcasts

Why not invalidate the edit route?

- it is a form screen
- loader invalidation would risk resetting in-progress edits
- the edit route already has its own mutation-driven `router.invalidate()` after save

That gives a cleaner split:

- index route: live-updating workspace
- edit route: stable editor, explicit refresh after save

## Mutation Policy

Keep `useMutation`.

That part already fits TanStack's model well.

The change is only what happens after success:

- local create/upload/delete on the index route should invalidate the index route loader or navigate to a new canonical URL
- edit/save on `/app/$organizationId/invoices/$invoiceId` should keep using `router.invalidate()` on success

You do not need TanStack Query in the index component just to keep `useMutation`.

## Final Take

The clean model is:

- invoice index reads: loader + `Route.useLoaderData()`
- invoice mutations: `useMutation`
- `selectedInvoiceId`: optional search state, not route identity
- missing `selectedInvoiceId`: no selection
- invalid `selectedInvoiceId`: normalize URL to no selection
- edit route `invoiceId`: real route identity, keep `notFound()` when missing
- organization agent broadcasts: invalidate the invoice index route, not generic query keys

That model is simpler than the current hybrid page and matches your desired direction better.

## Sources

- `src/routes/app.$organizationId.invoices.tsx`
- `src/routes/app.$organizationId.invoices.index.tsx`
- `src/routes/app.$organizationId.invoices.$invoiceId.tsx`
- `src/routes/app.$organizationId.tsx`
- `src/routes/admin.users.tsx`
- `refs/tan-router/docs/router/guide/data-loading.md`
- `refs/tan-router/docs/router/guide/data-mutations.md`
- `refs/tan-router/docs/router/guide/external-data-loading.md`
- `refs/tan-router/docs/start/framework/react/tutorial/reading-writing-file.md`
- `refs/tan-start/examples/react/authenticated-routes/src/routes/_auth.invoices.tsx`
- `refs/tan-query/docs/framework/react/guides/disabling-queries.md`
- `refs/agents/docs/client-sdk.md`
- `refs/agents/docs/http-websockets.md`
- `refs/agents/docs/routing.md`
- `refs/tan-router/packages/router-core/src/router.ts`
