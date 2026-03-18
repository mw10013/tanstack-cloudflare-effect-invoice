# Research: Invoice Extraction via Gemini Flash & Cloudflare AI Gateway

## 1. Core Architecture

Use Gemini Flash as the vision+extraction model instead of Workers AI models (which are too small for accurate invoice OCR). Route through the existing Cloudflare AI Gateway for logging, caching, analytics.

- **Model Provider:** Google AI Studio (Gemini 2.5 Flash)
- **Proxy Layer:** Cloudflare AI Gateway (already set up in this project)
- **Execution Layer:** Cloudflare Workers

## 2. Model: Gemini 2.5 Flash

- **Multimodal:** Accepts images and PDFs directly — no separate OCR step needed. The model reads the document visually and extracts structured data in one call.
- **Structured Output:** Native JSON schema enforcement via `responseMimeType: "application/json"` + `responseSchema`.
- **Cost:** ~$0.10/M input tokens, ~$0.40/M output tokens (verify current pricing at [ai.google.dev](https://ai.google.dev/pricing)).
- **Rate Limits (Paid Tier):** 2,000 RPM.
- **Privacy:** Paid tier data is not used for training.

This replaces the current two-step pipeline (PDF → `toMarkdown` → `gpt-oss-120b`) with a single model call that can handle both PDFs and images.

## 3. AI Gateway Configuration

### URL Structure

Per Cloudflare docs (`refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/google-ai-studio.mdx`):

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent
```

The gateway recognizes `google-ai-studio` as a provider slug in the URL path. No additional provider configuration needed on the dashboard beyond the gateway itself (which this project already has).

### Authentication — Three Options

The docs show three patterns:

**Option 1: API key in request header (simplest)**
Pass Google API key via `x-goog-api-key` header + `cf-aig-authorization` for the authenticated gateway:
```bash
curl "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent" \
  --header 'content-type: application/json' \
  --header 'cf-aig-authorization: Bearer {CF_AIG_TOKEN}' \
  --header 'x-goog-api-key: {google_studio_api_key}' \
  --data '{ ... }'
```

**Option 2: BYOK (Store key in dashboard)**
Store the Google API key in AI Gateway → Provider Keys. Then only `cf-aig-authorization` is needed — gateway injects the Google key automatically:
```bash
curl "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent" \
  --header 'content-type: application/json' \
  --header 'cf-aig-authorization: Bearer {CF_AIG_TOKEN}' \
  --data '{ ... }'
```

**Option 3: Unauthenticated gateway**
If gateway auth is disabled, only `x-goog-api-key` is needed. Not recommended.

### Correction from original research

The original doc said authentication is via query param (`?key=YOUR_KEY`). **That's wrong.** Per the Cloudflare docs, the Google API key goes in the `x-goog-api-key` header, not as a query parameter. The query param style is the native Google AI Studio API format, but when proxied through AI Gateway, use headers.

### Fits existing project pattern

This project already uses the gateway with `cf-aig-authorization` header + provider auth header (see `src/lib/invoice-extraction.ts` L191-196). For Google AI Studio, swap `Authorization: Bearer {workersAiApiToken}` → `x-goog-api-key: {googleApiKey}`.

## 4. Implementation

### Request Body (Gemini generateContent API)

```typescript
const response = await fetch(
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1/models/gemini-2.5-flash:generateContent`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": googleApiKey,
      "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: buildPrompt() },
          { inlineData: { mimeType: "image/jpeg", data: base64ImageData } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: InvoiceExtractionJsonSchema,
      },
    }),
  }
);
```

### Schema

Reuse the existing `InvoiceExtractionSchema` and `InvoiceExtractionJsonSchema` from `src/lib/invoice-extraction.ts`. Gemini's `responseSchema` accepts JSON Schema format which `Schema.toJsonSchemaDocument` already produces.

### Effect v4 Note

The original research doc used `import { Schema, JSONSchema } from "@effect/schema"` — that's Effect v3 syntax. In Effect v4, it's:
```typescript
import * as Schema from "effect/Schema";
const jsonSchema = Schema.toJsonSchemaDocument(InvoiceExtractionSchema);
```
The project already does this correctly in `src/lib/invoice-extraction.ts`.

## 5. PDF Handling

Gemini Flash accepts PDFs directly via `inlineData` with `mimeType: "application/pdf"`. This means:
- **Images:** Send as `image/jpeg` or `image/png` in `inlineData`
- **PDFs:** Send as `application/pdf` in `inlineData`

No need for `toMarkdown` at all — Gemini handles the visual parsing internally. This is a major simplification over the current pipeline.

## 6. Production Checklist

1. **Google AI Studio API Key:** Get from [aistudio.google.com](https://aistudio.google.com/)
2. **Enable Billing:** Link credit card for paid tier (privacy guarantee, higher rate limits)
3. **Store key:** Either as Cloudflare secret (`wrangler secret put GOOGLE_AI_STUDIO_KEY`) or via BYOK in AI Gateway dashboard
4. **Gateway:** Already exists in this project (`AI_GATEWAY_ID` env var)
5. **No dashboard config needed:** The gateway proxies to `google-ai-studio` based on the URL path — it's automatic

## 7. Comparison with Current Approach

| | Current (Workers AI) | Proposed (Gemini Flash) |
|---|---|---|
| **PDF flow** | `toMarkdown` → `gpt-oss-120b` (2 calls) | Single Gemini call |
| **Image flow** | Not supported well | Single Gemini call |
| **Model size** | 120B text-only + 12B vision | Gemini 2.5 Flash (multimodal) |
| **Structured output** | Responses API JSON schema | Native `responseSchema` |
| **Cost** | $0.35/M in + $0.75/M out (gpt-oss) | ~$0.10/M in + ~$0.40/M out |
| **Accuracy on images** | Poor (11B vision → 120B text) | Good (purpose-built multimodal) |

## Sources

- `refs/cloudflare-docs/src/content/docs/ai-gateway/usage/providers/google-ai-studio.mdx`
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/bring-your-own-keys.mdx`
- `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/authentication.mdx`
- `src/lib/invoice-extraction.ts` (existing gateway + schema pattern)
