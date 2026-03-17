# Invoice Extraction Research

## Problem

Extracting structured invoice data (header fields + ~40 line items) via Workers AI JSON mode. The ~60s gateway timeout is the primary constraint.

## Error 1031

**Undocumented.** Appears across Workers AI, D1, ai.toMarkdown() — a generic Cloudflare infrastructure error. Our initial 1031 errors were caused by a **stale dev environment** (`pnpm clean` resolved them), not schema complexity.

Relevant: cloudflare/workers-sdk#12398 — complex schemas with arrays of objects cause InferenceUpstreamErrors due to internal token accounting bugs.

## Gateway Timeout (~60s)

The `ai.run()` binding gateway config only supports `id`, `skipCache`, `cacheTtl` — **no timeout parameter**. AI Gateway supports `requestTimeout` via Universal Endpoint or `cf-aig-request-timeout` header, but not through the binding.

## Experiment Results

| Model | Params | lineItems | Result (from AI Gateway dashboard) | Time |
|---|---|---|---|---|
| llama-3.3-70b (flat schema) | 70B dense | no | **Success** | 31,309ms |
| llama-3.3-70b | 70B dense | yes (40 items) | **3046 Request timeout** (408) | ~60s |
| deepseek-r1-qwen-32b | 32B reasoning | yes (40 items) | **5024 JSON Model couldn't be met** (403) | 60,212ms |
| qwen3-30b-a3b-fp8 | MoE 3B active | yes (40 items) | **3046 Request timeout** (408) | 60,141ms |
| llama-4-scout (MoE 17B active) | 109B MoE | yes (40 items) | Response returned, **malformed JSON** | fast |

**Critical discovery:** The `ai.run()` binding wraps all AI Gateway errors into a generic `InferenceUpstreamError` with an HTML `504 Gateway Time-out` body. The actual structured error (JSON with `internalCode`, `description`, `requestId`) is lost. We were treating DeepSeek R1's "JSON Model couldn't be met" (5024) as a timeout when it's a completely different failure — the model genuinely cannot satisfy the JSON schema constraint.

### Error Types Observed

- **3046 Request timeout (408):** Model ran out of time. Given more time, it would likely succeed. (llama-3.3-70b, qwen3)
- **5024 JSON Model couldn't be met (403):** Model fundamentally cannot satisfy the JSON schema with constrained decoding. Not a speed issue. (deepseek-r1)
- **1031 (undocumented):** Stale dev environment issue. Resolved by `pnpm clean`.

### Observability Gap

The `ai.run()` binding provides terrible error observability. All errors arrive as `InferenceUpstreamError` with HTML body — no error code, no description, no request ID. The AI Gateway dashboard shows the real errors but that requires manual inspection. The REST API approach would return the actual JSON error response, improving both observability and debugging.

## JSON Mode: Official vs Unofficial

**Official JSON Mode list** (`json-mode.mdx:114-123`) — these do constrained decoding (guaranteed valid JSON):

| Model | Params | Context | Pricing (in/out per M) |
|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B dense | 24K | $0.293/$2.253 |
| `@cf/meta/llama-3.1-70b-instruct` | 70B dense | 24K | $0.293/$2.253 |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 32B reasoning | 80K | $0.497/$4.881 |
| Others (7-11B) | — | — | — |

**NOT on official list** but have `response_format` in API schema:

| Model | Params | Context | Notes |
|---|---|---|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | MoE 109B/17B active | 131K | **Tested.** Returns JSON string (not object), produces malformed JSON. No constrained decoding. |
| `@cf/openai/gpt-oss-120b` | 120B | 128K | Untested. |
| `@cf/openai/gpt-oss-20b` | 20B | 128K | Untested. |
| `@cf/nvidia/nemotron-3-120b-a12b` | MoE 120B/12B active | 32K | Untested. Function calling support. |
| `@cf/qwen/qwen3-30b-a3b-fp8` | MoE 30B/3B active | 32K | Untested. Function calling support. |

Scout proved that `response_format` in the API schema does NOT guarantee constrained decoding. But Scout is one data point — other models may behave differently.

## Scout Findings

Scout returns `response` as a JSON **string** (not parsed object) and produces **malformed JSON** for arrays of objects (misplaced commas). Consistent and reproducible. Abandoned.

The `AiResponseSchema` uses `Schema.Union([InvoiceExtractionSchema, Schema.fromJsonString(InvoiceExtractionSchema)])` to handle both response formats (object or string) idiomatically via Effect v4 Schema.

## max_tokens

Default is 256 — far too small for structured JSON with line items. Set to 8192 to cover large invoices (100+ items). `max_tokens` is a ceiling; model stops when JSON is complete.

## Code State

- Model: `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` (last tested)
- lineItems: enabled in schema
- `max_tokens: 8192`
- `AiResponseSchema` handles both object and string response formats
- Server-side timing on `ai.run()` calls

## Additional Experiments

See main experiment results table above. Qwen3 timed out (3046), DeepSeek R1 couldn't meet JSON schema (5024).

## AI Gateway REST API Experiments

Implemented `runInvoiceExtractionViaGateway()` alongside original `runInvoiceExtraction()` (binding version preserved).

**URL:** `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/{model_id}`

**Headers:** `Authorization`, `cf-aig-authorization`, `cf-aig-request-timeout`, `Content-Type`

### Result: 120s gateway timeout — still failed

```
elapsedMs: 120,641
status: 408
error: { code: 2014, message: "Provider request timeout" }
```

The gateway timeout worked — request ran 2 min, not 60s. But **Workers AI itself timed out**. Error `2014: Provider request timeout` means the gateway waited, but the upstream Workers AI provider hit its own internal timeout.

**Two separate timeouts:**
1. **AI Gateway timeout** (`cf-aig-request-timeout`) — we control this ✓
2. **Workers AI provider timeout** — internal to Cloudflare, we do NOT control

The `ai.run()` binding was hitting the same Workers AI provider timeout — the 504 HTML was just a worse representation of the same limit.

### Result: 300s gateway timeout — still failed at ~120s

```
elapsedMs: 120,918
status: 408
error: { code: 3046, message: "Request timeout", requestId: "21fa6995-..." }
```

Workers AI timed out at ~120s despite our 300s gateway timeout. The provider has a hard internal timeout we cannot override.

**But:** DeepSeek R1 ran for **544,143ms (9+ minutes)** before returning `5024: JSON Model couldn't be met`. This means Workers AI does NOT have a universal 120s timeout. The timeout varies — possibly:
- **Per-model timeout:** 70B dense models get 120s, reasoning models get longer
- **Timeout vs constraint failure:** The 120s limit may apply to generation time, while DeepSeek's 544s was spent in the constrained decoding retry loop (different code path, different timeout)
- **Token generation timeout:** If the model stops producing tokens for some period, it times out. DeepSeek was actively generating (but failing to meet constraints), while llama-3.3-70b may have been stuck in constrained decoding

**Key insight:** The timeout is not something we can control from outside. It's internal to Workers AI's inference infrastructure and varies by model/situation.

### Where This Leaves Us

| Model | JSON Mode | Speed | Problem |
|---|---|---|---|
| llama-3.3-70b | Official, constrained decoding ✓ | Too slow (70B dense) | 3046 timeout at ~120s |
| deepseek-r1-qwen-32b | Official, constrained decoding ✓ | Ran 544s | 5024 JSON Model couldn't be met |
| qwen3-30b-a3b-fp8 | NOT official | Fast (3B active MoE) | 3046 timeout at ~60s |
| llama-4-scout | NOT official | Fast (17B active MoE) | Malformed JSON, no constrained decoding |

No Workers AI model can currently extract ~40 structured line items via JSON mode within the provider timeout. The fundamental issue is that constrained JSON decoding on Workers AI is too slow for large structured output.

### Remaining viable options

1. **External model via AI Gateway** — route to OpenAI/Anthropic which handle structured output much faster. AI Gateway supports this.
2. **Drop JSON mode, use plain text** — prompt llama to output JSON as text (no constrained decoding), then parse. Faster but no validity guarantee.
3. **Reduce line items** — extract only non-zero amount items (cuts ~40 to ~3 for this invoice). Schema stays full, just less data.
4. **Wait for Cloudflare** — file support ticket, wait for faster models or higher timeouts.

**Refs:**
- `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/workersai.mdx`
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/request-handling.mdx`
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx`
