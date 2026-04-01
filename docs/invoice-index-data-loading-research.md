# Invoice Index Data Loading Research

## Scope

Questions this note answers:

- Is `/app/$organizationId/invoices/` actually client-only today?
- Is there a waterfall?
- Is TanStack Query here mainly because of agent broadcasts?
- Would loaders be simpler for this page?
- What is the cleanest simplification path from here?

## Short Answer

The invoice index route is already a hybrid loader-plus-query route, not a pure client-only route.

- The parent route `src/routes/app.$organizationId.invoices.tsx` has a loader that prefetches the invoices list into the React Query cache.
- The child index route `src/routes/app.$organizationId.invoices.index.tsx` reads that prefetched list with `useQuery`.
- The real client-side fetch is the second query for the selected invoice's full detail payload.
- `useAgent` and broadcast invalidation are orthogonal to loaders. They do not force you to choose client-only queries. They work well with loader-prefetched query data.

My conclusion: the current list-loading pattern is reasonable and matches TanStack's recommended router-plus-query composition. The part that feels conceptually messy is the local-state master/detail selection, not the list loader itself.

## What The Route Actually Does Today

### 1. Parent route loader prefetches the invoices list

`src/routes/app.$organizationId.invoices.tsx`:

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

So when the user navigates to `/app/$organizationId/invoices/`, the parent loader runs first. On first SSR entry, this can happen on the server. On later SPA navigations, it runs through the router.

### 2. Router SSR-query integration hydrates that cache

`src/router.tsx`:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

setupRouterSsrQueryIntegration({ router, queryClient });
```

The code comment here is important: `staleTime: 30_000` is explicitly there to avoid an immediate post-hydration refetch for data that the loader already fetched.

### 3. The index route consumes the prefetched list with `useQuery`

`src/routes/app.$organizationId.invoices.index.tsx`:

```tsx
const invoicesQuery = useQuery({
  queryKey: invoicesQueryKey(organizationId),
  queryFn: () => getInvoices({ data: { organizationId } }),
});
const invoices = invoicesQuery.data ?? [];
```

Because the parent loader already seeded this query key, this is not the same as "blank page, then client fetches everything". It is the standard TanStack Router + TanStack Query pattern: loader populates cache, component subscribes to cache.

TanStack's own examples use this exact shape:

```tsx
export const Route = createFileRoute('/posts')({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(postsQueryOptions),
  component: PostsLayoutComponent,
})

function PostsLayoutComponent() {
  const postsQuery = useSuspenseQuery(postsQueryOptions)
  const posts = postsQuery.data
}
```

Source: `refs/tan-start/examples/react/basic-react-query-file-based/src/routes/posts.route.tsx`

## Where The Waterfall Actually Is

The waterfall is not the invoices list. The waterfall is the selected invoice detail query.

`src/routes/app.$organizationId.invoices.index.tsx`:

```tsx
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

This means:

1. loader prefetches invoices list
2. component renders from prefetched list
3. selected invoice is derived from that list
4. if selected invoice is `ready`, a second query fetches full invoice detail and line items

That is a real dependent fetch.

It is also a deliberate one: the list query returns a lightweight list item shape, while the second query returns `InvoiceWithItems`.

So your mental model can be simplified to:

- invoices list: loader-prefetched and cache-backed
- selected detail pane: client-selected and client-fetched

## Does `enabled` Matter Here?

Yes. TanStack Query's docs say disabled queries:

- do not automatically fetch on mount
- do not automatically refetch in the background
- ignore `invalidateQueries` calls

Source: `refs/tan-query/docs/framework/react/guides/disabling-queries.md`

That matters because the selected invoice detail query is only enabled when:

```tsx
enabled: selectedInvoice !== null && selectedInvoice.status === "ready"
```

Implications:

- if the selected invoice is still extracting, the detail query stays off
- broadcast invalidation will refresh the invoices list query
- once the list shows that invoice as `ready`, the detail query becomes enabled and fetches the full detail

This is another reason the page feels a little indirect: some state changes happen by invalidating the list first, and the detail fetch only becomes possible after the list reflects the new status.

## How `useAgent` Fits

### Cloudflare Agents behavior

Cloudflare's Agents docs describe `useAgent` as:

- a React hook with automatic reconnection and state management
- a websocket-based client

Source excerpt from `refs/agents/docs/client-sdk.md`:

```md
| `useAgent`    | React hook with automatic reconnection and state management |
```

Cloudflare's docs and prompts also show the intended client API shape:

```tsx
const connection = useAgent({
  agent: "dialogue-agent",
  name: "insight-seeker",
  onMessage: (message) => {
    console.log("Understanding received:", message.data);
  },
});
```

Source: `refs/cloudflare-docs/src/content/partials/prompts/base-prompt.txt`

### Agent routing and instance naming

The agents docs say agent URLs look like:

```txt
/agents/{agent-name}/{instance-name}
```

and `useAgent({ agent: "Counter" })` resolves to `/agents/counter/...`.

Source: `refs/agents/docs/routing.md`

That lines up with the local code:

```tsx
const agent = useAgent<OrganizationAgent, OrganizationAgentState>({
  agent: "organization-agent",
  name: organizationId,
  onMessage: (event) => {
    ...
  },
});
```

Source: `src/routes/app.$organizationId.tsx`

So each organization page connects to the `organization-agent` instance for that `organizationId`.

## What The Agent Broadcasts Actually Contain

The agent is not broadcasting invoice records. It is broadcasting small activity messages.

`src/organization-agent.ts`:

```tsx
agent.broadcast(
  JSON.stringify({
    createdAt: new Date().toISOString(),
    action: input.action,
    level: input.level,
    text: input.text,
  } satisfies ActivityMessage),
);
```

Examples of actions emitted locally:

- `invoice.uploaded`
- `invoice.created`
- `invoice.deleted`
- `invoice.extraction.completed`
- `invoice.extraction.failed`

So the websocket is acting as a notification channel, not as the primary data transport for invoice entities.

The Agents docs describe `broadcast` the same way:

```tsx
this.broadcast(JSON.stringify({ type: "update", data: "..." }));
```

Source: `refs/agents/docs/http-websockets.md`

## How Broadcasts Affect React Query

The organization layout route receives those messages and turns them into query invalidations.

`src/routes/app.$organizationId.tsx`:

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

The invalidating actions are defined in `src/lib/Activity.ts`.

TanStack Query's docs say invalidation does two things:

1. mark matching queries stale
2. refetch active matching queries in the background

Source excerpt from `refs/tan-query/docs/framework/react/guides/query-invalidation.md`:

```md
When a query is invalidated with `invalidateQueries`, two things happen:

- It is marked as stale.
- If the query is currently being rendered via `useQuery` or related hooks,
  it will also be refetched in the background.
```

This is the main reason query-backed screens fit nicely with the websocket notifications.

## Important Distinction: Query Invalidation vs Loader Invalidation

This codebase uses both invalidation systems.

### Query invalidation

Used by the invoice list page via `queryClient.invalidateQueries(...)`.

### Router invalidation

Used by loader-data pages via `router.invalidate()`.

Example: the invoice edit route is loader-driven, not query-driven:

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices/$invoiceId")({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

const saveMutation = useMutation({
  mutationFn: (data) => stub.updateInvoice({ invoiceId, ...data }),
  onSuccess: () => {
    void router.invalidate();
  },
});
```

Source: `src/routes/app.$organizationId.invoices.$invoiceId.tsx`

This distinction matters for any future simplification:

- if a screen renders from query cache, agent broadcasts can refresh it via `invalidateQueries`
- if a screen renders from `Route.useLoaderData()`, agent broadcasts will not refresh it unless you also call `router.invalidate()` somewhere

So moving the invoice index page to a pure loader-data model is possible, but it changes the live-update wiring.

## Is TanStack Query Here Mainly Because Of Broadcasts?

Partly, but not entirely.

There are three separate reasons Query is useful here:

1. loader-prefetched SSR hydration for the list
2. client-side refetch/invalidation in response to websocket notifications
3. client-driven fetching for whichever invoice row is currently selected

The third item is the biggest reason the index route still has a second query. The selected invoice is controlled by local React state:

```tsx
const [selectedInvoiceId, setSelectedInvoiceId] = React.useState<string | null>(null);
```

A loader does not react to arbitrary local state changes. It reacts to navigation, route matching, search param changes, and router invalidation.

That is the core design pressure here.

## About "New Invoice Should Be Simple Request/Response"

For the initiating client, it already mostly is.

`createInvoiceMutation` calls:

```tsx
mutationFn: () => stub.createInvoice(),
onSuccess: (result) => {
  setSelectedInvoiceId(result.invoiceId);
  void navigate({
    to: "/app/$organizationId/invoices/$invoiceId",
    params: { organizationId, invoiceId: result.invoiceId },
  });
},
```

So the client gets an immediate response containing `invoiceId`, then navigates.

The broadcast is still useful for:

- other connected tabs
- other connected users viewing the same organization
- general activity feed updates

That said, there is some duplicate same-tab freshness work today:

- mutation `onSettled` invalidates the invoices list locally
- the agent also broadcasts an event that triggers more invalidation

For `createInvoice`, that duplication is mostly about convenience and cross-client sync, not necessity for the initiating client.

## Recommendation

### What I would keep

I would keep the parent invoices route loader exactly as a loader-plus-query-cache prefetch. It is a good pattern here.

Reasons:

- it already gives you SSR-friendly first render for the invoices list
- it matches TanStack's documented examples
- it composes cleanly with broadcast-driven query invalidation
- it keeps the list fresh without forcing everything through `Route.useLoaderData()`

### What I would not do

I would not convert the current master/detail index page to pure loader data while keeping row selection in local component state.

That would make the data model harder, not simpler, because loaders do not naturally follow local row selection.

### Simplest next step if you want a loader-first mental model

Move the selected invoice into the URL, then let the loader follow the URL.

Concretely:

1. store selected invoice id in search params, not local React state
2. add `loaderDeps` based on that selected invoice id
3. in the index route loader, prefetch the selected invoice query too
4. let row clicks update the URL instead of local state

That would make the page more loader-shaped:

- route URL chooses selected invoice
- loader prefetches both list and selected detail
- component renders from already-resolved route state or cache

### Simplest next step if you want less complexity overall

Reduce how much detail the index page shows.

The full detail pane is what creates the second query and the local-selection complexity. If the index page became a list plus lightweight summary, and full detail lived only on `/app/$organizationId/invoices/$invoiceId`, the mental model gets much simpler.

## Comparison: URL Selection Without Query

This section sketches the same page shape without TanStack Query.

Goal:

- selection lives in the URL
- loader owns all data fetching
- component renders only `Route.useLoaderData()`
- websocket messages trigger `router.invalidate()` instead of `queryClient.invalidateQueries()`

One important structural rule in this version:

- the parent invoices route stays structural only
- the index route owns index-page data
- the detail form route owns form-page data

That split is what makes selective route invalidation possible.

### Route shape

The cleanest no-query version is still a parent invoices layout plus an index child route, but the parent must not own shared invoice data.

The parent route can stay simple:

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
```

That parent should stay structural. Do not put the invoices list loader there.

If the parent loader owned the invoices list, then invalidating invoice-list data would also affect the form route, because the parent match is active for both `/app/$organizationId/invoices/` and `/app/$organizationId/invoices/$invoiceId`.

The index route would own the selected invoice via search params:

```tsx
const InvoicesSearchSchema = z.object({
  selectedInvoiceId: z.string().optional(),
});

export const Route = createFileRoute("/app/$organizationId/invoices/")({
  validateSearch: InvoicesSearchSchema,
  loaderDeps: ({ search }) => ({ selectedInvoiceId: search.selectedInvoiceId }),
  loader: ({ params, deps }) =>
    getInvoicesPageData({
      data: {
        organizationId: params.organizationId,
        selectedInvoiceId: deps.selectedInvoiceId,
      },
    }),
  component: RouteComponent,
});
```

That is the big conceptual shift. Selection stops being local UI state and becomes route state.

### Loader shape

The loader would fetch both pieces of data directly and return them.

Possible shape:

```tsx
const getInvoicesPageData = createServerFn({ method: "GET" })
  .inputValidator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        organizationId: Schema.NonEmptyString,
        selectedInvoiceId: Schema.optional(Schema.NonEmptyString),
      }),
    ),
  )
  .handler(({ context: { runEffect }, data: { organizationId, selectedInvoiceId } }) =>
    runEffect(
      Effect.gen(function* () {
        const invoices = yield* getInvoices({ data: { organizationId } });
        const selectedInvoice =
          invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? invoices[0] ?? null;

        const invoice =
          selectedInvoice && selectedInvoice.status === "ready"
            ? yield* getInvoice({
                data: { organizationId, invoiceId: selectedInvoice.id },
              })
            : null;

        return {
          invoices,
          selectedInvoiceId: selectedInvoice?.id ?? null,
          selectedInvoice,
          invoice,
        };
      }),
    ),
  );
```

Then the component becomes much more loader-shaped:

```tsx
function RouteComponent() {
  const { organizationId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { invoices, selectedInvoiceId, selectedInvoice, invoice } = Route.useLoaderData();

  return invoices.map((item) => (
    <TableRow
      key={item.id}
      data-state={selectedInvoiceId === item.id ? "selected" : undefined}
      onClick={() => {
        void navigate({
          to: "/app/$organizationId/invoices",
          params: { organizationId },
          search: { ...search, selectedInvoiceId: item.id },
          replace: true,
        });
      }}
    />
  ));
}
```

### Canonical URL question

There is one subtle issue in the pure-loader version.

If the URL does not have `selectedInvoiceId`, but invoices exist, the loader still needs to choose one. You then have two options.

Option 1:

- loader returns `selectedInvoiceId` in loader data
- URL remains without `selectedInvoiceId`
- component renders correctly, but URL is not canonical

Option 2:

- loader or component normalizes the URL to include `selectedInvoiceId`
- URL always reflects the actual selected row

I think option 2 is better. It keeps the URL as the single source of truth.

### Mutation behavior without Query

Without Query, mutations become more obviously request/response plus route refresh.

Examples:

```tsx
const createInvoiceMutation = useMutation({
  mutationFn: () => stub.createInvoice(),
  onSuccess: ({ invoiceId }) => {
    void navigate({
      to: "/app/$organizationId/invoices",
      params: { organizationId },
      search: { selectedInvoiceId: invoiceId },
    });
  },
});
```

```tsx
const softDeleteInvoiceMutation = useMutation({
  mutationFn: ({ invoiceId }: { invoiceId: string }) => stub.softDeleteInvoice({ invoiceId }),
  onSuccess: () => {
    void router.invalidate({
      filter: (match) => match.routeId === "/app/$organizationId/invoices/",
    });
  },
});
```

That is conceptually simpler than query invalidation.

You mutate, then you re-run the route loader.

### How live updates would work without Query

This is the part where route ownership matters.

In a pure-loader design, the websocket message handler in the layout would invalidate only the index route match, not the form route match.

That is possible because `router.invalidate()` supports a `filter`, and route matches expose `routeId`.

Sketch:

```tsx
const router = useRouter();

onMessage: (event) => {
  const message = decodeActivityMessage(event);
  if (!message) return;
  if (shouldInvalidateForInvoice(message.action)) {
    void router.invalidate({
      filter: (match) => match.routeId === "/app/$organizationId/invoices/",
    });
  }
};
```

What this gives you:

- when the user is on the index route, the index loader re-runs
- when the user is on the form route, the form loader does not re-run
- the index route match is marked stale/invalid, so when the user later returns to the index route it reloads

So this addresses the main concern with the no-query version: extraction messages can refresh the index route without interrupting an in-progress edit form.

The tradeoff versus Query is still:

- Query version: invalidate only invoice query keys, active observers refetch in background
- Loader version: invalidate only selected route matches, based on route boundaries

That makes the loader version viable, but only at route granularity. It is not as fine-grained as query-key invalidation.

### Strengths of the no-query version

- simpler mental model
- URL is the source of truth for selection
- no list query plus detail query split in the component body
- request/response mutations fit naturally with `router.invalidate()`

### Weaknesses of the no-query version

- live updates are coarser because they refresh via loader invalidation, not targeted query invalidation
- you lose the nice cache subscription model TanStack recommends for Router + Query
- the selected invoice detail still depends on the selected invoice id, so the waterfall is reduced structurally but not magically removed
- repeated quick row switches become route navigations and loader reruns rather than local cache reads
- selective invalidation depends on route boundaries being designed carefully

### My take on this comparison

If your top priority is conceptual clarity, this pure-loader version is a valid design.

If your top priority is responsive live-updating with granular invalidation, the current loader-plus-query version is stronger.

The biggest benefit of the no-query version is not performance. It is that the data flow becomes easier to explain:

- URL picks selected invoice
- loader fetches list and selected detail
- component renders loader data
- websocket causes loader invalidation

## `useAgent` Placement

Keep `useAgent` in the organization layout at `src/routes/app.$organizationId.tsx`.

That gives one stable websocket connection for the whole organization area and avoids disconnect/reconnect churn when navigating between the invoices index route and the invoice form route.

In this approach, the layout owns websocket subscription and route invalidation policy, while the leaf invoice routes own their own loader data.

## SSR Hydration Options

If the main complaint with the current Query approach is the positive `staleTime` used to avoid immediate hydration refetch, there are really three distinct options.

### Option 1: Query Prefetch + Hydration

This is the current pattern.

Shape:

- loader calls `ensureQueryData` or `prefetchQuery`
- Query cache is hydrated across SSR
- component reads via `useQuery` or `useSuspenseQuery`
- hydration refetch is controlled by Query freshness settings

What TanStack docs say:

- with SSR, a default `staleTime` above `0` is usually desired to avoid immediate client refetch
- when server prefetching, a positive `staleTime` is the standard way to avoid re-specifying that everywhere

This is the most supported TanStack Query SSR path.

Pros:

- best fit with query invalidation and background refetching
- best fit with broadcast-driven live updates
- avoids `initialData` caveats around cache overwrites
- matches the recommended Query hydration model

Cons:

- requires a freshness policy to avoid hydration refetch
- if that `staleTime` has no domain meaning, it can feel semantically muddy
- combines Router cache coordination with Query cache semantics, which is conceptually heavier

### Option 2: Loader Data + `initialDataUpdatedAt`

This keeps Query in the component, but stops using Query hydration as the transport for SSR data.

Shape:

- loader fetches raw data and returns it directly
- component passes loader data into `useQuery` as `initialData`
- component also passes `initialDataUpdatedAt`
- component can use `refetchOnMount: false` if the goal is to suppress hydration refetch without declaring a fake freshness window

Sketch:

```tsx
const { invoices, fetchedAt } = Route.useLoaderData();

const invoicesQuery = useQuery({
  queryKey: invoicesQueryKey(organizationId),
  queryFn: () => getInvoices({ data: { organizationId } }),
  initialData: invoices,
  initialDataUpdatedAt: fetchedAt,
  refetchOnMount: false,
});
```

Important nuance:

- `initialDataUpdatedAt` does not replace `staleTime`
- it only tells Query how old the initial data is
- with `staleTime: 0`, the query is still stale immediately
- the thing that actually stops the hydration refetch in this version is `refetchOnMount: false`

Pros:

- more honest mental model if you dislike pretending data is fresh for an arbitrary number of milliseconds
- loader remains the SSR source of truth
- component still gets Query cache, invalidation, and refetch tools after mount

Cons:

- weaker than hydration when the same query is used in multiple places
- `initialData` never overwrites existing cache data, even if the new loader data is fresher
- more brittle than full hydration on revisits and shared query usage
- still uses Query, but now with a hybrid loader-data-to-query bridge

### Option 3: Pure Loader Data

This is the no-Query version sketched above.

Shape:

- loader fetches route data
- component renders `Route.useLoaderData()` only
- websocket messages selectively call `router.invalidate({ filter })`
- no query hydration semantics at all for this page

Pros:

- simplest mental model
- no hydration freshness knob needed
- route invalidation policy is explicit and route-scoped

Cons:

- gives up query-key invalidation and background refetch behavior
- repeated route state changes rerun loaders rather than reuse query cache subscriptions
- less flexible if the same data is consumed across several components or screens

### My Take On The Three Options

If the main priority is to stay aligned with TanStack Query's strongest path, option 1 is still the most supported design.

If the main priority is to avoid the feeling of a fake freshness window while still keeping Query available after mount, option 2 is the most interesting compromise.

If the main priority is conceptual clarity and route-driven data flow, option 3 is the cleanest.

The real trade is not just "staleTime or no staleTime". The real trade is:

- Query hydration semantics
- loader-to-query bridging semantics
- pure route-loader semantics

## Final Take

Your concern is real, but the exact problem is slightly different than it first appears.

The current page is not:

- no loader
- blank SSR
- everything fetched after hydration

It is:

- loader-prefetched invoices list
- query-backed cache subscription for that list
- client-driven dependent query for the selected invoice detail pane
- websocket notifications that invalidate query-backed data

So the clean framing is:

- list loading is already in a good loader-based place
- selected detail loading is where the complexity and waterfall live
- `useAgent` does not block loader usage
- a loader-first simplification only really pays off if selection moves into the URL or the index page shows less detail
