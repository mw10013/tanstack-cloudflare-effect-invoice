# Invoice PDF Markdown Workflow Research

Question: after `onInvoiceUpload` upserts into `Invoice` in `src/organization-agent.ts`, what is the simplest spike to kick off a workflow that loads the PDF from R2, converts it to markdown with Workers AI, stores that markdown on the `Invoice` row, and displays it in the invoices route?

## Short Answer

Yes, this fits the existing architecture cleanly.

- `onInvoiceUpload` already runs inside the per-organization agent, owns the `Invoice` SQLite table, and already broadcasts websocket messages from the same place.
- Cloudflare Workers AI has a built-in `env.AI.toMarkdown(...)` API that accepts a `Blob` and returns markdown text in `data`.
- Cloudflare Agents + Workflows are designed for exactly this kind of durable multi-step job: start workflow from agent with `runWorkflow()`, do R2 read and AI conversion in `step.do(...)`, then call back into the agent to persist the result.
- For the spike, the simplest UI is: keep showing the PDF link, add a `markdown` column on `Invoice`, return it from `getInvoices()`, and show raw markdown in a detail panel or `<pre>` in `src/routes/app.$organizationId.invoices.tsx`.

## Current Repo Shape

Current invoice flow is already close.

From `src/organization-agent.ts:36` the agent owns the `Invoice` table locally in agent SQLite:

```ts
void this.sql`create table if not exists Invoice (
  id text primary key,
  fileName text not null,
  contentType text not null,
  createdAt integer not null,
  eventTime integer not null,
  idempotencyKey text not null unique,
  r2ObjectKey text not null,
  status text not null default 'uploaded',
  processedAt integer
)`;
```

And `onInvoiceUpload` already upserts the row in `src/organization-agent.ts:67`.

The route already loads invoices through agent RPC in `src/routes/app.$organizationId.invoices.tsx:74` and already invalidates on websocket messages in `src/routes/app.$organizationId.invoices.tsx:225`.

So the missing piece is not data plumbing. It is durable post-upload processing.

## Grounding From Cloudflare Docs

### Workers AI markdown conversion

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/index.mdx:12`:

```md
Workers AI provides the `toMarkdown` utility method that developers can use from the `env.AI` binding ... for quick, easy, and convenient conversion ... to Markdown.
```

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/binding.mdx:89`:

```ts
const result = await env.AI.toMarkdown({
  name: "document.pdf",
  blob: new Blob([documentBuffer]),
});
```

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/binding.mdx:129` and `:138`:

```md
- `format`: `'markdown' | 'error'`
- `data`: The content of the converted document in Markdown format.
```

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/conversion-options.mdx:51`:

```ts
pdf?: {
  metadata?: boolean;
}
```

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/how-it-works.mdx:47`:

```md
- Metadata is extracted.
- Each page is parsed in sequence.
- We try to obtain a `StructTree` object ...
- If we manage to obtain a `StructTree`, we traverse its nodes to build a semantic Markdown representation.
```

Important implication: for PDFs, this is not a custom OCR pipeline we need to assemble. The built-in `toMarkdown` API is the first thing to spike.

### Workflows + agents

From `refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:232`:

```md
runWorkflow(workflowName, params, options?)
Start a workflow instance and track it in the Agent database.
```

From `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx:213`:

```md
The `AgentWorkflow` class from the Agents SDK extends Cloudflare Workflows with bidirectional Agent communication.
```

From `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx:216`:

```md
`step.do(name, callback)` executes code and persists the result. If the Workflow is interrupted, it resumes from the last successful step.
```

From `refs/cloudflare-docs/src/content/docs/agents/api-reference/store-and-sync-state.mdx:454`:

```md
Every individual Agent instance has its own SQL (SQLite) database that runs within the same context as the Agent itself.
```

From `refs/cloudflare-docs/src/content/docs/agents/api-reference/store-and-sync-state.mdx:450` and `refs/agents/docs/state.md:359`:

```md
These are durable operations - they persist even if the workflow retries.
```

Important implication: keep markdown in SQL, not agent state. Broadcast only small workflow events.

### Local dev caveat

From `refs/cloudflare-docs/src/content/docs/workflows/build/local-development.mdx:59`:

```md
The methods to `pause()`, `resume()`, `terminate()`, and `restart()` are also not yet implemented in local development.
```

Important implication: for this spike, avoid depending on terminate/restart-heavy recovery logic if we can keep the workflow idempotent enough to not need it.

## Grounding From `refs/tca`

`refs/tca` already uses the exact pattern we want: queue -> agent -> workflow -> agent SQL update -> websocket invalidation.

Workflow definition in `refs/tca/src/organization-agent.ts:234`:

```ts
export class OrganizationImageClassificationWorkflow extends AgentWorkflow<
  OrganizationAgent,
  { idempotencyKey: string; r2ObjectKey: string },
  { status: string; message: string }
> {
```

Durable step split in `refs/tca/src/organization-agent.ts:248`, `:257`, `:273`:

```ts
const bytes = await step.do("load-image-bytes", async () => { ... });
const top = await step.do("classify-image", async () => { ... });
await step.do("apply-classification-result", async () => {
  await this.agent.applyClassificationResult(...);
});
```

Workflow kickoff from agent in `refs/tca/src/organization-agent.ts:417`:

```ts
await this.runWorkflow(
  "OrganizationImageClassificationWorkflow",
  workflowParams,
  workflowOpts,
);
```

UI invalidation pattern from `refs/tca/src/routes/app.$organizationId.upload.tsx:229`:

```ts
if (
  result.value.type === "upload_deleted" ||
  result.value.type === "classification_updated" ||
  result.value.type === "classification_error"
) {
  void router.invalidate();
}
```

This is the closest template for invoices.

## Recommended Spike Design

### 1. Keep `Invoice` in agent SQLite

For the spike, keep everything in the existing agent-owned `Invoice` table.

Why:

- the route already reads invoices from the agent
- the workflow can call back into the same agent to update the row
- agent SQL is local and zero-roundtrip relative to the agent instance
- `refs/agents/docs/state.md:424` explicitly pushes large/queryable data into SQL instead of state

I would not introduce D1 or a second storage location in the spike.

### 2. Only run markdown workflow for PDFs

Current invoice upload route accepts PDF and images in `src/routes/app.$organizationId.invoices.tsx:45`.

The request here is specifically PDF -> markdown. So the clean simple behavior is:

- if `contentType !== "application/pdf"`, do not start the workflow
- keep `markdown` null for image invoices
- optionally mark status as `uploaded` or `markdown_skipped`

This avoids turning image uploads into a second, fuzzier requirement.

### 3. Add a small workflow class next to `OrganizationAgent`

Recommended shape:

- class: `InvoiceMarkdownWorkflow extends AgentWorkflow<OrganizationAgent, ...>`
- payload: `{ invoiceId, idempotencyKey, r2ObjectKey, fileName }`
- steps:
  1. `load-pdf` from R2
  2. `convert-pdf-to-markdown` via `this.env.AI.toMarkdown(...)`
  3. `save-markdown` via `this.agent.applyInvoiceMarkdown(...)`

This matches Cloudflare guidance to split external I/O across `step.do(...)` boundaries so retries resume from checkpoints instead of redoing everything.

### 4. Kick off workflow from `onInvoiceUpload`

Recommended location: directly after the invoice upsert inside `src/organization-agent.ts:onInvoiceUpload`.

Reason:

- the queue consumer already normalizes R2 event metadata and delegates to the agent
- the agent already owns idempotency and invoice row updates
- `runWorkflow()` started from the agent is automatically tracked in the agent database

This keeps queue logic dumb and keeps orchestration with the row owner.

### 5. Use the existing `idempotencyKey` as workflow id

For this repo, uploads generate a fresh `invoiceId` and `idempotencyKey` at put time in `src/routes/app.$organizationId.invoices.tsx:148` and `:150`.

That means duplicate queue delivery is the main repeat case, not user replacement of the same logical invoice object.

So the simplest workflow id strategy is:

- `runWorkflow("INVOICE_MARKDOWN_WORKFLOW", params, { id: idempotencyKey, metadata: { invoiceId } })`

Unlike `refs/tca`, I do not think the spike needs the full create-first terminate-and-recover pattern, because invoice uploads are append-only and local dev does not support terminate anyway.

Simple guard is enough:

- if `getWorkflow(idempotencyKey)` is `queued`, `running`, or `waiting`, do nothing
- if row already has markdown and `processedAt`, do nothing
- otherwise start workflow

## Suggested Table Changes

Smallest useful schema change:

- add `markdown text`
- add `markdownError text`

Keep existing:

- `status`
- `processedAt`

Then use status as the spike lifecycle field:

- `uploaded`
- `markdown_processing`
- `markdown_ready`
- `markdown_error`

That is simpler than adding a second status column.

A practical spike row shape would be:

```ts
{
  id,
  fileName,
  contentType,
  createdAt,
  eventTime,
  idempotencyKey,
  r2ObjectKey,
  status,
  processedAt,
  markdown,
  markdownError,
}
```

## Suggested Workflow Behavior

### Start

Inside `onInvoiceUpload`:

- upsert row
- clear `markdown` and `markdownError` on re-upsert
- set `status = 'uploaded'`
- if PDF, start workflow and immediately set `status = 'markdown_processing'`
- broadcast a small event like `invoice_markdown_started`

### Convert

Inside workflow:

1. `step.do("load-pdf", ...)`
   - `this.env.R2.get(r2ObjectKey)`
   - throw if body missing
   - build `Blob` with `type: "application/pdf"`

2. `step.do("convert-pdf-to-markdown", ...)`
   - `this.env.AI.toMarkdown({ name: fileName, blob }, { conversionOptions: { pdf: { metadata: false } } })`
   - if result `format === "error"`, throw with `error`
   - otherwise return `data`

3. `step.do("save-markdown", ...)`
   - `await this.agent.applyInvoiceMarkdown({ invoiceId, idempotencyKey, markdown })`

### Complete / error callbacks

Use agent workflow callbacks to keep UI reactive:

- `onWorkflowComplete` -> optional broadcast `invoice_markdown_complete`
- `onWorkflowError` -> update row `status = 'markdown_error'`, save `markdownError`, broadcast `invoice_markdown_error`

This matches the `refs/tca` style where workflow completion/error surfaces through agent messages and the route just invalidates.

## Wrangler Changes Needed

Current `wrangler.jsonc` already has:

- `ORGANIZATION_AGENT`
- `R2`
- queue bindings

It does not yet have:

- Workers AI binding
- workflow binding

Based on `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/binding.mdx:17` and workflow docs, the spike needs:

```jsonc
"ai": {
  "binding": "AI"
}
```

and a workflow entry like:

```jsonc
"workflows": [
  {
    "name": "invoice-markdown-workflow",
    "binding": "INVOICE_MARKDOWN_WORKFLOW",
    "class_name": "InvoiceMarkdownWorkflow"
  }
]
```

markdown is too specific in the naming. this is just a spike. it will evolve to invoice extraction.

plus export of the workflow class from `src/worker.ts`.

## Route Display: Simplest Useful Option

I would keep this intentionally plain.

### Recommendation

Return `markdown` and `markdownError` from `getInvoices()` and render raw markdown text, not rendered HTML.

Reason:

- no markdown rendering dependency is currently present in `package.json`
- raw markdown is enough to validate the extraction quality
- avoids introducing `react-markdown` or HTML sanitization questions during the spike

### Practical UI shape

In `src/routes/app.$organizationId.invoices.tsx`:

- keep the existing table
- add a `View Markdown` action per invoice
- store `selectedInvoiceId` in React state
- render a second `Card` below the table showing:
  - `Processing...` when `status === 'markdown_processing'`
  - error text when `status === 'markdown_error'`
  - `<pre className="whitespace-pre-wrap">{invoice.markdown}</pre>` when ready

This is simpler than trying to inline big markdown blobs into each row.

If you want the absolute simplest possible spike, skip selection state and just add a collapsible details area under each row. But I think a single preview panel is slightly cleaner.

## Effect v4 Notes

From `refs/effect4/ai-docs/src/01_effect/01_basics/index.md:3`:

```md
Prefer writing Effect code with `Effect.gen` & `Effect.fn("name")`.
```

From `refs/effect4/ai-docs/src/03_integration/index.md:3`:

```md
`ManagedRuntime` bridges Effect programs with non-Effect code ... like web handlers, framework hooks, worker queues, or legacy callback APIs.
```

What that means here:

- keep the existing route/server-fn style as-is: `Effect.gen(...)`, `Config`, `Schema`, `Effect.tryPromise(...)`
- do not force the workflow body itself into heavy Effect abstractions just for the spike; `AgentWorkflow` APIs are Promise-shaped
- if workflow logic starts growing, extract tiny pure helpers or `Effect.fn(...)`-style boundary helpers, but keep the workflow orchestration readable and step-oriented

So: Effect at app boundaries, simple async inside workflow steps is a good fit for this spike.

## Recommended Spike Plan

1. Add `markdown` and `markdownError` columns to `Invoice`, keep `status` + `processedAt`.
2. Add `InvoiceMarkdownWorkflow` beside `OrganizationAgent`.
3. Add `AI` + workflow bindings in `wrangler.jsonc`.
4. In `onInvoiceUpload`, start workflow only for PDFs.
5. Add agent methods like `applyInvoiceMarkdown(...)` and `applyInvoiceMarkdownError(...)`.
6. Broadcast small invoice-markdown events and invalidate the invoices route on those events.
7. In the route, show raw markdown in a simple detail panel.

## Open Questions For Iteration

1. Should non-PDF invoices remain allowed, or should the invoice feature now become PDF-only?

pdf only

2. Is storing full markdown in agent SQLite acceptable for now, even for long invoices, or do you want the spike to note a future move to D1/R2 text objects?

full markdown is fine for now

3. Do you want the route to show raw markdown only, or also a later rendered-markdown follow-up once the extraction quality looks good?

raw only for debugging.
