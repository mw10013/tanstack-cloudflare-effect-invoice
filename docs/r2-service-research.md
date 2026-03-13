# R2 Effect Service — Design

## Pattern

Follows D1.ts / KV.ts: `ServiceMap.Service` with `make` variant, `Schema.TaggedErrorClass`, `tryR2` helper with always-on retry via `Schedule.exponential("1 second").pipe(Schedule.jittered)`, `times: 2`.

## R2Bucket Methods (from `worker-configuration.d.ts`)

| Method | Signature | Returns |
|---|---|---|
| `head` | `(key: string)` | `Promise<R2Object \| null>` |
| `get` | `(key: string, options?: R2GetOptions)` | `Promise<R2ObjectBody \| null>` |
| `put` | `(key: string, value: ReadableStream \| ArrayBuffer \| ArrayBufferView \| string \| null \| Blob, options?: R2PutOptions)` | `Promise<R2Object>` |
| `delete` | `(keys: string \| string[])` | `Promise<void>` |
| `list` | `(options?: R2ListOptions)` | `Promise<R2Objects>` |

## Service API

| Method | Return in Effect | Notes |
|---|---|---|
| `head` | `Option<R2Object>` | null → Option |
| `get` | `Option<R2ObjectBody>` | null → Option |
| `put` | `R2Object` | Non-conditional overload |
| `delete` | `void` | Accepts `string \| string[]` |
| `list` | `R2Objects` | Returns as-is |

## Error & Retry

Code-based matching against R2's structured error format: `"put: ... (10012)"`.

```ts
const RETRYABLE_R2_CODES = [10001, 10043, 10054, 10058] as const;
```

| Code | S3 Code | HTTP | Signal |
|---|---|---|---|
| 10001 | InternalError | 500 | Internal error |
| 10043 | ServiceUnavailable | 503 | Temporarily unavailable |
| 10054 | ClientDisconnect | 400 | Client disconnected |
| 10058 | TooManyRequests | 429 | Rate limit (1 write/sec/key) |

Plus `"network connection lost"` substring match for Workers runtime failures.

All operations retry by default (like KV). Reads are safe; `delete` is idempotent; `put` overwrites so retrying a failed put with same key+value is safe.

## Deferred

**Multipart uploads** (`createMultipartUpload`, `resumeMultipartUpload`) — involves `R2MultipartUpload` lifecycle management (upload parts, abort, complete). Add when needed.

**Conditional operations** (`onlyIf` parameter on `get`/`put`) — enables optimistic concurrency control. `put` with `onlyIf: { etagMatches: "abc" }` only writes if the object hasn't changed since last read, preventing blind overwrites. `get` with `onlyIf: { etagDoesNotMatch: "abc" }` skips downloading the body if you already have the current version. These change return types (`put` returns `R2Object | null`, `get` returns `R2ObjectBody | R2Object | null`). Deferred because v1 use cases (file storage for invoices/images) don't need conflict detection — plain put-overwrites are fine.

## Infrastructure

- Binding name: `R2` (consistent with `D1`, `KV`)
- `wrangler.jsonc`: add `r2_buckets` binding
- `CloudflareEnv`: no changes needed; `R2` available via `yield* CloudflareEnv`
