# trimFields Simplification

## Problem

`trimFields` in `SchemaEx.ts` is both too low-level (`Object.fromEntries`/`Object.entries`) and too clever (runtime `isStringSchema` type guard to pass non-strings through unchanged). It hides what's actually happening.

## Current Implementation

```ts
// SchemaEx.ts:10-13
export const trimFields = <F extends Record<string, Schema.Top>>(fields: F) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, isStringSchema(v) ? v.pipe(Schema.decode(SchemaTransformation.trim())) : v]),
  ) as F;
```

Accepts mixed string/non-string fields, silently skips non-strings.

## Call Sites Analysis

### 1. InvoiceItemFormSchema (OrganizationDomain.ts:63-72) — ALL STRING

```ts
trimFields(Struct.pick(InvoiceItem.fields, ["description", "quantity", "unitPrice", "amount", "period"]))
```

All picked fields are `Schema.String.check(...)`. No non-string fields. **No change needed at call site.**

### 2. InvoiceFormSchema (OrganizationDomain.ts:76-93) — ALL STRING

```ts
trimFields(Struct.pick(Invoice.fields, ["name", "invoiceNumber", "invoiceDate", "dueDate", "currency", "vendorName", "vendorEmail", "vendorAddress", "billToName", "billToEmail", "billToAddress", "subtotal", "tax", "total", "amountDue"]))
```

All picked fields are `Schema.String.check(...)`. **No change needed at call site.**

### 3. InvoiceItemExtractionSchema (InvoiceExtraction.ts:13-22) — ALL STRING

Same fields as #1. **No change needed.**

### 4. InvoiceExtractionSchema (InvoiceExtraction.ts:25-45) — HAS `invoiceConfidence: Schema.Number`

```ts
...trimFields(Struct.pick(Invoice.fields, [
  "invoiceConfidence",  // <-- Schema.Number, not string
  "invoiceNumber", "invoiceDate", "dueDate", "currency",
  "vendorName", "vendorEmail", "vendorAddress",
  "billToName", "billToEmail", "billToAddress",
  "subtotal", "tax", "total", "amountDue",
])),
```

**Only call site that actually mingles string and non-string.** Fix: pull `invoiceConfidence` out of the `trimFields` call.

## Proposed Changes

### SchemaEx.ts — simplify `trimFields` to string-only

```ts
// accepts only string schema fields, applies trim to each
export const trimFields = <F extends Record<string, Schema.Schema<string>>>(fields: F) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v.pipe(Schema.decode(SchemaTransformation.trim()))]),
  ) as F;
```

- Drop `isStringSchema` guard entirely
- Constrain `F` to `Record<string, Schema.Schema<string>>` instead of `Schema.Top`
- Every field unconditionally gets trim

### InvoiceExtraction.ts — separate invoiceConfidence

```ts
export const InvoiceExtractionSchema = Schema.Struct({
  invoiceConfidence: Invoice.fields.invoiceConfidence,
  ...trimFields(
    Struct.pick(Invoice.fields, [
      "invoiceNumber", "invoiceDate", "dueDate", "currency",
      "vendorName", "vendorEmail", "vendorAddress",
      "billToName", "billToEmail", "billToAddress",
      "subtotal", "tax", "total", "amountDue",
    ]),
  ),
  invoiceItems: Schema.Array(InvoiceItemExtractionSchema),
});
```

### OrganizationDomain.ts — no changes needed

All call sites already pass only string fields.

## Why `Schema.Struct.mapFields` doesn't apply here

`trimFields` receives `.fields` — a plain object like `{ description: Schema.String.check(...), ... }`.
This is *not* a `Schema.Struct` instance, so `schema.mapFields(fn)` can't be used.
We're building the fields record *before* passing it into `Schema.Struct(...)`.

`Struct.map` from the Struct utility module *does* work — it operates on any plain object.

## Option A: `Struct.map` with Lambda

Replace `Object.fromEntries`/`Object.entries` with `Struct.map`:

```ts
import * as Struct from "effect/Struct";
import { Schema, SchemaTransformation } from "effect";

interface TrimStringSchema extends Struct.Lambda {
  readonly "~lambda.out": this["~lambda.in"];
}

const trimStringSchema = Struct.lambda<TrimStringSchema>(
  (s: Schema.Schema<string>) => s.pipe(Schema.decode(SchemaTransformation.trim()))
);

export const trimFields = <F extends Record<string, Schema.Schema<string>>>(fields: F) =>
  Struct.map(fields, trimStringSchema);
```

Benefit: no `Object.fromEntries`/`Object.entries`, no `as F` cast.
Risk: the Lambda `~lambda.out: this["~lambda.in"]` says "output type = input type" — need to verify that `Schema.decode(trim())` preserves the schema type (it adds a decode layer, which may change the type signature). If it doesn't preserve the type, we'd need a more specific `~lambda.out`.

## Option B: keep `Object.fromEntries` but simplify constraint

Minimal change — just drop the `isStringSchema` guard and tighten the generic:

```ts
export const trimFields = <F extends Record<string, Schema.Schema<string>>>(fields: F) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v.pipe(Schema.decode(SchemaTransformation.trim()))]),
  ) as F;
```

Still has `as F` cast and `fromEntries`, but removes the cleverness. Straightforward.

## Recommendation

Try Option A first. If the Lambda types don't line up, fall back to Option B.
Either way, the call site change is the same: pull `invoiceConfidence` out of `trimFields` in `InvoiceExtraction.ts`.
