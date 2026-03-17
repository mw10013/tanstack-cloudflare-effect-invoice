# Invoice Extraction Error 1031 Research

## The Error

```
InferenceUpstreamError: error code: 1031
```

Thrown by `ai.run()` in `src/lib/invoice-extraction.ts` when using the expanded `InvoiceExtractionSchema` with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

## What is Error 1031?

**Error 1031 is undocumented.** It does not appear in the Workers AI errors table (`refs/cloudflare-docs/src/content/docs/workers-ai/platform/errors.mdx`). The documented error codes are: 3003, 3006, 3007, 3008, 3023, 3036, 3039, 3040, 3041, 3042, 5004, 5005, 5007, 5016, 5018, 5019. None are 1031.

Error 1031 appears across multiple unrelated Cloudflare services:
- **Workers AI** — `InferenceUpstreamError: error code: 1031` (our case)
- **D1 remote bindings** — `D1_ERROR: Failed to parse body as JSON, got: error code: 1031` (GitHub issue cloudflare/workers-sdk#10801, idle connection timeout)
- **ai.toMarkdown()** — same error code 1031 for image conversion (Cloudflare Discord, Dec 2025)

This suggests **1031 is a generic Cloudflare infrastructure error code**, not specific to AI inference or JSON mode. It may be an upstream service timeout, a proxy error, or a general "request failed" code from Cloudflare's internal routing.

The only JSON-mode-specific documented error is the `JSON Mode couldn't be met` message from `json-mode.mdx:126`:
> Workers AI can't guarantee that the model responds according to the requested JSON Schema. Depending on the complexity of the task and adequacy of the JSON Schema, the model may not be able to satisfy the request in extreme situations.

But there is **no evidence** that error 1031 is the code for `JSON Mode couldn't be met`. That error is described as returning an error message, not just a bare code.

## What We Actually Know

1. The old schema (2 fields: `isInvoice`, `total`) worked fine.
2. The new schema (~30 fields across nested structs + array) fails with 1031.
3. The error comes from `Ai._parseError (cloudflare-internal:ai-api)` — this is Cloudflare's internal AI binding code, opaque to us.
4. We cannot distinguish between: model can't handle the schema, model ran out of output tokens, infrastructure timeout, or JSON mode constraint failure.

## Is the Schema Actually Complex?

The schema has:
- 12 top-level fields (1 boolean, 9 nullable strings, 2 nullable objects/arrays)
- `AddressSchema`: 7 nullable string fields
- `LineItemSchema`: 5 fields (1 required string, 4 nullable strings)
- `lineItems`: array of `LineItemSchema`

This is a **normal, moderate schema**. OpenAI's structured outputs handle far more complex schemas routinely. The Cloudflare docs example shows arrays working fine (`languages: { type: "array", items: { type: "string" } }`). But our schema has nested objects inside arrays and `anyOf` unions from `NullOr` — whether Workers AI's implementation handles these correctly is undocumented.

## Model Options on Workers AI

### JSON Mode Supported Models (from `json-mode.mdx:114-123`)

| Model | Params | Notes |
|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B | **Current.** Best on the JSON mode list. |
| `@cf/meta/llama-3.1-70b-instruct` | 70B | Same size, older, not fp8-fast. |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 32B | Reasoning model, more expensive ($0.497/$4.881 per M). |
| `@cf/meta/llama-3.1-8b-instruct-fast` | 8B | Much smaller, unlikely to improve. |
| Others | 7-11B | Too small for this task. |

### Newer Models NOT on JSON Mode List

| Model | Context | JSON mode? | Notes |
|---|---|---|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 131K tokens | **Yes** — API schema shows `response_format` with `json_schema` | MoE, 109B total/17B active. Blog post confirms 131K context. |
| `@cf/openai/gpt-oss-120b` | ? | Unknown | New, OpenAI open-weight. |
| `@cf/openai/gpt-oss-20b` | ? | Unknown | New, OpenAI open-weight. |
| `@cf/nvidia/nemotron-3-120b-a12b` | ? | Unknown | MoE, function calling supported. |
| `@cf/qwen/qwen3-30b-a3b-fp8` | ? | Unknown | MoE, function calling supported. |
| `@cf/zai-org/glm-4.7-flash` | 131K tokens | Unknown | Fast, multilingual. |

**Key finding: Llama 4 Scout supports `response_format` with `json_schema`** per its API schema on the model page, even though the JSON mode docs page hasn't been updated to list it. The docs page says "We will continue extending this list."

### Llama 4 Scout Advantages

From blog post `blog.cloudflare.com/meta-llama-4-is-now-available-on-workers-ai/`:
- **131,000 token context window** (vs ~24K for llama-3.3-70b) — our invoice markdown is ~5.4K chars + schema + prompt, well within limits
- **109B total parameters** (17B active via MoE) — potentially stronger reasoning than 70B
- **Natively multimodal** — not needed now but future-proof
- **$0.27/$0.85 per M tokens** — slightly cheaper than llama-3.3-70b ($0.293/$2.253)
- Function calling support suggests the model handles structured output well

## Assessment

There are two possible root causes:

### 1. Model/JSON mode limitation

The llama-3.3-70b model or Workers AI's JSON mode implementation can't handle our schema. Nested `anyOf` objects + arrays of objects may exceed what their constrained decoding supports. But **there is no documentation of these limitations** — I cannot point to any Cloudflare doc that says "JSON mode doesn't support nested objects" or "arrays of objects break constrained decoding." The docs just say schemas may fail "in extreme situations."

### 2. Infrastructure/transient error

Error 1031 appears across D1, AI, and markdown conversion — all unrelated services. It may be a general upstream timeout or routing failure. The expanded schema requires more output tokens (4096 vs 256) and more processing time, which could trigger timeouts.

## Relevant GitHub Issues

### cloudflare/workers-sdk#10801 — D1_ERROR with 1031 (Open)

`D1_ERROR: Failed to parse body as JSON, got: error code: 1031` when D1 remote bindings go idle. Labeled `bug`, `d1`, `remote-bindings`. Status: Backlog. No Cloudflare response. Confirms 1031 is a remote binding infrastructure error, not AI-specific.

### cloudflare/workers-sdk#10857 — Workers AI InferenceUpstreamError (Closed)

`InferenceUpstreamError: Error: internal error` with `@hf/nousresearch/hermes-2-pro-mistral-7b` on wrangler >4.35.0. Simple hello world prompt (no JSON mode). Labeled `awaiting Cloudflare response`. Closed without resolution comment visible. This was a wrangler version regression, not related to schema complexity.

### cloudflare/workers-sdk#12398 — `response` field type incorrect with JSON Mode (Open)

User with `@hf/nousresearch/hermes-2-pro-mistral-7b` and a schema with **array of objects** (quiz questions) gets `InferenceUpstreamError: 3025: error with TGI API: max_new_tokens must be <= 1024. Given: 1321`. The JSON schema + prompt tokens are being counted against `max_new_tokens` internally. Labeled `internal`, `workers ai`. **This is the closest issue to ours** — complex schema with arrays of objects, JSON mode, InferenceUpstreamError.

Key detail from #12398: Workers AI's internal token accounting appears to add the schema token cost to the output token budget. With complex schemas, this can exceed internal limits (1024 for hermes, likely different for llama-3.3-70b). Our schema is ~30 fields with nested structs — this plausibly pushes the internal token budget over a limit, producing error 1031 instead of the more descriptive 3025 error.

### Cloudflare Discord — Error 1031 with ai.toMarkdown()

User "Anton" (Dec 2025) reported error 1031 with `ai.toMarkdown()` for JPG conversion. Cloudflare responded asking for more details but noted it was different from documented errors. Confirms 1031 is used across multiple AI subsystems.

### Summary

No one has reported a complex `json_schema` causing error 1031 specifically. But #12398 shows that complex schemas with arrays of objects DO cause InferenceUpstreamErrors due to internal token accounting bugs. Our situation is likely the same class of problem with a different error code.

## Recommended Next Steps

### Step 1: Try Llama 4 Scout

Switch to `@cf/meta/llama-4-scout-17b-16e-instruct`. It has:
- `response_format` with `json_schema` per its API schema
- 131K context window (eliminates any context pressure)
- Potentially better structured output handling (newer model, function calling support)

This tests whether the problem is model-specific. If it works, we're done. If it also returns 1031, the problem is the schema or Workers AI's JSON mode implementation.

### Step 2: If Llama 4 fails too — flatten the schema

Remove nested structs but keep all fields:

```ts
const InvoiceExtractionSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  invoiceNumber: Schema.NullOr(Schema.String),
  invoiceDate: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  vendorName: Schema.NullOr(Schema.String),
  vendorEmail: Schema.NullOr(Schema.String),
  vendorAddress: Schema.NullOr(Schema.String),
  billToName: Schema.NullOr(Schema.String),
  billToEmail: Schema.NullOr(Schema.String),
  billToAddress: Schema.NullOr(Schema.String),
  subtotal: Schema.NullOr(Schema.String),
  tax: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.String),
  amountDue: Schema.NullOr(Schema.String),
  lineItems: Schema.NullOr(Schema.Array(LineItemSchema)),
})
```

This eliminates nested `anyOf` for addresses (no more `NullOr(AddressSchema)`) while keeping all data. The addresses become single concatenated strings.

### Step 3: If arrays of objects also fail — extract line items separately

Keep a flat schema without `lineItems` for the first pass. Do a second pass with a simple schema to extract line items. Or extract line items as a JSON string field that we parse separately.

Line items are critical. They should not be dropped. But they may need to be extracted in a separate call if the model can't handle the full schema.

### Step 4: Consider AI Gateway URL path with external model

If Workers AI models fundamentally can't handle this, route through AI Gateway to an external provider (OpenAI, Anthropic) via the URL path. The gateway supports this. But this adds complexity and cost, and should be a last resort.
