# Effect v4 Testing — Research for Integration Test Conversion

## Goal

Convert `test/integration/login.test.ts` and its `test-utils.ts` helpers to idiomatic Effect v4, using `@effect/vitest`.

---

## Current Test Structure

### login.test.ts

Two tests:
1. **Renders /login** — `exports.default.fetch(url)` → assert status 200 + body content
2. **Login flow** — `resetDb()` → `runServerFn(login, data)` → fetch verify URL → extract session cookie → fetch authenticated route → assert

### test-utils.ts

| Helper | What it does |
|---|---|
| `resetDb()` | Batch-deletes rows from D1 tables via `env.D1` |
| `runServerFn()` | Calls a TanStack server fn via `createClientRpc` + `exports.default.fetch` |
| `extractSessionCookie()` | Parses `Set-Cookie` header for `better-auth.session_token` |
| `parseSetCookie()` | Generic cookie string → Record parser |
| `getSetCookie()` | Extracts raw `Set-Cookie` header from Response |

---

## @effect/vitest API

Source: `refs/effect4/packages/vitest/`

### Core imports

```ts
import { it, describe, assert, layer } from "@effect/vitest"
```

### Test runners

| Runner | Provides | Use when |
|---|---|---|
| `it.effect` | `TestClock`, `TestConsole`, `Scope` | Most tests — deterministic time |
| `it.live` | Real clock, real console, `Scope` | Need actual time/logging |
| `it.scoped` | `TestClock`, `TestConsole`, `Scope` | Managing `acquireRelease` resources |
| `it.scopedLive` | Real clock, `Scope` | Scoped + real time |

### Shared layers via `layer()`

```ts
layer(MyService.layerTest)("suite name", (it) => {
  it.effect("test", () =>
    Effect.gen(function*() {
      const svc = yield* MyService
    }))
})
```

- Layer built once in `beforeAll`, torn down in `afterAll`
- All tests share the same layer instance
- Nested: `it.layer(AnotherLayer)("nested", (it) => { ... })`

### Assertions

`assert` from `@effect/vitest` wraps vitest `expect`:

```ts
assert.strictEqual(actual, expected)
assert.deepStrictEqual(actual, expected)
assert.isTrue(value)
```

Standard `expect()` also works inside `it.effect`.

---

## Conversion Plan

### TestUtils.ts — Effect v4 Services

Each helper becomes an Effect or a method on a service. Since these helpers depend on Cloudflare bindings (`env.D1`, `exports.default`), they fit naturally as Effects that access those bindings.

#### Option A: Standalone Effects (simpler)

```ts
import { Effect } from "effect"
import { env, exports } from "cloudflare:workers"

const resetDb = Effect.gen(function*() {
  yield* Effect.promise(() =>
    env.D1.batch([
      ...["Session", "Member", "Invitation", "Verification", "Organization"]
        .map((t) => env.D1.prepare(`delete from ${t}`)),
      env.D1.prepare(`delete from Account where id <> 'admin'`),
      env.D1.prepare(`delete from User where id <> 'admin'`),
    ])
  )
})

const fetchWorker = (url: string, init?: RequestInit) =>
  Effect.promise(() => exports.default.fetch(new Request(new URL(url, "http://example.com"), init)))

const runServerFn = <TInputValidator, TResponse>(
  serverFn: ServerFn<TInputValidator, TResponse>,
  data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"],
) => Effect.gen(function*() {
  // ... wrap existing logic in Effect.promise / Effect.try
})

const extractSessionCookie = (response: Response) =>
  Effect.gen(function*() {
    const header = response.headers.get("Set-Cookie")
    if (!header) return yield* Effect.fail(new Error("Expected Set-Cookie header"))
    const match = header.match(/better-auth\.session_token=([^;]+)/)
    if (!match) return yield* Effect.fail(new Error(`Missing session cookie: ${header}`))
    return `better-auth.session_token=${match[1]}`
  })
```

#### Option B: Service with Layer (if shared state or lifecycle needed)

```ts
import { Effect, Layer, ServiceMap } from "effect"

class TestHelpers extends ServiceMap.Service<TestHelpers, {
  readonly resetDb: Effect.Effect<void>
  runServerFn<TInputValidator, TResponse>(
    serverFn: ServerFn<TInputValidator, TResponse>,
    data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"],
  ): Effect.Effect<Awaited<TResponse>>
  readonly extractSessionCookie: (response: Response) => Effect.Effect<string>
  readonly fetchWorker: (url: string, init?: RequestInit) => Effect.Effect<Response>
}>()("test/TestHelpers") {
  static readonly layer = Layer.succeed(TestHelpers)({
    resetDb: /* ... */,
    runServerFn: /* ... */,
    extractSessionCookie: /* ... */,
    fetchWorker: /* ... */,
  })
}
```

**Recommendation**: Option A (standalone Effects) unless we later need to swap implementations or share lifecycle. The helpers are stateless and always use real Cloudflare bindings.

### login.test.ts — Converted

```ts
import { describe } from "@effect/vitest"
import { it, layer } from "@effect/vitest"
import { Effect } from "effect"
import { exports } from "cloudflare:workers"
import { login } from "@/lib/Login"
import { extractSessionCookie, fetchWorker, resetDb, runServerFn } from "../TestUtils"

describe("integration smoke", () => {
  it.live("renders /login", () =>
    Effect.gen(function*() {
      const response = yield* fetchWorker("http://example.com/login")
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("Sign in / Sign up")
    }))

  it.live("login → verify magic link → access authenticated route", () =>
    Effect.gen(function*() {
      yield* resetDb
      const result = yield* runServerFn(login, { email: "u@u.com" })
      expect(result.success).toBe(true)
      expect(result.magicLink).toContain("/api/auth/magic-link/verify")

      const verifyResponse = yield* fetchWorker(result.magicLink ?? "", { redirect: "manual" })
      expect(verifyResponse.status).toBe(302)
      expect(new URL(verifyResponse.headers.get("location") ?? "").pathname).toBe("/magic-link")

      const sessionCookie = yield* extractSessionCookie(verifyResponse)
      expect(sessionCookie).toContain("better-auth.session_token=")

      const appResponse = yield* fetchWorker(
        new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink).toString(),
        { headers: { Cookie: sessionCookie } },
      )
      expect(appResponse.status).toBe(200)
      expect(new URL(appResponse.url).pathname).toMatch(/^\/app\/.+/)
      expect(yield* Effect.promise(() => appResponse.text())).toContain("Members")
    }))
})
```

**Why `it.live`**: These are integration tests hitting real Cloudflare worker fetch — no simulated time needed.

---

## Key Patterns from Effect v4 Tests

### Effect.gen + yield* is the core idiom

Every test body is `Effect.gen(function*() { ... })`. Use `yield*` to unwrap Effects.

### Error handling: Effect.fail vs throw

Idiomatic Effect uses `Effect.fail(error)` instead of `throw`. Cookie extraction errors become typed failures.

### Effect.promise for async interop

Wrap any `Promise<T>` with `Effect.promise(() => somePromise)`. This is how we bridge `exports.default.fetch`, `env.D1.batch`, etc.

### Effect.fn for named operations (optional)

```ts
const resetDb = Effect.fn("resetDb")(function*() {
  // traced operation
})
```

Adds tracing spans. Optional but useful for debugging.

### Layer sharing for expensive setup

If we later have expensive per-suite setup (e.g., seeding a database), use `layer(...)` to share it:

```ts
layer(DatabaseSeed.layer)("authenticated routes", (it) => {
  it.live("test 1", () => ...)
  it.live("test 2", () => ...)
})
```

---

## Files to Create/Modify

| File | Action |
|---|---|
| `test/TestUtils.ts` | New — Effect v4 versions of helpers |
| `test/integration/login.test.ts` | Rewrite — use `@effect/vitest` + `TestUtils.ts` |
| `test/test-utils.ts` | Keep — other tests may still use it |

---

## Open Questions

1. **`runServerFn` wrapping** — The `runWithStartContext` + `createClientRpc` dance is gnarly. Worth wrapping in `Effect.promise` as a black box, or decomposing into smaller Effects?
2. **Error types** — Should cookie extraction / fetch failures use custom tagged errors (`class SessionCookieError extends Data.TaggedError(...)`) or plain `Error`?
3. **`@effect/vitest` compatibility** — Confirm it works in the vitest cloudflare pool environment (the `cloudflare:workers` imports suggest a custom pool).
