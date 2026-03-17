# Invoice Extraction Schema Research

Question: What should `InvoiceExtractionSchema` look like to capture structured data from invoice markdown, and should optional fields use `Schema.NullOr` or `Schema.optionalKey`/`Schema.optional`?

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

## NullOr vs optionalKey vs optional — Research

### Effect v4 Primitives

From `refs/effect4/packages/effect/SCHEMA.md:331–397`:

| Primitive | TS Type | Key present? | Allows undefined? |
|---|---|---|---|
| `Schema.optionalKey(S)` | `readonly a?: T` | key can be absent | no (exactOptionalPropertyTypes) |
| `Schema.optional(S)` | `readonly a?: T \| undefined` | key can be absent | yes |
| `Schema.NullOr(S)` | `readonly a: T \| null` | key **always present** | no, but allows null |

### JSON Schema Output — Critical Difference

From `refs/effect4/packages/effect/SCHEMA.md:4702–4771`:

**`Schema.optionalKey(Schema.String)`** →
```json
{
  "type": "object",
  "properties": { "a": { "type": "string" } },
  "additionalProperties": false
}
```
Property is NOT in `required`. Key may be absent from JSON.

**`Schema.optional(Schema.String)`** → (`undefined` → `null` in JSON)
```json
{
  "type": "object",
  "properties": { "a": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
  "additionalProperties": false
}
```
Property is NOT in `required`. Uses `anyOf` with `null` type.

**`Schema.NullOr(Schema.String)`** (required key) →
```json
{
  "type": "object",
  "properties": { "a": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
  "required": ["a"],
  "additionalProperties": false
}
```
Property IS in `required`. LLM **must** emit the key (with value `string | null`).

### Existing Codebase Patterns

**Domain entities** (`src/lib/Domain.ts:88–135`) — use `Schema.NullOr` for DB columns that are nullable but always present:
```ts
image: Schema.NullOr(Schema.String),
banReason: Schema.NullOr(Schema.String),
```

**External API responses** (`src/lib/google-client.ts:40–70`) — use `Schema.optionalKey` for API fields that may be absent:
```ts
modifiedTime: Schema.optionalKey(Schema.String),
webViewLink: Schema.optionalKey(Schema.String),
```

**R2 metadata** (`src/worker.ts:173–179`) — use `Schema.optionalKey` for metadata fields that may not exist:
```ts
fileName: Schema.optionalKey(Schema.NonEmptyString),
contentType: Schema.optionalKey(Schema.NonEmptyString),
```

### Recommendation: NullOr for LLM-constrained JSON output

**Use `Schema.NullOr`** for optional fields in `InvoiceExtractionSchema`. Rationale:

1. **LLM JSON Schema constraint** — Workers AI `json_schema` mode uses constrained decoding. The schema tells the LLM exactly what to produce. With `NullOr`, every key is in `required` → the LLM always emits the key → the response shape is predictable and consistent. With `optionalKey`, the key is NOT in `required` → the LLM may or may not emit it → unpredictable.

2. **No `anyOf` ambiguity for `optionalKey`** — `optionalKey` produces `{ "type": "string" }` (no null, no required). The LLM doesn't know if it should emit the key or not. `NullOr` produces `{ "anyOf": [{"type":"string"},{"type":"null"}], required }` which is explicit: emit the key, use null if absent.

3. **Codebase convention for "might not have a value"** — Domain.ts consistently uses `NullOr` for nullable columns. Invoice extraction fields follow the same pattern: they represent data that may or may not be present in the source document.

4. **Previous research agrees** — From `docs/invoice-json-extraction-research.md:317`:
   > Using `NullOr` instead of `optional` because the LLM should always return the key (just set to `null` if not found). This produces cleaner JSON Schema with no `anyOf`/`oneOf` complexity that could confuse the model.

**Exception**: `optionalKey` is correct for external API responses where the key itself may be absent from the payload (Google API, R2 metadata). LLM output is different — we control the schema, and forcing all keys to be present is better.

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

### Prompt Should Match Schema

The extraction prompt needs updating to match the expanded schema. Current prompt:
```
Determine whether the following markdown is an invoice and extract only the total if present.
```

New prompt should instruct the LLM to populate all fields, use null for missing data, keep amounts as strings with original formatting.

