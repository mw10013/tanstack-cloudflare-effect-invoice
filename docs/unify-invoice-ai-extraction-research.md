# Unify Invoice AI Extraction Research

## Problem

Two call sites duplicate Workers AI invoice extraction logic independently:

1. **Tester** — `src/routes/ai-direct.tsx` (server fn, local-only dev tool)
2. **Workflow** — `src/organization-agent.ts` (`InvoiceExtractionWorkflow.run`)

If the prompt, model, params, or parsing logic changes in one, the other drifts silently.

## Current State — Side-by-Side

| Element              | `ai-direct.tsx` (L47-93)                                                                                                            | `organization-agent.ts` (L346-425)                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                | `"@cf/meta/llama-3.3-70b-instruct-fp8-fast"` inline                                                                                 | same, inline                                                                                                                                             |
| Prompt               | `` `Determine whether...Reply with JSON only.\n\n${markdown}` ``                                                                    | identical                                                                                                                                                |
| `response_format`    | `{ type: "json_schema", json_schema: InvoiceExtractionJsonSchema }`                                                                 | identical                                                                                                                                                |
| `max_tokens`         | 256                                                                                                                                 | 256                                                                                                                                                      |
| `temperature`        | 0                                                                                                                                   | 0                                                                                                                                                        |
| Gateway              | `{ id: env.AI_GATEWAY_ID, skipCache: true, cacheTtl: 7d }`                                                                          | identical via `this.env`                                                                                                                                 |
| **Response parsing** | `Schema.decodeUnknownSync(Schema.Struct({ response: InvoiceExtractionScheme }))(raw)` — assumes `raw` is `{ response: ... }` object | handles 3 cases: `typeof result === "string"` -> `JSON.parse`, `result.response` as string -> `JSON.parse`, `result.response` as object -> direct decode |
| Error wrapping       | returns `AiFailure` with formatted error string                                                                                     | wraps in `Error` with `"extract-invoice-json:"` prefix (used by `onWorkflowError` to distinguish markdown vs json errors)                                |
| Logging              | none                                                                                                                                | `console.log` at start, raw result, success; `console.error` on failure                                                                                  |

### Key Divergence: Response Parsing

`ai-direct.tsx` is **less robust** — it only handles `{ response: <object> }`. The workflow version handles the full matrix of Workers AI return shapes (string result, string `response` field, object `response` field). If the model returns a string instead of an object, the tester would fail while the workflow succeeds.

NO, ai-direct approach is better. USE IT.

## Shared Module Today

`src/lib/invoice-extraction.ts` already exports:

- `InvoiceExtractionScheme` — effect/Schema struct
- `decodeInvoiceExtraction` — `Schema.decodeUnknownSync(InvoiceExtractionScheme)`
- `InvoiceExtractionJsonSchema` — JSON Schema derived from the effect Schema
- `SAMPLE_INVOICE_MARKDOWN` — sample invoice for testing

## Proposal: Extract `runInvoiceExtraction`

Add to `src/lib/invoice-extraction.ts`:

```ts
export const INVOICE_EXTRACTION_MODEL: keyof AiModels =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const runInvoiceExtraction = async ({
  ai,
  gatewayId,
  markdown,
}: {
  readonly ai: Ai;
  readonly gatewayId: string;
  readonly markdown: string;
}): Promise<typeof InvoiceExtractionScheme.Type> => {
  const result = await ai.run(INVOICE_EXTRACTION_MODEL, { ... }, { gateway: { ... } });
  // unified parsing (workflow's robust version)
  // returns decoded InvoiceExtraction
};
```

### Consumer Changes

**`ai-direct.tsx`** — replace inline `AI.run` + parsing with:

```ts
const parsed = await runInvoiceExtraction({
  ai: env.AI,
  gatewayId: env.AI_GATEWAY_ID,
  markdown,
});
```

Still wraps in try/catch to produce `AiSuccess`/`AiFailure` with timing. `raw` field would become the parsed result (or could be dropped).

**`organization-agent.ts`** — replace `runExtractInvoiceJson` body with:

```ts
const invoiceJson = await runInvoiceExtraction({
  ai: this.env.AI,
  gatewayId: this.env.AI_GATEWAY_ID,
  markdown,
});
```

Keep the surrounding `console.log` calls and `extractInvoiceJsonErrorPrefix` error wrapping in the workflow.

### What stays per-consumer

| Concern                                    | Stays in consumer       |
| ------------------------------------------ | ----------------------- |
| Timing (`Date.now()`)                      | `ai-direct.tsx`         |
| `AiSuccess`/`AiFailure` result types       | `ai-direct.tsx`         |
| `console.log` structured logging           | `organization-agent.ts` |
| Error prefix for `onWorkflowError` routing | `organization-agent.ts` |
| `step.do` retry semantics                  | `organization-agent.ts` |

### Imports removed from consumers

- `ai-direct.tsx`: `InvoiceExtractionScheme`, `InvoiceExtractionJsonSchema`, `Schema` (effect/Schema)
- `organization-agent.ts`: `decodeInvoiceExtraction`, `InvoiceExtractionJsonSchema`

## Open Questions

<!-- Annotate below -->

1. **Should the model constant be exported?** The tester UI currently displays the model name. Exporting `INVOICE_EXTRACTION_MODEL` lets it reference the single source of truth. Alternatively, `runInvoiceExtraction` could return `{ model, parsed }` so the UI has it.

yeah

2. **Drop `raw` from `AiSuccess`?** Today `ai-direct.tsx` returns `raw` (the full AI response before parsing). With a shared function, we'd either (a) return raw from the shared fn too, (b) drop it, or (c) keep `parsed` only. The UI only renders `parsed`.

shit, maybe we better clean up ai-direct first. wtf is AiSuccess? what bullshit is that

3. **Logging in the shared function vs consumer?** The workflow has structured `console.log` calls with `invoiceId`, `attempt`, etc. These are workflow-specific context. Keeping logging in the consumer seems right — the shared function is a pure AI call + parse.

doesn't matter. they are just debug

4. **Gateway config parameterizable?** Both use identical gateway config today (`skipCache: true`, `cacheTtl: 7d`). If you'd want the tester to behave differently (e.g., use cache), the shared function could accept optional gateway overrides. For now, hardcoding seems fine since they match.

we want to dry it
