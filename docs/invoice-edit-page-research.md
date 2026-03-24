# Invoice Edit Page Research

## Goal

Add a dedicated invoice edit flow where users can:

- edit invoice name
- edit invoice fields
- add invoice items
- delete invoice items

## What Exists Today

The current invoice UI is a master-detail page at `src/routes/app.$organizationId.invoices.tsx`.

```tsx
export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: ({ params: { organizationId }, context }) =>
    context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
    }),
  component: RouteComponent,
});
```

The list row currently does selection, not navigation:

```tsx
<TableRow
  key={invoice.id}
  data-state={selectedInvoiceId === invoice.id ? "selected" : undefined}
  className="h-12"
  onClick={() => { setSelectedInvoiceId(invoice.id); }}
>
```

The only invoice actions exposed from the agent right now are create, upload, delete, list, and list-items.

From `src/organization-agent.ts`:

```ts
@callable()
createInvoice()

@callable()
uploadInvoice(input: { fileName: string; contentType: string; base64: string })

@callable()
softDeleteInvoice(invoiceId: string)

@callable()
getInvoices()

@callable()
getInvoiceItems(invoiceId: string)
```

There is no user-driven update method yet.

The repository already has the right shape for full item replacement during save. From `src/lib/OrganizationRepository.ts`:

```ts
const getInvoiceItems = Effect.fn("OrganizationRepository.getInvoiceItems")(
  function* (invoiceId: string) {
    const rows = yield* sql`select * from InvoiceItem where invoiceId = ${invoiceId} order by "order" asc`;
    return yield* decodeInvoiceItems(rows);
  },
);

// existing extraction save path
yield* sql`delete from InvoiceItem where invoiceId = ${input.invoiceId}`;
for (let i = 0; i < input.invoiceItems.length; i++) {
  const item = input.invoiceItems[i];
  const id = crypto.randomUUID();
  const order = i + 1;
  yield* sql`
    insert into InvoiceItem (id, invoiceId, "order", description, quantity, unitPrice, amount, period)
    values (${id}, ${input.invoiceId}, ${order}, ${item.description}, ${item.quantity}, ${item.unitPrice}, ${item.amount}, ${item.period})
  `;
}
```

That strongly suggests an edit submit can save the full invoice item array in one transaction instead of introducing separate item add/delete endpoints first.

## Routing Recommendation

Recommended route:

`/app/$organizationId/invoices/$invoiceId`

Recommended file:

`src/routes/app.$organizationId.invoices.$invoiceId.tsx`

Why this is the best fit here:

- `invoices` is already the collection route, so the child resource should stay under it.
- We do not have a separate read-only invoice details page yet, so the invoice page itself can be the edit page.
- It matches the repo's existing flat file route style, for example `src/routes/api/org.$organizationId.invoice.$invoiceId.tsx`.
- It gives each invoice a stable URL that supports direct navigation, refresh, and later deep-linking from activity/history.

I would not start with `/app/$organizationId/invoices/$invoiceId/edit`.

That extra `/edit` segment makes more sense if we already know we want both:

- `/app/$organizationId/invoices/$invoiceId` as a read-only detail page
- `/app/$organizationId/invoices/$invoiceId/edit` as a separate edit mode

I also would not use singular `/invoice/$invoiceId` because the existing app route is plural and the surrounding navigation is collection-oriented.

## UI Entry Point Recommendation

Recommended first entry point:

- add `Edit invoice` button in the selected invoice card header on `src/routes/app.$organizationId.invoices.tsx`

Why:

- current row click already means "select this invoice"
- adding navigation directly to the row creates mixed row semantics
- the selected detail card is where the user already confirms "this is the invoice I want"
- it is the smallest change for a first pass

Suggested follow-up, not required for v1:

- replace the trailing delete icon in the table with a dropdown menu containing `Edit`, `Open file` when available, and `Delete`

That fits the current component inventory because `src/components/ui/dropdown-menu.tsx` already exists.

## Page Recommendation

The dedicated invoice route should become the canonical edit surface.

Recommended page sections:

1. top bar: back to invoices, invoice name, save button
2. invoice metadata: invoice number, invoice date, due date, currency
3. vendor section: name, email, address
4. bill-to section: name, email, address
5. line items section: editable rows with add row and delete row
6. totals section: subtotal, tax, total, amount due
7. optional side panel: source file link when `viewUrl` exists

For line items, start with simple row CRUD:

- description
- quantity
- unit price
- amount
- period
- delete row
- add row button below the table

I would not add drag-and-drop reorder in the first pass. The schema already supports ordering via `"order"`, but add/delete is the main need right now.

## Data / Mutation Recommendation

Recommended first API shape:

```ts
updateInvoice(input: {
  invoiceId: string;
  name: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  vendorName: string;
  vendorEmail: string;
  vendorAddress: string;
  billToName: string;
  billToEmail: string;
  billToAddress: string;
  subtotal: string;
  tax: string;
  total: string;
  amountDue: string;
  invoiceItems: readonly Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    period: string;
  }>;
})
```

Recommendation: one save endpoint, not per-row item mutations.

Why:

- the page is a form, so one submit maps naturally to one mutation
- fewer round trips
- easier optimistic UI / dirty-state handling
- avoids partial-save edge cases between invoice fields and item rows
- matches the repository's existing delete-and-reinsert item pattern

Implementation shape:

- `OrganizationRepository.findInvoice(invoiceId)` already exists and is useful for direct route loads
- add `OrganizationRepository.updateInvoice(...)`
- add `OrganizationAgent.updateInvoice(...)`
- create a server fn for auth + organization guard, same pattern as `getInvoices` and `getInvoiceItems`
- after save, invalidate:
  - `invoicesQueryKey(organizationId)`
  - `invoiceItemsQueryKey(organizationId, invoiceId)`
- broadcast an activity message like `Invoice updated`

## Loader Recommendation

Use a dedicated route loader for the edit page.

Grounding from `docs/archive/tanstack-start-loaders.md`:

```tsx
beforeLoad: route guards, auth checks
loader: data fetching
```

And:

```tsx
- beforeLoad runs sequentially from outermost parent to deepest child route
- loader runs in parallel across all active routes after beforeLoad completes
```

In this app, auth/organization membership already lives in the parent route `src/routes/app.$organizationId.tsx`:

```tsx
export const Route = createFileRoute("/app/$organizationId")({
  beforeLoad: async ({ params }) =>
    await beforeLoadServerFn({ data: params.organizationId }),
  component: RouteComponent,
});
```

So the edit route can rely on that parent guard and use its own loader only for invoice data.

## Create Flow Recommendation

Once the edit route exists, the best create behavior changes slightly.

Current create flow in `src/routes/app.$organizationId.invoices.tsx`:

```tsx
const createInvoiceMutation = useMutation({
  mutationFn: () => stub.createInvoice(),
  onSuccess: (result) => {
    setSelectedInvoiceId(result.invoiceId);
    void queryClient.invalidateQueries({
      queryKey: invoicesQueryKey(organizationId),
    });
  },
});
```

Recommended change once editor exists:

- after `createInvoice()` succeeds, navigate directly to `/app/$organizationId/invoices/$invoiceId`

That makes manual invoice creation feel complete immediately instead of creating a blank row and asking the user to find the next action.

## Status Notes

Current invoice statuses in `src/lib/OrganizationDomain.ts` are:

```ts
export const InvoiceStatusValues = [
  "extracting",
  "ready",
  "error",
  "deleted",
] as const;
```

Given that `createInvoice()` currently inserts:

```ts
insert into Invoice (id, name, status)
values (${invoiceId}, ${"Untitled Invoice"}, ${"ready"})
```

The edit page can work without introducing a new draft status first.

My recommendation for this feature:

- allow editing `ready` invoices
- likely allow editing `error` invoices too, so failed extraction can be repaired manually
- keep `extracting` read-only for now
- keep `deleted` inaccessible

## Open Design Choices To Review

1. Should the invoices list keep its current master-detail layout after the dedicated page exists, or should row click eventually become navigation?
2. Should the edit page cover all invoice fields immediately, or should v1 focus on name + line items + a few core metadata fields?
3. On save of an `error` invoice, should status stay `error` until manually changed, or should manual save normalize it back to `ready`?
4. Do we want delete available on the edit page header too, or keep destructive actions in the list only?

## Recommended v1 Scope

If we want the smallest useful cut, I would build this in this order:

1. route: `src/routes/app.$organizationId.invoices.$invoiceId.tsx`
2. entry point: `Edit invoice` button in the current invoice card
3. loader: fetch invoice + items for direct page loads
4. form: invoice name + core invoice fields + line item add/delete
5. mutation: single `updateInvoice` save
6. create flow: navigate new invoices straight into the editor

That gets us a usable edit story without redesigning the whole invoices index page first.
