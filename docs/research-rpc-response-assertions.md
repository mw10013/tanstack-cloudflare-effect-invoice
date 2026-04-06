# RPCResponse Assertion Helpers

Research on refactoring `assertSuccess`/`assertFailure` in `test/TestUtils.ts` from effect v4's `Result`-based pattern to Cloudflare Agent `RPCResponse`-based assertions.

## Current state

`test/TestUtils.ts:213-232` has `assertSuccess` and `assertFailure` copied from `refs/effect4/packages/vitest/src/utils.ts:243-263`. They operate on `Result.Result<A, E>` — an effect v4 type that has nothing to do with `RPCResponse`.

```ts
// refs/effect4/packages/vitest/src/utils.ts:243-249
export function assertSuccess<A, E>(
  result: Result.Result<A, E>,
  expected: A,
  ..._: Array<never>
): asserts result is Result.Success<A, never> {
  deepStrictEqual(result, Result.succeed(expected))
}
```

These are unused in the test suite today.

## RPCResponse type

```ts
// refs/agents/packages/agents/src/index.ts:86-104
export type RPCResponse = {
  type: MessageType.RPC;
  id: string;
} & (
  | { success: true;  result: unknown; done?: false }  // streaming chunk
  | { success: true;  result: unknown; done: true }    // final result
  | { success: false; error: string }                  // error
);
```

Three-branch discriminated union on `success` + `done`. After `callAgentRpc` (which skips `done: false` chunks), callers only see two shapes:

| Shape | Meaning |
|-------|---------|
| `{ success: true, result: unknown, done: true }` | Final result |
| `{ success: false, error: string }` | Error |

## Design: narrow-only assertions

The effect v4 pattern bundles narrowing + value comparison (`deepStrictEqual(result, Result.succeed(expected))`). For RPCResponse, splitting these is better:

1. **Assertion narrows the discriminant** — confirms `success: true` or `success: false`, gives TypeScript the narrowed type.
2. **Caller checks the payload** — uses `response.result` (for success) or `response.error` (for failure) with whatever assertion fits (`strictEqual`, `deepStrictEqual`, `assertInclude`, Schema decode, etc.).

Why separate: `result` is `unknown` — callers almost always decode/validate it differently (Schema, manual field checks). Forcing an `expected` param at the assertion level would require callers to construct the full expected value upfront, which is awkward when they just want to check a field or decode into a domain type.

### Proposed API

Use `assertTrue`/`assertFalse` from `@effect/vitest/utils` — the same assertion style already used in the test suite (`test/integration/upload-invoice.test.ts:5`).

```ts
// refs/effect4/packages/vitest/src/utils.ts:97-98
export function assertTrue(self: unknown, message?: string, ..._: Array<never>): asserts self {
  strictEqual(self, true, message)
}
```

These use `node:assert.strictEqual` under the hood, consistent with effect v4's convention of wrapping `node:assert` rather than vitest's `expect`.

```ts
import { assertTrue, assertFalse } from "@effect/vitest/utils";

export function assertAgentRpcSuccess(
  response: RPCResponse,
): asserts response is RPCResponse & { success: true } {
  assertTrue(response.success, `RPC failed: ${"error" in response ? response.error : "unknown"}`);
}

export function assertAgentRpcFailure(
  response: RPCResponse,
): asserts response is RPCResponse & { success: false } {
  assertFalse(response.success);
}
```

No new types — uses inline `RPCResponse & { success: true }` and `RPCResponse & { success: false }` intersection in the `asserts` clause. TypeScript narrows the discriminated union the same way.

### Why `assertTrue`/`assertFalse` over `expect`

The test suite already imports from `@effect/vitest/utils` (`test/integration/upload-invoice.test.ts:5`). Effect v4's assertion utils wrap `node:assert` (`refs/effect4/packages/vitest/src/utils.ts:97-98`) — using them keeps the assertion style consistent across the codebase. `expect().toBe()` is vitest-native and works fine, but mixing two assertion styles in the same test utils file would be inconsistent.

### Usage at call site

```ts
import { assertInclude, deepStrictEqual } from "@effect/vitest/utils";

const response = yield* callAgentRpc(ws, "getInvoices");
assertAgentRpcSuccess(response);
// response is RPCResponse & { success: true } — response.result accessible, response.error not
const invoices = Schema.decodeUnknownSync(Schema.Array(Invoice))(response.result);
deepStrictEqual(invoices.length, 3);

const response2 = yield* callAgentRpc(ws, "badMethod");
assertAgentRpcFailure(response2);
// response2 is RPCResponse & { success: false } — response2.error is string
assertInclude(response2.error, "not found");
```

## Type narrowing mechanics

TypeScript's `asserts x is T` narrows the type in the calling scope after the function returns. If the assertion throws, execution stops, so the narrowed type is guaranteed correct in subsequent code.

```ts
// Before assertAgentRpcSuccess: response is RPCResponse (union of 3 branches)
//   response.result — type error (not on all branches)
//   response.error  — type error (not on all branches)

assertAgentRpcSuccess(response);

// After: response is RPCResponse & { success: true }
//   response.result — unknown (accessible)
//   response.done   — true | undefined (accessible)
//   response.error  — type error (not on success branches) ✓
```

## Recommendation

- Narrow-only, no `expected` param.
- Use `assertTrue`/`assertFalse` from `@effect/vitest/utils` for the internal check.
- Inline intersection types (`RPCResponse & { success: true }`) rather than new type aliases.
- Callers use effect v4 assertion utils (`deepStrictEqual`, `assertInclude`, etc.) on the narrowed payload.
