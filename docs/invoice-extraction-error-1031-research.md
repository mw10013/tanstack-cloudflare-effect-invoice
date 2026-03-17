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

### Step 1: Try Llama 4 Scout — DONE, still 1031

Switched to `@cf/meta/llama-4-scout-17b-16e-instruct`. Same `InferenceUpstreamError: error code: 1031`. This **rules out the model-specific theory** — the problem is the schema complexity or Workers AI's JSON mode implementation, not the model.

Server log confirmed Scout received the request and failed identically to llama-3.3-70b.

### Step 2: Flatten the schema — DONE, still 1031

Removed nested `AddressSchema` structs, replaced with flat string fields (`vendorName`, `vendorEmail`, `vendorAddress`, `billToName`, `billToEmail`, `billToAddress`). Kept `lineItems: NullOr(Array(LineItemSchema))`. Same error.

**This means even without nested `NullOr(Struct)`, the `NullOr(Array(Struct))` for lineItems (or possibly the total field count + `anyOf` unions from `NullOr`) is enough to trigger 1031.**

### Step 3: Remove lineItems array entirely — DONE, still 1031

Removed `lineItems` entirely. Schema was completely flat: 1 boolean + 14 `NullOr(String)` fields. No arrays, no nested objects. **Still 1031.**

Logged the actual JSON schema sent to the API. Every `NullOr(String)` generates `anyOf: [{type: "string"}, {type: "null"}]`. The original working schema (just `isInvoice: Boolean` + `total: String`) had no `anyOf` at all.

**Root cause identified: Workers AI's JSON mode does not support `anyOf` in schemas.** The `NullOr` combinator in Effect Schema produces `anyOf` unions which Workers AI cannot handle. This is undocumented — the Cloudflare docs only show simple types in their JSON schema examples.

### Step 4: Drop NullOr entirely, use plain String — DONE, works after `pnpm clean`

Replaced all `NullOr(String)` with `String`. Missing values become empty string `""` instead of `null`.

**However:** Steps 1–3 all failed with 1031 even with progressively simpler schemas. Step 4 (plain String, no `anyOf`) succeeded — but only after `pnpm clean` and a fresh dev server restart. **This strongly suggests the prior failures were caused by a stale/corrupt dev environment, not schema complexity.** The `pnpm clean` likely cleared cached wrangler state, stale bindings, or a broken miniflare instance.

**Revised root cause: Error 1031 was likely a stale dev environment issue**, not a JSON schema limitation. The `anyOf`, nested objects, and arrays may all work fine. However, since we can't be certain which factor contributed, we are proceeding conservatively: use plain `String` (no `anyOf`/`NullOr`) and test adding back features incrementally.

### Step 5: Re-add lineItems array (no NullOr) with llama-3.3-70b — DONE, 504 Gateway Time-out

Added back `lineItems: Schema.Array(LineItemSchema)` with all-String fields. Got `504 Gateway Time-out` (not 1031). The model is trying to generate ~40 line items with constrained decoding and exceeds Cloudflare's upstream timeout. This is the same class of issue as #12398 — large structured output overwhelms the internal token/time budget.

### Step 6: Try Llama 4 Scout with lineItems — DONE, response returned but two issues

Scout completed the request (no timeout!) and extracted all ~40 line items with good data quality. But two problems:

1. **`response` is a JSON string, not a parsed object.** Llama-3.3-70b returns `{"response": {…object…}}` but Scout returns `{"response": "{…json string…}"}`. This is a known model-specific behavior — Scout is not on the official JSON Mode supported list (`json-mode.mdx:114-123`), and its `response_format` support appears to work differently. The decode fails because Effect Schema expects an object, gets a string.

2. **Malformed JSON in the string.** Every line item has a misplaced comma — the closing `}` for each object is missing before the comma+period field:
   ```json
   "amount": "$0.00"
   ,
   "period": "Feb 4–Mar 3, 2026"
   ```
   Should be: `"amount": "$0.00", "period": "..."`. This means Scout's JSON mode is not doing proper constrained decoding for arrays of objects — it generates syntactically invalid JSON.

**Scout is fast enough but its JSON mode is broken for complex schemas.** The response_format API exists but doesn't enforce valid JSON structure like llama-3.3-70b does.

## Revised Assessment (after all experiments)

### Model Comparison

| | Llama 3.3 70B | Llama 4 Scout |
|---|---|---|
| Architecture | Dense 70B (fp8) | MoE 109B total / 17B active |
| Context | 24K tokens | 131K tokens |
| Pricing | $0.293/$2.253 per M | $0.27/$0.85 per M |
| JSON Mode | Official support, constrained decoding | Has `response_format` API but NOT on official JSON Mode list |
| Response format | `response` = parsed object | `response` = JSON string (must JSON.parse) |
| JSON validity | Valid JSON (constrained decoding works) | **Malformed JSON** for complex schemas (arrays of objects) |
| Speed | Slower (70B dense) — 504 timeout on ~40 line items | Faster (17B active MoE) — completes within timeout |
| Created | 2024-12-06 | 2025-04-05 |

### The Core Problem

**Llama 3.3 70B** produces valid JSON via constrained decoding but is too slow for large structured output (~40 line items), causing 504 Gateway Time-out.

**Llama 4 Scout** is fast enough but produces invalid JSON — its `response_format` support is incomplete (returns string instead of object, generates malformed JSON for arrays of objects).

### AI Gateway Timeout Research

From `refs/cloudflare-docs/src/content/docs/ai-gateway/`:

- AI Gateway supports configurable timeouts via `requestTimeout` (ms) in Universal Endpoint config, or `cf-aig-request-timeout` header for direct provider requests
- Dynamic Routing supports a `timeout` property (ms) per Model element
- **But the `ai.run()` binding gateway option only supports `id`, `skipCache`, `cacheTtl`** — no timeout parameter
- Workers AI error code 3007 = timeout (HTTP 408), but our 504 comes from the gateway/infrastructure layer
- No way to increase the timeout through the binding's gateway config — would need to use the REST API or Universal Endpoint instead

**Key refs:**
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx` — timeout config
- `refs/cloudflare-docs/src/content/docs/ai-gateway/features/dynamic-routing/json-configuration.mdx` — dynamic routing timeout
- `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx:118-125` — binding gateway options (no timeout)

### max_tokens Research

**Default max_tokens is 256.** Far too small for structured JSON with line items — a 40-item invoice needs ~3500 output tokens. We set 8192 to handle large invoices (100+ items) without truncation. `max_tokens` is a ceiling — model stops when JSON is complete, higher values don't cause slower generation.

### Timing Results

| Config | Model | lineItems | max_tokens | Result | Time |
|---|---|---|---|---|---|
| Step 7 | llama-3.3-70b | yes (40 items) | 8192 | 504 Gateway Time-out | ~60s (timeout) |
| Step 8 | llama-3.3-70b | no (commented out) | 8192 | Success | 31,309ms |

**The gateway timeout appears to be ~60 seconds.** Flat schema (15 string fields) takes ~31s on llama-3.3-70b. Adding ~40 line items would roughly triple the output tokens, pushing well past 60s.

This is a hard infrastructure limit. The `ai.run()` binding gateway config only supports `id`, `skipCache`, `cacheTtl` — no timeout parameter. AI Gateway does support `requestTimeout` via Universal Endpoint / `cf-aig-request-timeout` header, but not through the binding.

### Official JSON Mode Models

Only these models have constrained decoding (guaranteed valid JSON):

| Model | Params | Context | Pricing (in/out per M) | Notes |
|---|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B dense | 24K | $0.293/$2.253 | Proven reliable. Slow — 31s for flat schema. |
| `@cf/meta/llama-3.1-70b-instruct` | 70B dense | 24K | $0.293/$2.253 | Same size, older, not fp8-fast. |
| **`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`** | **32B dense** | **80K** | **$0.497/$4.881** | **Reasoning model. 32B = ~2x faster generation than 70B. 80K context. "Outperforms o1-mini across benchmarks."** |
| `@cf/meta/llama-3.1-8b-instruct-fast` | 8B | 128K | — | Too small for extraction quality. |
| `@cf/meta/llama-3.2-11b-vision-instruct` | 11B | — | — | Vision model, small. |
| Others (7-8B) | — | — | — | Too small. |

**DeepSeek R1 Distill Qwen 32B is the most promising alternative.** It's on the official JSON Mode list (constrained decoding guaranteed), 32B params (roughly 2x faster than 70B), 80K context window, and is a reasoning model which may produce better structured output. More expensive per token but if it completes within the timeout, cost is secondary.

**Models NOT on JSON Mode list but have `response_format` in API schema:** Scout, GPT-OSS 120B/20B, Nemotron-3-120B, Qwen3-30B. These do NOT do constrained decoding — Scout confirmed to produce malformed JSON. The `response_format` API existing on a model does NOT mean it enforces valid JSON output.

### Scout Conclusion — ABANDONED

Scout does not do constrained decoding for JSON mode. It returns `response` as a JSON string (not parsed object) and produces **malformed JSON** for arrays of objects (misplaced commas, missing closing braces). This is consistent and reproducible, not transient. All models not on the official JSON Mode list should be assumed to have the same problem.

### Recommended Path Forward

#### ~~Option A: Reduce output size~~ — REJECTED

Can't restrict to a simplistic schema. Schema will grow over time.

#### ~~Option B: Scout + JSON repair~~ — REJECTED

Scout doesn't do constrained decoding. Malformed JSON is a model-level problem, not fixable in code without fragile heuristics.

#### ~~Option C: Two-pass extraction~~ — REJECTED

Two API calls adds too much complexity.

#### ~~Option D: REST API with custom timeout~~ — REJECTED

Must stick with Workers AI binding.

#### ~~Option E: Llama 3.3 70B + remove max_tokens~~ — WRONG

max_tokens is a ceiling, not a reservation. Removing it would just truncate output. The 504 is caused by generation time on the 70B model, not token budget.

#### Option F: Try DeepSeek R1 Distill Qwen 32B — NEXT

Switch to `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` with lineItems re-enabled. It's on the official JSON Mode list (constrained decoding), 32B params (should generate ~2x faster than 70B), 80K context. If 31s for flat schema on 70B, the full schema with lineItems on 32B might complete in ~45-50s — tight but potentially within the ~60s timeout.

### Code State

- `AiResponseSchema` uses `Schema.Union([InvoiceExtractionSchema, Schema.fromJsonString(InvoiceExtractionSchema)])` to handle both object and string response formats idiomatically via Effect v4 Schema, making the code model-agnostic for future model switches.
- Server-side timing added to `ai.run()` calls (both success and error paths).
- `max_tokens: 8192` with comment explaining why default 256 is too small.
