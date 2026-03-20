# Invoice UI Broadcast Research

Question: how should we surface invoice extraction progress in the UI without persisting it across reloads?

## Direction

- Use generic activity messages.
- Workflow does not broadcast to the UI directly.
- Workflow reports progress to `OrganizationAgent`.
- Agent broadcasts activity messages to connected UI clients.
- UI keeps an in-memory activity feed with TanStack Query.

## Why

Current route behavior:

- `useAgent` is already wired in `src/routes/app.$organizationId.invoices.tsx:266`.
- Incoming messages are currently only used to `router.invalidate()` in `src/routes/app.$organizationId.invoices.tsx:269`.
- `InvoiceExtractionWorkflow` has durable steps in `src/invoice-extraction-workflow.ts:69`, `src/invoice-extraction-workflow.ts:113`, `src/invoice-extraction-workflow.ts:132`, but no progress reaches the UI.

Doc grounding:

From `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx:217`:

```ts
`this.reportProgress()` sends progress updates to the Agent (non-durable).
```

From `refs/agents/docs/workflows.md:120`:

```ts
async onWorkflowProgress(workflowName: string, instanceId: string, progress: unknown)
```

From `refs/agents/docs/state.md:7`:

```ts
- Persistent - Automatically saved to SQLite, survives restarts and hibernation
```

So agent state is not the right place for this feed.

## Characterization

Call these `activity messages`.

They are:

- transient
- append-only
- human-readable
- scoped to the current agent instance / organization
- generic enough for invoices now and other workflows later

They are not:

- durable domain state
- invoice-specific protocol messages
- workflow-specific UI messages

## Proposed Shape

Keep the shape small:

```ts
interface ActivityMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly level: "info" | "success" | "error";
  readonly text: string;
  readonly entityId?: string;
}
```

Why do we need entityId? these messages are not meant to be operational. only informational.
I'm also unsure why an id is needed? Present rationale.

Recommended envelope:

```ts
{
  type: "activity",
  message: ActivityMessage,
}
```

That gives us:

- one generic UI stream
- one decoder in the client
- enough structure for list rendering, dedupe, and styling
- no workflow- or invoice-specific schema in the transport

## Broadcast Path

Recommended path:

```txt
workflow reportProgress(...)
  -> OrganizationAgent.onWorkflowProgress(...)
  -> OrganizationAgent.broadcast({ type: "activity", message })
  -> UI appends to local activity feed
```

This keeps the agent as the single bridge between backend work and UI.

## What To Broadcast

Keep it generic and sparse.

For invoices, minimum set:

- upload received
- extraction started
- extraction completed
- extraction failed
- invoice deleted

should be something like

invoice uploaded, invoice extraction started/completed/failed, invoice deleted

Optional later:

- one or two mid-workflow progress lines if they are actually useful

Avoid broadcasting every internal step unless it improves the UX.

## UI

The invoices page should get an `Activity` control.

Placement:

- put `Activity` next to `Upload Invoice`
- make upload narrower; it does not need the full row

Layout direction:

- desktop: two-column row with `Upload Invoice` and `Activity`
- mobile: stack them

Behavior:

- append messages
- scrollable
- auto-scroll when already near bottom
- no reload persistence

Use `src/components/ui/scroll-area.tsx` for the scroll container.

## State Handling

TanStack Query is a good fit for the activity feed.

Grounding from `refs/tan-query/docs/reference/QueryClient.md:251`:

```ts
`setQueryData` is a synchronous function that can be used to immediately update a query's cached data. If the query does not exist, it will be created.
```

From `refs/tan-query/docs/framework/react/plugins/createPersister.md:42`:

```ts
`queryClient.setQueryData()` operations are not persisted
```

Use a key like:

```ts
["organization", organizationId, "activity"]
```

Responsibilities split:

- Query cache: transient activity feed
- route loader + `router.invalidate()`: canonical invoice data

## Recommendation

1. replace invoice-specific broadcast message types with one generic `activity` message
2. add `OrganizationAgent.onWorkflowProgress(...)`
3. have workflows report progress to the agent, not the UI
4. add an `Activity` panel next to upload
5. keep activity in TanStack Query only
