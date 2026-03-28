# Text Length Constraints Research

## Problem

The Invoice and InvoiceItem SQLite schemas have no length constraints on text columns.
Data flows in from two external sources:

1. **User upload** — filenames, content types via `uploadInvoice` callable
2. **AI extraction** — all InvoiceExtractionFields and InvoiceItemFields from the extraction workflow

Unbounded text can break UI rendering, waste storage in per-DObject SQLite, and mask upstream bugs.

## Effect v4 Schema Patterns for Length Constraints

### API surface

```ts
import * as Schema from "effect/Schema";

// Built-in filters — used with .check()
Schema.isMinLength(n); // length >= n
Schema.isMaxLength(n); // length <= n
Schema.isLengthBetween(min, max); // min <= length <= max
Schema.isNonEmpty(); // length >= 1 (shorthand for isMinLength(1))
Schema.isTrimmed(); // s.trim() === s

// Built-in constrained types
Schema.NonEmptyString; // String.check(isNonEmpty())
Schema.Trimmed; // String.check(isTrimmed())
Schema.Char; // String.check(isLengthBetween(1, 1))

// Composing checks — multiple filters in one .check() call
const Email = Schema.String.check(Schema.isMaxLength(254), Schema.isTrimmed());

// Branded types for domain clarity
const Currency = Schema.String.check(Schema.isLengthBetween(3, 10)).pipe(
  Schema.brand("Currency"),
);

// Custom error messages
const VendorName = Schema.String.check(
  Schema.isMaxLength(500, {
    message: "Vendor name must be 500 characters or fewer",
  }),
);

// Short-circuit with .abort() — skip remaining checks on first failure
const Id = Schema.String.check(
  Schema.isLengthBetween(1, 36).abort(),
  Schema.isTrimmed(),
);

// Trim + length check combined
const TrimmedBounded = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
);
```

### Key files

| Location                                           | Content                       |
| -------------------------------------------------- | ----------------------------- |
| `refs/effect4/packages/effect/src/Schema.ts:6323`  | `isMinLength`                 |
| `refs/effect4/packages/effect/src/Schema.ts:6386`  | `isMaxLength`                 |
| `refs/effect4/packages/effect/src/Schema.ts:6428`  | `isLengthBetween`             |
| `refs/effect4/packages/effect/src/Schema.ts:6364`  | `isNonEmpty`                  |
| `refs/effect4/packages/effect/src/Schema.ts:4922`  | `isTrimmed`                   |
| `refs/effect4/packages/effect/src/Schema.ts:4881`  | `makeFilter` (custom filters) |
| `refs/effect4/packages/effect/SCHEMA.md:136-152`   | String check examples         |
| `refs/effect4/packages/effect/SCHEMA.md:2279-2524` | Filter/validation patterns    |
| `refs/effect4/packages/effect/SCHEMA.md:2485-2497` | Branding patterns             |

## Current DB Schema (src/organization-agent.ts:95-132)

### Invoice table

```sql
create table if not exists Invoice (
  id text primary key,
  name text not null default '',
  fileName text not null default '',
  contentType text not null default '',
  createdAt integer not null default (unixepoch() * 1000),
  r2ActionTime integer,
  idempotencyKey text unique,
  r2ObjectKey text not null default '',
  status text not null,
  invoiceConfidence real not null default 0,
  invoiceNumber text not null default '',
  invoiceDate text not null default '',
  dueDate text not null default '',
  currency text not null default '',
  vendorName text not null default '',
  vendorEmail text not null default '',
  vendorAddress text not null default '',
  billToName text not null default '',
  billToEmail text not null default '',
  billToAddress text not null default '',
  subtotal text not null default '',
  tax text not null default '',
  total text not null default '',
  amountDue text not null default '',
  extractedJson text,
  error text
);
```

### InvoiceItem table

```sql
create table if not exists InvoiceItem (
  id text primary key,
  invoiceId text not null references Invoice(id) on delete cascade,
  "order" real not null,
  description text not null default '',
  quantity text not null default '',
  unitPrice text not null default '',
  amount text not null default '',
  period text not null default ''
);
```

## Current Domain Schemas (src/lib/OrganizationDomain.ts)

```ts
export const InvoiceExtractionFields = Schema.Struct({
  invoiceConfidence: Schema.Number,
  invoiceNumber: Schema.String,
  invoiceDate: Schema.String,
  dueDate: Schema.String,
  currency: Schema.String,
  vendorName: Schema.String,
  vendorEmail: Schema.String,
  vendorAddress: Schema.String,
  billToName: Schema.String,
  billToEmail: Schema.String,
  billToAddress: Schema.String,
  subtotal: Schema.String,
  tax: Schema.String,
  total: Schema.String,
  amountDue: Schema.String,
});

export const InvoiceItemFields = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
});
```

All fields are bare `Schema.String` with no constraints.

## Proposed Domain Schema Changes

Two viable approaches. Both keep length rules in one place.
Code-controlled columns (`id`, `status`, `r2ObjectKey`, `idempotencyKey`) left unconstrained per decision #1.

### Option A: Single schema (trim + length everywhere)

Use `SchemaTransformation.trim()` + `isMaxLength()` on all text fields.
This is the simplest and ensures all decoded values are normalized.

Reusable helper:

```ts
import { SchemaTransformation } from "effect/Schema"

const trimmed = (max: number) =>
  Schema.String.pipe(Schema.decode(SchemaTransformation.trim()))
    .check(Schema.isMaxLength(max))
```

### InvoiceExtractionFields (OrganizationDomain.ts)

```ts
export const InvoiceExtractionFields = Schema.Struct({
  invoiceConfidence: Schema.Number,
  invoiceNumber: trimmed(100),
  invoiceDate: trimmed(50),
  dueDate: trimmed(50),
  currency: trimmed(10),
  vendorName: trimmed(500),
  vendorEmail: trimmed(254),
  vendorAddress: trimmed(2000),
  billToName: trimmed(500),
  billToEmail: trimmed(254),
  billToAddress: trimmed(2000),
  subtotal: trimmed(50),
  tax: trimmed(50),
  total: trimmed(50),
  amountDue: trimmed(50),
})
```

### InvoiceItemFields (OrganizationDomain.ts)

```ts
export const InvoiceItemFields = Schema.Struct({
  description: trimmed(2000),
  quantity: trimmed(50),
  unitPrice: trimmed(50),
  amount: trimmed(50),
  period: trimmed(50),
})
```

### Invoice struct — fields that need constraints

```ts
export const Invoice = Schema.Struct({
  id: Schema.String,
  name: trimmed(500),
  fileName: trimmed(500),
  contentType: trimmed(100),
  createdAt: Schema.Number,
  r2ActionTime: Schema.NullOr(Schema.Number),
  idempotencyKey: Schema.NullOr(Schema.String),
  r2ObjectKey: Schema.String,
  status: InvoiceStatus,
  ...InvoiceExtractionFields.fields,
  extractedJson: Schema.NullOr(trimmed(100_000)),
  error: Schema.NullOr(trimmed(10_000)),
})
```

### Option B: Split input vs DB schemas (trim on input only)

Trim is decode-only and encode passthrough in Effect v4. That means `decode` applies `trim`, `encode` does not.
Grounding:

- `Schema.decode(SchemaTransformation.trim())` applies trim on decode: `refs/effect4/packages/effect/SCHEMA.md:2935-2941`
- `trim` is decode-only (`Getter.trim()` with `Getter.passthrough()` for encode): `refs/effect4/packages/effect/SCHEMA.md:2967-2973`

Minimal split example:

```ts
const bounded = (max: number) =>
  Schema.String.check(Schema.isMaxLength(max))

const boundedTrimmed = (max: number) =>
  Schema.String.pipe(Schema.decode(SchemaTransformation.trim()))
    .check(Schema.isMaxLength(max))

const makeInvoiceFields = (text: (max: number) => Schema.Schema<string>) =>
  Schema.Struct({
    invoiceNumber: text(100),
    vendorName: text(500),
    vendorEmail: text(254),
  })

export const InvoiceFieldsInput = makeInvoiceFields(boundedTrimmed)
export const InvoiceFieldsDb = makeInvoiceFields(bounded)
```

### Trade-offs

| Approach | Pros | Cons |
| --- | --- | --- |
| Single schema | Simplest usage; one export to wire everywhere | Trim runs on every decode; masks untrimmed DB values; small extra allocations |
| Split schemas | Trim only at boundaries; DB reads stay exact and cheaper | More exports; need to pick the right schema per call site |

### Recommendation

If you already have clear input boundaries (extraction, UI, API), use **Option B**. The builder keeps constraints in one place, and DB reads avoid trim overhead.
If you want the fewest moving parts, **Option A** is fine — trim cost is small compared to SQLite IO.

### SQLite DDL — CHECK constraints

```sql
-- Add to Invoice table DDL
check(length(name) <= 500),
check(length(fileName) <= 500),
check(length(contentType) <= 100),
check(length(invoiceNumber) <= 100),
check(length(invoiceDate) <= 50),
check(length(dueDate) <= 50),
check(length(currency) <= 10),
check(length(vendorName) <= 500),
check(length(vendorEmail) <= 254),
check(length(vendorAddress) <= 2000),
check(length(billToName) <= 500),
check(length(billToEmail) <= 254),
check(length(billToAddress) <= 2000),
check(length(subtotal) <= 50),
check(length(tax) <= 50),
check(length(total) <= 50),
check(length(amountDue) <= 50),
check(length(extractedJson) <= 100000),
check(length(error) <= 10000)

-- Add to InvoiceItem table DDL
check(length(description) <= 2000),
check(length(quantity) <= 50),
check(length(unitPrice) <= 50),
check(length(amount) <= 50),
check(length(period) <= 50)
```

## Proposed Constraints

### Rationale per field

| Column           | Source                  | Proposed Limit | Why                                                          |
| ---------------- | ----------------------- | -------------- | ------------------------------------------------------------ |
| `id`             | code (UUID v4)          | 36             | Always UUID format. DB check optional since code-controlled. |
| `name`           | derived from fileName   | 500            | Truncated fileName. Same bound as fileName.                  |
| `fileName`       | user upload             | 500            | Most OS limits are 255 chars. 500 is generous for UTF-8.     |
| `contentType`    | user upload (validated) | 100            | Longest common MIME type is ~40 chars. 100 is generous.      |
| `idempotencyKey` | code (UUID)             | 36             | Always UUID.                                                 |
| `r2ObjectKey`    | code                    | 200            | Format: `{orgId}/invoices/{uuid}`. Bounded by construction.  |
| `status`         | code (enum)             | 20             | Longest value is "extracting" (10 chars).                    |
| `invoiceNumber`  | extraction (AI)         | 100            | Invoice numbers vary but rarely exceed 50 chars.             |
| `invoiceDate`    | extraction (AI)         | 50             | ISO 8601 date is 10 chars, with timezone ~25.                |
| `dueDate`        | extraction (AI)         | 50             | Same as invoiceDate.                                         |
| `currency`       | extraction (AI)         | 10             | ISO 4217 is 3 chars. 10 allows display names.                |
| `vendorName`     | extraction (AI)         | 500            | Company names, generous limit.                               |
| `vendorEmail`    | extraction (AI)         | 254            | RFC 5321 max email length.                                   |
| `vendorAddress`  | extraction (AI)         | 2000           | Multi-line address, can be verbose.                          |
| `billToName`     | extraction (AI)         | 500            | Same as vendorName.                                          |
| `billToEmail`    | extraction (AI)         | 254            | Same as vendorEmail.                                         |
| `billToAddress`  | extraction (AI)         | 2000           | Same as vendorAddress.                                       |
| `subtotal`       | extraction (AI)         | 50             | Numeric string like "1,234,567.89".                          |
| `tax`            | extraction (AI)         | 50             | Same as subtotal.                                            |
| `total`          | extraction (AI)         | 50             | Same as subtotal.                                            |
| `amountDue`      | extraction (AI)         | 50             | Same as subtotal.                                            |
| `extractedJson`  | code (serialized)       | 100000         | Full extraction payload.                                     |
| `error`          | code                    | 10000          | Error messages. Generous but bounded.                        |
| `description`    | extraction (AI)         | 2000           | Line item descriptions can be lengthy.                       |
| `quantity`       | extraction (AI)         | 50             | Numeric string.                                              |
| `unitPrice`      | extraction (AI)         | 50             | Numeric string.                                              |
| `amount`         | extraction (AI)         | 50             | Numeric string.                                              |
| `period`         | extraction (AI)         | 50             | Date range strings.                                          |

### No constraint needed

| Column             | Why                                                      |
| ------------------ | -------------------------------------------------------- |
| `id` (both tables) | Code-controlled UUIDs. Harmless to add but not critical. |
| `status`           | Code-controlled enum.                                    |
| `idempotencyKey`   | Code-controlled UUID.                                    |
| `r2ObjectKey`      | Code-constructed.                                        |

## Decisions

1. **Code-controlled columns** (`id`, `status`, `r2ObjectKey`, `idempotencyKey`): Skip constraints. No DB CHECK, no Effect Schema checks.

2. **`extractedJson`**: Cap at 100KB.

3. **Trimming strategy**: Transform at input boundaries. DB read strategy is open (single vs split), see trade-offs below.

   **Background:** `Schema.Trimmed` is a check — it rejects untrimmed strings with an error, does not modify them. `Schema.decode(SchemaTransformation.trim())` is a transform — it always trims, never errors about whitespace.

4. **Branded types**: No brands for now.

5. **Date format validation**: Defer.

## Next Steps

- [ ] Choose Option A (single schema) or Option B (split input vs DB schemas)
- [ ] Add `trimmed()` helper and constrained fields to `OrganizationDomain.ts`
- [ ] Add CHECK constraints to SQLite DDL in `organization-agent.ts`
- [ ] Ensure extraction workflow decodes/validates through the constrained schemas
- [ ] Verify UI form validation surfaces constraint violations before DB write
