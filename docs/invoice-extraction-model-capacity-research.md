# Invoice Extraction Model Capacity Research

## Question

Are our invoice extraction failures mainly a timeout/infrastructure problem, or are the models themselves not capable enough for this task?

## Current setup

Grounded in `src/lib/invoice-extraction.ts`:

- `INVOICE_EXTRACTION_MODEL` is currently `@cf/meta/llama-3.3-70b-instruct-fp8-fast` in `src/lib/invoice-extraction.ts:38`.
- The schema includes invoice header fields plus `lineItems: Schema.Array(LineItemSchema)` in `src/lib/invoice-extraction.ts:23`.
- The prompt explicitly says: `For line items, include every line item found.` in `src/lib/invoice-extraction.ts:71`.
- The request uses Workers AI JSON mode via `response_format: { type: "json_schema", json_schema: ... }` in `src/lib/invoice-extraction.ts:80`.
- `max_tokens` is already raised to `8192` in `src/lib/invoice-extraction.ts:87`, so the main failures are not explained by the default 256-token cap.
- We now have both code paths: binding via `runInvoiceExtraction()` and REST via `runInvoiceExtractionViaGateway()` in `src/lib/invoice-extraction.ts:91` and `src/lib/invoice-extraction.ts:151`.

## Relevant docs grounding

### Workers AI JSON mode

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:112`:

> This is the list of models that now support JSON Mode

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`:

> Workers AI can't guarantee that the model responds according to the requested JSON Schema. Depending on the complexity of the task and adequacy of the JSON Schema, the model may not be able to satisfy the request in extreme situations. If that's the case, then an error `JSON Mode couldn't be met` is returned and must be handled.

This matters because a failure in JSON mode is not automatically a timeout. It can mean the model + constrained decoder cannot satisfy the schema.

### AI Gateway binding limits

From `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:118`:

- `id`
- `skipCache`
- `cacheTtl`

The binding path does not expose a request-timeout knob. That makes it a poor path for long-running structured extraction experiments.

### AI Gateway request timeout

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx:39`:

> For a Universal Endpoint, configure the timeout value by setting a `requestTimeout` property within the provider-specific `config` object.

And the REST path also supports gateway timeout headers, which is why `runInvoiceExtractionViaGateway()` adds `cf-aig-request-timeout` in `src/lib/invoice-extraction.ts:178`.

### OpenAI through AI Gateway

From `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/openai.mdx:139`:

`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/chat/completions`

This gives us a clean next experiment: keep AI Gateway observability, but swap out Workers AI for an external model.

## Experiments run so far

## Binding-path results

| Model | JSON mode support | Full line items | Result | Time |
|---|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | official | no | success | ~31s |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | official | yes | timeout (`3046` seen in gateway) | ~60s on binding path |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | official | yes | `5024 JSON Mode couldn't be met` | binding path masked this badly |
| `@cf/qwen/qwen3-30b-a3b-fp8` | not official | yes | timeout | ~60s |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | not official | yes | malformed JSON string | fast |

## REST-path results

Using `runInvoiceExtractionViaGateway()` improved observability:

- With a 120s gateway timeout, the request actually ran for about 120s and returned `2014: Provider request timeout`.
- With a 300s gateway timeout, llama still failed at about 120s with `3046: Request timeout`.
- DeepSeek R1 ran for about `544,143ms` and then returned `5024: JSON Mode couldn't be met`.

Key implication: increasing the gateway timeout helps us observe the true provider behavior, but it does not remove Workers AI's internal limits.

## Findings

### 1. This does not look like just an underpowered-model problem

- A 70B official JSON-mode model still times out on the full schema.
- A 32B reasoning model can run for 9+ minutes and still fail schema satisfaction.
- Faster non-official models are not a clean comparison because they appear not to do constrained decoding reliably.

If this were only about model size, the 70B official model would be more convincing than it currently is. Instead, the results point to a harder interaction between model capability, constrained decoding, large array-of-object output, and noisy markdown input.

### 2. The task shape is probably too expensive for one-shot constrained decoding on Workers AI

The current request asks for all of these at once:

- classify whether it is an invoice
- extract header metadata
- extract addresses
- extract totals
- emit every line item as an array of objects

For this invoice, the line-item section is the expensive part. Header-only extraction already succeeds. Full extraction with `lineItems` is where the system breaks down.

### 3. The real bottleneck is likely schema complexity plus constrained decoding, not `max_tokens`

`max_tokens` is already `8192` in `src/lib/invoice-extraction.ts:87`.

The stronger signal is Cloudflare's own JSON mode warning that the model may not be able to satisfy the requested schema in extreme situations in `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx:126`.

### 4. REST is the right experimentation path

The binding path collapses too much useful error detail. The REST path gives us structured provider errors and request IDs, which makes the next experiments much more interpretable.

## Assessment

My read today:

- The evidence does not support a simple conclusion of `the models are underpowered`.
- The evidence does support `Workers AI JSON mode struggles with this specific one-shot extraction shape`.
- Model capability is still part of the story, but the bigger issue seems to be structured-output reliability under a large schema with many line items.

So yes, testing OpenAI is worth doing, but not just because it may be a bigger or smarter model. It is valuable because it tests a different structured-output stack under the same invoice/input conditions.

## Recommended next experiments

### A. Best next experiment: OpenAI via AI Gateway

Run the same invoice markdown through the AI Gateway OpenAI endpoint first, not a new local integration path.

Why:

- keeps gateway logging and request IDs
- removes Workers AI as the provider variable
- tests whether the failure is provider-specific or task-intrinsic

Suggested first pass:

| Provider | Model | Schema | Goal |
|---|---|---|---|
| OpenAI via AI Gateway | `gpt-4o-mini` | current full schema | cheap baseline |
| OpenAI via AI Gateway | stronger OpenAI model | current full schema | capacity check |

Success criteria:

- valid structured output
- all major header fields present
- materially better line-item extraction than Workers AI
- latency acceptable enough for synchronous use, or clear signal that async workflow is required

### B. Isolate the expensive part on Workers AI

Before declaring Workers AI unworkable, split the current task into smaller experiments:

1. header/totals only schema
2. line-items only schema
3. line-items only, but limited to a single page or chunk
4. line-items only, but only non-zero amount items

If header extraction keeps succeeding and line-items-only keeps failing, we will have much cleaner evidence that arrays of objects are the real break point.

### C. Compare one-shot JSON mode vs free-form JSON text

Try the same Workers AI model without constrained decoding:

- prompt for JSON text
- parse + validate after the fact

If this succeeds much faster, that strongly suggests constrained decoding is the main bottleneck, not raw comprehension.

## Working hypothesis

Current best hypothesis:

The limiting factor is not simply model size. It is the combination of:

- noisy markdown converted from PDF
- a large output schema
- many `lineItems` as array-of-object output
- constrained JSON decoding on Workers AI

OpenAI is worth testing next because it can answer the most important question quickly:

Is the task itself too large, or is Workers AI specifically the wrong provider for this extraction shape?
