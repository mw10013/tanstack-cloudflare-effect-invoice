# Invoice Extraction Schema Research

Question: What should `InvoiceExtractionSchema` look like to capture structured data from invoice markdown?

## Invoice Markdown Structure Analysis

From `SAMPLE_INVOICE_MARKDOWN` in `src/lib/invoice-extraction.ts`, the structure of a Cloudflare invoice:

### Header Block (Page 1 top)

```
Invoice number: IN…58976233
Date of issue: March 4, 2026
Date due: March 4, 2026
```

### Vendor Block

```
Cloudflare, Inc.
101 Townsend Street
San Francisco, California 94107
United States
billing@cloudflare.com
```

### Bill-To Block

```
Daniel Alin Andrei Calota
Av. Reyes Católicos
37300 Peñaranda de Bracamonte Salamanca
Spain
gitcoinbitcoin@gmail.com
```

### Amount Due Summary

```
$5.39 USD due March 4, 2026
```

### Line Items (Pages 1–5)

Each line item follows the pattern:

```
Description (inclusion note)
Billing period (e.g., Feb 4–Mar 3, 2026)
Quantity  Unit price  Amount
```

Examples:
- Usage items: `Workers Paid, Mar 4–Apr 3, 2026, 1, $5.00, $5.00`
- Zero-usage items: `D1 - Storage GB-mo (first 5GB included), Feb 4–Mar 3, 2026, 0, $0.75, $0.00`
- Items with per-unit pricing: `Regular Twitch Neurons (RTN), Feb 4–Mar 3, 2026, 34,690, $0.011 per 1,000, $0.39`

### Totals Block (Page 5 bottom)

```
Subtotal $5.39
Total $5.39
Amount due $5.39 USD
```

### What Varies Across Invoices

Other invoices will likely differ in:
- Presence/absence of VAT/tax info
- Number and types of line items
- Address structure (some may lack state, postal code, etc.)
- Currency
- Vendor (not always Cloudflare)
- Billing period format
- Whether subtotal, tax, total are all present

## Optionality Approach: Schema.NullOr

All optional fields use `Schema.NullOr`. This puts every key in `required` in the generated JSON Schema, so the LLM always emits the key with either a value or `null`. Predictable, consistent output shape. Matches the codebase convention in `src/lib/Domain.ts` for nullable-but-always-present fields.

From `refs/effect4/packages/effect/SCHEMA.md:4702–4771`, `Schema.NullOr(Schema.String)` produces:
```json
{
  "type": "object",
  "properties": { "a": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
  "required": ["a"],
  "additionalProperties": false
}
```

## Proposed InvoiceExtractionSchema

```ts
const LineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.NullOr(Schema.String),
  unitPrice: Schema.NullOr(Schema.String),
  amount: Schema.NullOr(Schema.String),
  period: Schema.NullOr(Schema.String),
})

const AddressSchema = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  street: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  postalCode: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
})

const InvoiceExtractionSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  invoiceNumber: Schema.NullOr(Schema.String),
  invoiceDate: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  vendor: Schema.NullOr(AddressSchema),
  billTo: Schema.NullOr(AddressSchema),
  lineItems: Schema.NullOr(Schema.Array(LineItemSchema)),
  subtotal: Schema.NullOr(Schema.String),
  tax: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.String),
  amountDue: Schema.NullOr(Schema.String),
})
```

### Design Decisions

1. **`isInvoice: Schema.Boolean`** — kept as required boolean, non-nullable. The LLM must always answer yes or no.

2. **All amounts as `String` not `Number`** — keeps the raw value from the document (e.g., `"$5.39"`, `"$0.011 per 1,000"`). Parsing/normalizing amounts is a separate concern. Previous research (line 320) suggested `Number` but the LLM's numeric parsing of formatted currency strings like `"$1,234.56"` is unreliable.

3. **`vendor` and `billTo` as `NullOr(AddressSchema)`** — the entire address block may be missing on some invoices. `NullOr` on the struct itself means the LLM can return `null` for the whole block rather than a struct full of nulls.

4. **`lineItems: NullOr(Array(...))`** — if `isInvoice` is false, there are no line items. Using `NullOr` so the LLM can return `null` instead of an empty array, which is semantically clearer for "not applicable" vs "no items found."

5. **`period` on line items** — the sample invoice shows billing periods per line item (e.g., "Feb 4–Mar 3, 2026"). Not all invoices will have this.

6. **`email` on address** — the sample shows email addresses in both vendor and bill-to blocks. Not universal.

7. **No `total` property removed** — original request said "total probably has to go." But keeping it: `total` is a natural invoice field. The original schema had `total` as the only extraction field. Expanding the schema keeps `total` alongside other financial summary fields (`subtotal`, `tax`, `amountDue`).

### JSON Schema Impact

`NullOr(AddressSchema)` produces nested JSON Schema:
```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": { ... },
      "required": ["name", "street", ...],
      "additionalProperties": false
    },
    { "type": "null" }
  ]
}
```

This is well-supported by Workers AI `json_schema` constrained decoding. The model will emit either a full address object or `null`.

### LLM Schema Complexity Concern

From `docs/workers-ai-json-response-research.md:52`:
> Workers AI can't guarantee that the model responds according to the requested JSON Schema. Depending on the complexity of the task and adequacy of the JSON Schema, the model may not be able to satisfy the request.

The proposed schema is moderately complex (nested structs, array of structs). If the LLM struggles:
- Remove `lineItems` first (most complex part)
- Flatten `vendor`/`billTo` to top-level fields like `vendorName`, `billToName`
- Reduce to just header fields + totals

## Extraction Prompt

Current prompt (too narrow for expanded schema):
```
Determine whether the following markdown is an invoice and extract only the total if present. Reply with JSON only.
```

### New Prompt

```
You are an invoice data extraction assistant. You will receive markdown converted from a PDF document.

Analyze the document and extract structured invoice data according to the provided JSON schema.

Rules:
- Set isInvoice to true only if the document is clearly an invoice.
- If isInvoice is false, set all other fields to null.
- Extract only information explicitly present in the document. Never infer or guess values.
- Set fields to null when the information is not found in the document.
- Keep amounts as strings exactly as they appear in the document, including currency symbols (e.g., "$5.39", "$0.011 per 1,000").
- Keep dates as strings in whatever format appears in the document.
- For line items, include every line item found. Set quantity, unitPrice, or amount to null if not clearly stated for that item.
- For addresses, extract whatever address components are present. Set missing components to null.

Document:

{markdown}
```

### Prompt Design Rationale

- **Explicit null instruction** — prevents hallucination of missing fields
- **Amounts as strings** — avoids LLM numeric parsing errors on formatted currency (`"$1,234.56"`)
- **No few-shot examples** — the JSON Schema already constrains the output shape; adds token cost without clear benefit. Revisit if extraction quality is poor.
- **"Never infer or guess"** — LLMs tend to fill in plausible-looking data. This instruction reduces hallucination.
- **Single prompt (not messages array)** — current code uses `prompt` parameter, not `messages`. Both work with `response_format` per `docs/workers-ai-json-response-research.md:46`.

