# Auth Request Service Research

Question: should `src/lib/Auth.ts` depend on the `Request` service so `getSession` can read `request.headers` internally instead of accepting `headers` as an argument?

## Short Answer

Yes, technically viable.

But I would not make `Request` an implicit dependency of the entire `Auth` service just to simplify `getSession`.

Recommendation: keep the current explicit `getSession(headers)` shape, or add a second convenience helper like `getCurrentSession()` that reads `Request` internally while leaving the explicit helper available.

## Current Wiring

`src/lib/Request.ts` is a very small per-request service:

```ts
export const Request = ServiceMap.Service<globalThis.Request>("app/Request");
```

`src/worker.ts:92` creates the runtime per incoming request and installs both `Auth` and `Request` into that runtime:

```ts
const makeHttpRunEffect = (env: Env, request: Request) => {
  ...
  const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
  const requestLayer = Layer.succeedServices(
    ServiceMap.make(AppRequest, request),
  );
  const authRequestLayer = Layer.merge(authLayer, requestLayer);
```

So the request is already available anywhere inside server-side effects.

`src/lib/Auth.ts:47` currently keeps `getSession` explicit:

```ts
const getSession = Effect.fn("auth.getSession")(function* (headers: Headers) {
  return Option.fromNullishOr(
    yield* Effect.tryPromise(() => auth.api.getSession({ headers })),
  );
});
```

Callers usually do this pattern first:

```ts
const request = yield * Request;
const auth = yield * Auth;
const session = yield * auth.getSession(request.headers);
```

Examples:

- `src/routes/app.tsx:12`
- `src/routes/_mkt.tsx:17`
- `src/routes/magic-link.tsx:13`
- `src/routes/app.$organizationId.tsx:62`

## Better Auth Docs Pattern

Better Auth docs explicitly model server-side `getSession` as a call that needs request headers:

From `refs/better-auth/docs/content/docs/basic-usage.mdx:295`:

```ts
The server provides a `session` object that you can use to access the session data. It requires request headers object to be passed to the `getSession` method.
```

From `refs/better-auth/docs/content/docs/integrations/tanstack.mdx:101`:

```ts
export const getSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
    return session;
  },
);
```

So the underlying Better Auth API is intentionally header-driven. Hiding header lookup behind your own helper is reasonable, but it is a convenience wrapper, not the native model.

## Viability

This is viable in this repo.

Why:

- `Request` is already installed in the same runtime as `Auth` in `src/worker.ts:102`-`107`.
- `Request` does not depend on `Auth`, so no service cycle.
- `Auth` is only layered in `src/worker.ts:102`, so there is one place to update runtime wiring.
- Most `getSession` call sites are already inside `runEffect(...)`, so they already have access to the request-scoped environment.

In practice, `Auth.make` could read `Request` when implementing `getSession`, or `Auth` could expose a second helper that reads `Request` lazily inside the method body.

## Trade-offs

## 1. Pro: less boilerplate at `getSession` call sites

Routes like `src/routes/app.tsx:11`-`15` only need `Request` to feed headers into `getSession`:

```ts
const request = yield * Request;
const auth = yield * Auth;
const session = yield * auth.getSession(request.headers);
```

If `getSession` read `Request` internally, that becomes:

```ts
const auth = yield * Auth;
const session = yield * auth.getSession();
```

That is cleaner in route guards and layout loaders.

## 2. Con: `Auth` becomes more ambient and less explicit

Today `auth.getSession(headers)` says exactly what data it needs.

If `Auth` starts pulling `Request` from the environment, `getSession` becomes request-scoped ambient behavior. That is more convenient, but also more hidden:

- harder to use in tests without installing `Request`
- harder to reuse from non-HTTP contexts
- less obvious at the call site which request is being used

Right now `Auth` mostly represents a configured Better Auth instance plus thin helpers. Adding implicit request lookup pushes it toward a request-bound facade.

## 3. Con: limited total payoff

The boilerplate reduction is real, but small relative to total auth usage.

Repo search shows:

- `auth.getSession(request.headers)` at about 8 route call sites
- `headers: request.headers` at about 26 auth API call sites overall

Most auth operations still need explicit headers:

- `auth.api.signInMagicLink(...)` in `src/routes/login.tsx:58`
- `auth.api.listOrganizations(...)` in `src/routes/app.$organizationId.tsx:72`
- `auth.api.hasPermission(...)` in `src/routes/app.$organizationId.members.tsx:62`
- `auth.api.signOut(...)` in `src/lib/Auth.ts:368`

So adding `Request` to `Auth` only removes one repeated pattern, not the broader request-header plumbing.

## 4. Con: `Auth.layer` would pick up a request dependency

Today `src/worker.ts:102` can build `Auth.layer` from stable infra dependencies only:

```ts
const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
```

If `Auth.make` itself requires `Request`, that composition needs to change so `Request` is provided before `Auth` is constructed.

That is easy to do, but it means `Auth` is no longer just infra/config driven. It becomes tied to request-scoped runtime assembly.

## 5. Neutral: aligned with TanStack server helper style

Better Auth's TanStack docs already recommend wrapping `auth.api.getSession({ headers })` in a server helper. Your current `auth.getSession(headers)` is already that wrapper, just one level lower and still explicit about headers.

So moving to an internal `Request` lookup would be consistent with the docs' direction, not a conceptual mismatch.

## Recommendation

I would not replace the current explicit method with a request-implicit one as the only API.

Best fit here:

1. Keep `getSession(headers)` as the low-level explicit helper.
2. If the repeated route boilerplate feels noisy, add `getCurrentSession()` or `getSessionFromRequest()` alongside it.

Why this is the best balance:

- keeps tests and non-request uses easy
- preserves explicitness where useful
- gives route guards/loaders a cleaner call path
- avoids making the whole `Auth` service conceptually request-bound

If you prefer one method only, I would still lean toward the current explicit API because the repo already has many other explicit `request.headers` auth calls, so consistency wins over saving a small amount of code at only the `getSession` sites.

## Suggested Shape If You Want The Convenience

```ts
const getCurrentSession = Effect.fn("auth.getCurrentSession")(function* () {
  const request = yield* Request;
  return yield* getSession(request.headers);
});
```

That gives you the nice call sites without giving up the explicit version.

## Bottom Line

Viable: yes.

Recommended as a full replacement: no.

Recommended as an added convenience helper: yes.
