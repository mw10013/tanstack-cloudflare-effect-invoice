# Input Trimming Research

## Problem

Domain schemas (`OrganizationDomain.ts`) should enforce shape constraints (max length) but not mutate data. Trimming is input normalization — it belongs at the application input boundaries, not in domain objects or the database layer.

Two input boundaries need trimming:

1. **Web forms** — user edits invoice fields, submits to DO via `stub.updateInvoice()`
2. **AI extraction** — Gemini returns JSON decoded through `InvoiceExtractionSchema`, saved via `agent.saveExtraction()`

## Current State

Domain schemas use `maxLength(n)` — validation only, no trim.

```ts
// src/lib/OrganizationDomain.ts
const maxLength = (max: number) => Schema.String.check(Schema.isMaxLength(max));
```

Neither input boundary trims today.

## Input Boundary 1: Web Forms

### Current flow

```
User types in field → React state (useState) → saveMutation → stub.updateInvoice()
```

- `src/routes/app.$organizationId.invoices.$invoiceId.tsx`
- Form uses raw `useState` with `TextField` / `TextAreaField` components
- No TanStack Form, no validation, no normalization
- `saveMutation.mutate(form)` sends raw state directly to the DO

### Where to trim

**Option A: Trim in the mutation function (before RPC call)**

Trim all string fields in `saveMutation.mutationFn` before calling `stub.updateInvoice()`. One place, catches everything.

```tsx
// In saveMutation.mutationFn
const trimmed = {
  ...data,
  name: data.name.trim(),
  invoiceNumber: data.invoiceNumber.trim(),
  // ... all string fields
  invoiceItems: data.invoiceItems.map(({ clientId: _, ...rest }) => ({
    description: rest.description.trim(),
    quantity: rest.quantity.trim(),
    unitPrice: rest.unitPrice.trim(),
    amount: rest.amount.trim(),
    period: rest.period.trim(),
  })),
};
stub.updateInvoice(trimmed);
```

Trade-off: manual field list, easy to miss new fields. Could use a generic string-trimming utility.

**Option B: Trim via Effect Schema decode at the boundary**

Define a trim+maxLength transform schema used only at the boundary — not in domain schemas. Decode through it in the mutation or in `updateInvoice` on the DO.

```ts
// src/lib/InputSchemas.ts (or inline)
const trimMax = (max: number) =>
  Schema.String.pipe(Schema.decode(SchemaTransformation.trim()))
    .check(Schema.isMaxLength(max));

const UpdateInvoiceInput = Schema.Struct({
  invoiceId: Schema.String,
  name: trimMax(500),
  invoiceNumber: trimMax(100),
  // ...
  invoiceItems: Schema.Array(Schema.Struct({
    description: trimMax(2000),
    // ...
  })),
});
```

Decode in `saveMutation.mutationFn`:

```ts
mutationFn: (data: InvoiceFormValues) => {
  const decoded = Schema.decodeUnknownSync(UpdateInvoiceInput)({
    invoiceId,
    ...data,
    invoiceItems: data.invoiceItems.map(({ clientId: _, ...rest }) => rest),
  });
  return stub.updateInvoice(decoded);
}
```

Trade-off: schema duplication (input schema mirrors domain schema + trim), but trim is explicit at the boundary. Decode validates + trims in one step.

**Option C: Trim on blur in form components**

Add `onBlur` trim to `TextField` / `TextAreaField`:

```tsx
function TextField({ label, value, disabled, onChange }: { ... }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const trimmed = e.target.value.trim();
          if (trimmed !== value) onChange(trimmed);
        }}
      />
    </Field>
  );
}
```

Trade-off: gives user visual feedback (trimmed text on blur), but doesn't protect the submit path if blur is skipped (e.g. programmatic submit, paste-and-click-save).

**Option D: Trim in the DO `updateInvoice` method**

Trim in `OrganizationAgent.updateInvoice()` before passing to the repository:

```ts
@callable()
updateInvoice(input: { ... }) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const trimmedInput = trimAllStrings(input);
      const repo = yield* OrganizationRepository;
      // ...
    }),
  );
}
```

Trade-off: catches all callers (form, future API), but the DO is closer to domain/persistence than "input boundary". However, the `@callable()` RPC methods are effectively the API boundary for the client.

### Recommendation

**Option C + D (belt and suspenders).** Trim on blur for UX. Trim in the DO `updateInvoice` for safety — it's the actual API boundary for the client. A generic `trimStrings` utility handles both without manual field lists.

If TanStack Form is adopted later, Option B becomes natural (decode through a trim schema in `onSubmit`).

### Generic trim utility

```ts
const trimStrings = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      [k, typeof v === "string" ? v.trim() : v]
    ),
  ) as T;
```

For nested structures (invoiceItems), apply recursively or explicitly:

```ts
const trimmedInput = {
  ...trimStrings(input),
  invoiceItems: input.invoiceItems.map(trimStrings),
};
```

## Input Boundary 2: AI Extraction

### Current flow

```
Gemini API → JSON text → Schema.decodeUnknownEffect(InvoiceExtractionSchema)(jsonText)
  → { invoiceItems, ...extracted } → agent.saveExtraction()
```

- `src/lib/InvoiceExtraction.ts:142` — decodes Gemini response through `InvoiceExtractionSchema`
- `InvoiceExtractionSchema` spreads `InvoiceExtractionFields.fields` and `InvoiceItemFields.fields` from domain schemas
- Domain schemas now only check maxLength, no trim

### Where to trim

**Option A: Trim in `InvoiceExtractionSchema` (extraction-specific schema)**

`InvoiceExtraction.ts` already defines its own `InvoiceExtractionSchema`. Instead of spreading bare domain fields, use trim+maxLength fields for the extraction schema only:

```ts
// src/lib/InvoiceExtraction.ts
const trimMax = (max: number) =>
  Schema.String.pipe(Schema.decode(SchemaTransformation.trim()))
    .check(Schema.isMaxLength(max));

const InvoiceExtractionSchema = Schema.Struct({
  invoiceConfidence: Schema.Number,
  invoiceNumber: trimMax(100),
  invoiceDate: trimMax(50),
  // ... all fields with trim
  invoiceItems: Schema.Array(Schema.Struct({
    description: trimMax(2000),
    // ...
  })),
});
```

Trade-off: duplicates field definitions (doesn't spread domain fields). But the extraction schema IS the input boundary — it's where external AI data enters the system. Trim belongs here.

**Option B: Derive trimming schema from domain fields**

Build a utility that takes a `Schema.Struct` and wraps each `String` field with trim:

```ts
const withTrim = <F extends Schema.Struct.Fields>(
  struct: Schema.Struct<F>
): Schema.Struct</* mapped type */> => { ... }

const InvoiceExtractionSchema = withTrim(Schema.Struct({
  ...InvoiceExtractionFields.fields,
  invoiceItems: Schema.Array(withTrim(InvoiceItemFields)),
}));
```

Trade-off: complex mapped types, may not compose well with Effect Schema internals.

**Option C: Trim after decode (post-processing)**

Decode through the domain schema (maxLength only), then trim all strings on the result:

```ts
const extractionResult = yield* Schema.decodeUnknownEffect(
  Schema.fromJsonString(InvoiceExtractionSchema)
)(candidates[0].content.parts[0].text);

const trimmed = {
  ...trimStrings(extractionResult),
  invoiceItems: extractionResult.invoiceItems.map(trimStrings),
};
```

Trade-off: maxLength check runs on untrimmed strings — a string like `"  USD  "` (7 chars) passes `maxLength(10)` but the trimmed value is 3 chars. This is fine for our limits (generous). The domain schema catches truly oversized values.

**Option D: Trim in `agent.saveExtraction()`**

Same as web form Option D — trim in the DO method that receives extraction data:

```ts
saveExtraction(input: { ..., extracted: ..., invoiceItems: ... }) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      const trimmedExtracted = trimStrings(input.extracted);
      const trimmedItems = input.invoiceItems.map(trimStrings);
      // ...
    }),
  );
}
```

### Recommendation

**Option A or C.** The extraction schema is a clear input boundary. Option A is cleanest — the extraction module defines its own trim schema, domain schemas stay pure. If we want to avoid field duplication, Option C (trim after decode) with the `trimStrings` utility is simpler.

**Option D also works** as a safety net if we want `saveExtraction` to mirror `updateInvoice` behavior.

## Summary

| Boundary | Trim location | Mechanism |
| --- | --- | --- |
| Web form (UX) | `TextField.onBlur` | `value.trim()` in component |
| Web form (safety) | `OrganizationAgent.updateInvoice` | `trimStrings()` utility |
| AI extraction | `InvoiceExtraction.ts` decode or post-decode | Trim schema or `trimStrings()` |
| AI extraction (safety) | `OrganizationAgent.saveExtraction` | `trimStrings()` utility |

Domain schemas (`OrganizationDomain.ts`) enforce `maxLength` only. Trim is the caller's responsibility.

## Next Steps

- [ ] Choose trim approach for web forms (Option C+D recommended)
- [ ] Choose trim approach for AI extraction (Option A or C+D)
- [ ] Implement `trimStrings` utility if going with post-decode trimming
- [ ] Add `onBlur` trim to `TextField` / `TextAreaField` components
- [ ] Add trim to `OrganizationAgent.updateInvoice` and `saveExtraction`
- [ ] Consider: when TanStack Form is adopted, move to decode-based trim in `onSubmit`
