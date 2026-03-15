# Invoice PDF Markdown Workflow Research

Question: after `onInvoiceUpload` upserts into `Invoice` in `src/organization-agent.ts`, what is the simplest spike to kick off a workflow that loads the PDF from R2, converts it to markdown with Workers AI, stores that markdown on the `Invoice` row, and displays it in the invoices route?

## Short Answer

Yes. This fits the current architecture, with a few updates from your annotations.

- `onInvoiceUpload` already runs inside the per-organization agent, owns the `Invoice` SQLite table, and already broadcasts websocket messages from the same place.
- Cloudflare exposes two markdown-conversion paths: `env.AI.toMarkdown(...)` via binding, and the Workers AI REST markdown endpoint. Both return markdown text in `data` on success.
- Agents + Workflows fit the orchestration well: start workflow from agent with `runWorkflow()`, do R2 read and markdown conversion in `step.do(...)`, then call back into the agent to persist the result.
- For the spike, keep naming around `invoice extraction`, not `markdown conversion`, since markdown is just the current artifact.
- For the route, simplest is raw markdown only for debugging: return it from `getInvoices()` and show it in a detail panel or `<pre>`.

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

Important implication: for PDFs, this is not a custom OCR pipeline we need to assemble. The built-in markdown-conversion API is the first thing to spike.

### Workers AI REST path

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/rest-api.mdx:10` and `:21`:

```md
You can also use the Markdown Conversion REST API to convert your documents into Markdown.
curl https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown \
  -H 'Authorization: Bearer {API_TOKEN}'
```

Important implication: because this repo now has `WORKERS_AI_API_TOKEN`, the spike has two viable integration paths:

- `env.AI.toMarkdown(...)` via Workers AI binding
- direct REST call to `/accounts/{accountId}/ai/tomarkdown`

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

### AI Gateway note

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx:15`:

```md
If Authenticated Gateway is enabled but a request does not include the required `cf-aig-authorization` header, the request will fail.
```

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx:65`:

```md
When an AI Gateway is accessed from a Cloudflare Worker using a binding, the `cf-aig-authorization` header does not need to be manually included.
```

And `refs/tca/src/organization-agent.ts:939` shows one concrete gateway pattern already in use in the reference app:

```ts
const gatewayUrl = await this.env.AI.gateway(this.env.AI_GATEWAY_ID).getUrl(
  "workers-ai",
);
```

But I did not find grounding that markdown conversion itself is supported through AI Gateway. The markdown docs only ground:

- Workers binding `env.AI.toMarkdown(...)`
- Workers AI REST `/ai/tomarkdown`

So I would not make `AI_GATEWAY_TOKEN` part of the initial spike path unless we verify a supported gateway route first.

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

## Constraints Decided In Annotation

- invoice input should be PDF-only
- storing full markdown on `Invoice` is fine for now
- route should show raw markdown only for debugging
- workflow naming should use `invoice extraction`, not `markdown conversion`

These decisions simplify the spike.

## Recommended Spike Design

### 1. Keep `Invoice` in agent SQLite

For the spike, keep everything in the existing agent-owned `Invoice` table.

Why:

- the route already reads invoices from the agent
- the workflow can call back into the same agent to update the row
- agent SQL is local and zero-roundtrip relative to the agent instance
- `refs/agents/docs/state.md:424` explicitly pushes large/queryable data into SQL instead of state

I would not introduce D1 or a second storage location in the spike.

### 2. Make invoices PDF-only

Current invoice upload route accepts PDF and images in `src/routes/app.$organizationId.invoices.tsx:45`.

Your annotation resolves this: make the invoice feature PDF-only for the spike.

Why this helps:

- eliminates branching for non-PDF files
- aligns the route with the extraction goal
- keeps status and UI simpler

### 3. Add a small workflow class next to `OrganizationAgent`

Recommended shape:

- class: `InvoiceExtractionWorkflow extends AgentWorkflow<OrganizationAgent, ...>`
- payload: `{ invoiceId, idempotencyKey, r2ObjectKey, fileName }`
- steps:
  1. `load-pdf` from R2
  2. `convert-pdf-to-markdown`
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

- `runWorkflow("INVOICE_EXTRACTION_WORKFLOW", params, { id: idempotencyKey, metadata: { invoiceId } })`

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
- `extracting`
- `ready`
- `extract_error`

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
- start workflow and immediately set `status = 'extracting'`
- broadcast a small event like `invoice_extraction_started`

### Convert

Inside workflow:

1. `step.do("load-pdf", ...)`
   - `this.env.R2.get(r2ObjectKey)`
   - throw if body missing
   - build `Blob` with `type: "application/pdf"`

2. `step.do("convert-pdf-to-markdown", ...)`
   - path A: `this.env.AI.toMarkdown({ name: fileName, blob }, { conversionOptions: { pdf: { metadata: false } } })`
   - path B: direct REST `fetch("https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/tomarkdown", ...)` with `Authorization: Bearer ${this.env.WORKERS_AI_API_TOKEN}`
   - if result `format === "error"`, throw with `error`
   - otherwise return `data`

3. `step.do("save-markdown", ...)`
   - `await this.agent.applyInvoiceMarkdown({ invoiceId, idempotencyKey, markdown })`

### Complete / error callbacks

Use agent workflow callbacks to keep UI reactive:

- `onWorkflowComplete` -> optional broadcast `invoice_extraction_complete`
- `onWorkflowError` -> update row `status = 'extract_error'`, save `markdownError`, broadcast `invoice_extraction_error`

This matches the `refs/tca` style where workflow completion/error surfaces through agent messages and the route just invalidates.

## Wrangler Changes Needed

Current `wrangler.jsonc` already has:

- `ORGANIZATION_AGENT`
- `R2`
- queue bindings

It does not yet have a workflow binding.

### Option A - add Workers AI binding

Based on `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/binding.mdx:17`:

```jsonc
"ai": {
  "binding": "AI"
}
```

This keeps the workflow code simpler because it can call `this.env.AI.toMarkdown(...)` directly.

### Option B - use existing `WORKERS_AI_API_TOKEN`

Based on `refs/cloudflare-docs/src/content/docs/workers-ai/features/markdown-conversion/usage/rest-api.mdx:21`:

```bash
curl https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown \
  -H 'Authorization: Bearer {API_TOKEN}'
```

This avoids adding the Workers AI binding, since the token already exists in env.

My current read: Option B is the smaller spike if the goal is only proving invoice PDF -> markdown conversion.

Either way, the workflow entry still needs to be added:

```jsonc
"workflows": [
  {
    "name": "invoice-extraction-workflow",
    "binding": "INVOICE_EXTRACTION_WORKFLOW",
    "class_name": "InvoiceExtractionWorkflow"
  }
]
```

Plus export of the workflow class from `src/worker.ts`.

## Route Display: Simplest Useful Option

I would keep this intentionally plain.

### Recommendation

Return `markdown` and `markdownError` from `getInvoices()` and render raw markdown text, not rendered HTML.

Reason:

- no markdown rendering dependency is currently present in `package.json`
- raw markdown is enough to validate the extraction quality
- avoids introducing `react-markdown` or HTML sanitization questions during the spike
- matches your raw-only-for-debugging note

### Practical UI shape

In `src/routes/app.$organizationId.invoices.tsx`:

- keep the existing table
- add a `View Extracted Markdown` action per invoice
- store `selectedInvoiceId` in React state
- render a second `Card` below the table showing:
  - `Processing...` when `status === 'extracting'`
  - error text when `status === 'extract_error'`
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

## Updated Recommendation

1. Make invoice upload PDF-only.
2. Keep `markdown` and `markdownError` on `Invoice`; storing full markdown there is fine for the spike.
3. Name workflow/events/statuses around `invoice extraction`, not `markdown`, because markdown is just the current extraction artifact.
4. Prefer the existing `WORKERS_AI_API_TOKEN` + Workers AI REST markdown endpoint for the first spike, unless you specifically want to add an `AI` binding now.
5. Do not involve `AI_GATEWAY_TOKEN` in the first spike unless we confirm a supported gateway route for `toMarkdown`.
6. Show raw markdown only in the route for debugging.

## Recommended Spike Plan

1. Restrict the invoice route to PDF upload only.
2. Add `markdown` and `markdownError` columns to `Invoice`, keep `status` + `processedAt`.
3. Add `InvoiceExtractionWorkflow` beside `OrganizationAgent`.
4. Add workflow binding in `wrangler.jsonc`.
5. In `onInvoiceUpload`, start workflow using `INVOICE_EXTRACTION_WORKFLOW`.
6. In the workflow, call Workers AI markdown conversion either via `env.AI.toMarkdown(...)` or REST; given current env, REST looks slightly smaller.
7. Add agent methods like `applyInvoiceMarkdown(...)` and `applyInvoiceMarkdownError(...)`.
8. Broadcast small `invoice_extraction_*` events and invalidate the invoices route on those events.
9. In the route, show raw markdown in a simple detail panel.

No open questions remain from the first pass. Your annotations resolved them.
