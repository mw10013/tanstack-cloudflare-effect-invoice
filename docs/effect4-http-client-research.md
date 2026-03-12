# Effect 4 HTTP Client Research

## Context

Currently `src/lib/google-client.ts` and `src/lib/google-oauth-client.ts` use raw `fetch` with manual error handling and `Schema.decodeUnknownSync`. This research explores migrating to Effect 4's HTTP client for idiomatic Effect patterns.

## Effect 4 HTTP Module

Located at `effect/unstable/http/*` — note the `unstable` namespace (API may evolve but is fully functional).

### Import paths

```ts
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Headers from "effect/unstable/http/Headers";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
```

### FetchHttpClient — Cloudflare Compatible

`FetchHttpClient` wraps `globalThis.fetch` — works on Cloudflare Workers out of the box since Workers provide a global `fetch`.

```ts
// Layer that provides HttpClient using globalThis.fetch
FetchHttpClient.layer; // Layer.Layer<HttpClient.HttpClient>

// Customizable via ServiceMap references:
FetchHttpClient.Fetch; // override the fetch function itself
FetchHttpClient.RequestInit; // provide default RequestInit options
```

No Node.js-specific dependencies. No Undici. Pure fetch.

### Core API

#### HttpClient as a Service

`HttpClient.HttpClient` is a `ServiceMap.Service` — injected via Effect's DI system:

```ts
// Access from context
const client = yield* HttpClient.HttpClient

// Convenience accessors (auto-resolve from context)
HttpClient.get(url, options?)   // Effect<HttpClientResponse, HttpClientError, HttpClient>
HttpClient.post(url, options?)
HttpClient.put(url, options?)
HttpClient.del(url, options?)
```

#### Request Construction

```ts
HttpClientRequest.get(url, options?)
HttpClientRequest.post(url, options?)

// Options: { headers?, body?, urlParams?, accept?, acceptJson? }

// Composition via pipe
request.pipe(
  HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
  HttpClientRequest.acceptJson,
  HttpClientRequest.prependUrl("https://api.example.com"),
)
```

#### Response Decoding with Schema

```ts
// Decode JSON body with Schema
HttpClientResponse.schemaBodyJson(MySchema)(response);
// => Effect<MySchema["Type"], HttpClientError | SchemaError>

// Full response decoding (status + headers + body)
HttpClientResponse.schemaJson(MySchema)(response);
```

`schemaBodyJson` uses `Schema.toCodecJson` + `Schema.decodeEffect` under the hood — fully effectful, returns `SchemaError` on decode failure.

#### Body Construction

```ts
HttpBody.jsonUnsafe({ key: "value" }); // sync, throws on stringify failure
HttpBody.json({ key: "value" }); // Effect<HttpBody, HttpBodyError>
HttpBody.text("raw string");
HttpBody.urlParams(params);
```

#### Error Types

```ts
class HttpClientError extends Data.TaggedError("HttpClientError") {
  reason: TransportError | StatusCodeError | EncodeError | DecodeError | ...
  request: HttpClientRequest
  response?: HttpClientResponse
  message: string
}
```

#### Client Transformations

```ts
// Filter non-2xx as errors
HttpClient.filterStatusOk(client)

// Prepend base URL to all requests
HttpClient.mapRequest(request =>
  request.pipe(HttpClientRequest.prependUrl("https://api.example.com"))
)

// Retry transient failures
HttpClient.retryTransient(options)(client)

// Pattern match on status
HttpClientResponse.matchStatus({
  200: (r) => ...,
  "4xx": (r) => ...,
  orElse: (r) => ...
})
```

## Approach: google-client.ts Migration

### Current Pattern

```ts
const fetchGoogle = async <S>({ url, accessToken, method, body, schema }) => {
  const response = await fetch(url, { ... })
  if (!response.ok) { /* manual error parsing */ throw new Error(...) }
  return Schema.decodeUnknownSync(schema)(await response.json())
}
```

### Effect 4 Pattern

**Option A: Thin wrapper using HttpClient service**

```ts
import * as Effect from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Schema from "effect/Schema";

class GoogleApiError extends Data.TaggedError("GoogleApiError")<{
  readonly code: number;
  readonly message: string;
  readonly status?: string;
}> {}

const GoogleApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    status: Schema.optionalKey(Schema.String),
  }),
});

const fetchGoogle = <S extends Schema.Top>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.acceptJson),
    );
    return yield* HttpClientResponse.matchStatus({
      "2xx": HttpClientResponse.schemaBodyJson(schema),
      orElse: (r) =>
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(GoogleApiErrorBody)(r).pipe(
            Effect.catchAll(() =>
              Effect.fail(
                new GoogleApiError({
                  code: r.status,
                  message: `HTTP ${r.status}`,
                }),
              ),
            ),
          ),
          ({ error }) => Effect.fail(new GoogleApiError(error)),
        ),
    })(response);
  });
```

Usage:

```ts
export const listDriveSpreadsheets = (accessToken: string, pageSize = 100) => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
  );
  url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
  url.searchParams.set("pageSize", String(pageSize));
  return fetchGoogle(
    HttpClientRequest.get(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    DriveListResponse,
  );
};
// => Effect<DriveListResponse["Type"], GoogleApiError | HttpClientError | SchemaError, HttpClient>
```

**Option B: Preconfigured Google client via mapRequest**

```ts
const makeGoogleClient = (accessToken: string) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.filterStatusOk,
      HttpClient.mapRequest((r) =>
        r.pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
          HttpClientRequest.acceptJson,
        ),
      ),
    ),
  );

export const listDriveSpreadsheets = (accessToken: string, pageSize = 100) =>
  Effect.gen(function* () {
    const google = yield* makeGoogleClient(accessToken);
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set(
      "q",
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    );
    url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
    url.searchParams.set("pageSize", String(pageSize));
    const response = yield* google.get(url);
    return yield* HttpClientResponse.schemaBodyJson(DriveListResponse)(
      response,
    );
  });
```

### Recommendation

**Option B** is more idiomatic — mirrors how `AnthropicClient` works in `refs/effect4/packages/ai/anthropic/src/AnthropicClient.ts`:

- Base client from context → transform with `mapRequest` for auth headers / base URL
- `filterStatusOk` converts non-2xx to `HttpClientError` with `StatusCodeError` reason
- `schemaBodyJson` for typed decoding
- Custom error mapping via `Effect.catchTag("HttpClientError", ...)`

For google-client, a custom error mapper can extract the Google API error body from the `StatusCodeError.response`:

```ts
const mapGoogleError = Effect.catchTag("HttpClientError", (error) =>
  error.response
    ? Effect.flatMap(
        HttpClientResponse.schemaBodyJson(GoogleApiErrorBody)(
          error.response,
        ).pipe(Effect.catchAll(() => Effect.fail(error))),
        ({ error: e }) => Effect.fail(new GoogleApiError(e)),
      )
    : Effect.fail(error),
);
```

## Approach: google-oauth-client.ts

The OAuth client uses `openid-client` library for OIDC discovery and token exchange. These are **not** simple HTTP requests — they're protocol-level operations (PKCE, state, token validation).

### Options

1. **Keep openid-client as-is, wrap in Effect** — `openid-client` handles OIDC complexity well. Wrap calls in `Effect.tryPromise` for Effect integration:

```ts
export const buildGoogleAuthorizationRequest = (
  input: GoogleAuthorizationInput,
) =>
  Effect.tryPromise({
    try: () => buildGoogleAuthorizationRequestRaw(input),
    catch: (cause) =>
      new GoogleOAuthError({ reason: "AuthorizationBuild", cause }),
  });

export const exchangeGoogleAuthorizationCode = (input: ExchangeInput) =>
  Effect.tryPromise({
    try: () => exchangeRaw(input),
    catch: (cause) => new GoogleOAuthError({ reason: "TokenExchange", cause }),
  });
```

2. **Replace openid-client with HttpClient** — manually implement OIDC discovery + token exchange. Not recommended — OIDC has many edge cases that `openid-client` handles.

3. **Hybrid: openid-client for discovery, HttpClient for token calls** — possible but `openid-client` already handles token exchange with PKCE validation, state checks, etc.

### Recommendation

**Option 1** — wrap `openid-client` calls in `Effect.tryPromise`. The OIDC protocol complexity justifies keeping the library. Changes:

- Replace `async` functions with Effect-returning functions
- Replace `Schema.decodeUnknownSync` with `Schema.decodeEffect` or `Schema.decodeUnknownEffect`
- Define typed errors (`GoogleOAuthError`) instead of raw throws
- Module-level cached config can use `Effect.cached` or `Ref` for the OIDC config

```ts
class GoogleOAuthError extends Data.TaggedError("GoogleOAuthError")<{
  readonly reason:
    | "Discovery"
    | "AuthorizationBuild"
    | "TokenExchange"
    | "TokenRefresh";
  readonly cause?: unknown;
}> {}

const getGoogleOidcConfig = (input: GoogleOAuthClientInput) =>
  Effect.tryPromise({
    try: async () => {
      const secret = Redacted.value(input.clientSecret);
      return Oidc.discovery(
        new URL("https://accounts.google.com"),
        input.clientId,
        secret,
      );
    },
    catch: (cause) => new GoogleOAuthError({ reason: "Discovery", cause }),
  });

export const exchangeGoogleAuthorizationCode = (input: ExchangeInput) =>
  Effect.gen(function* () {
    const config = yield* getGoogleOidcConfig(input);
    const tokenResponse = yield* Effect.tryPromise({
      try: () =>
        Oidc.authorizationCodeGrant(
          config,
          input.currentUrl,
          {
            pkceCodeVerifier: input.codeVerifier,
            expectedState: input.expectedState,
          },
          { redirect_uri: input.redirectUri },
        ),
      catch: (cause) =>
        new GoogleOAuthError({ reason: "TokenExchange", cause }),
    });
    return yield* Schema.decodeUnknownEffect(GoogleTokenResponse)(
      tokenResponse,
    );
  });
```

## Providing HttpClient on Cloudflare

At the app's entry point / Effect runtime setup:

```ts
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// FetchHttpClient.layer provides HttpClient backed by globalThis.fetch
// Cloudflare Workers has globalThis.fetch — no extra config needed

const program = myEffect.pipe(Effect.provide(FetchHttpClient.layer));
```

Or if using Layer composition:

```ts
const MainLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  // ...other layers
);
```

## Key Differences from Current Code

| Current                         | Effect 4 HttpClient                                     |
| ------------------------------- | ------------------------------------------------------- |
| Raw `fetch` + manual headers    | `HttpClientRequest.get/post` + `setHeader`              |
| `if (!response.ok) throw`       | `filterStatusOk` or `matchStatus`                       |
| `Schema.decodeUnknownSync`      | `schemaBodyJson` (effectful, returns `SchemaError`)     |
| `throw new Error(...)`          | Tagged errors (`GoogleApiError`, `HttpClientError`)     |
| `async/await`                   | `Effect.gen` / pipe                                     |
| Manual error message formatting | Structured `HttpClientError` with `reason` discriminant |

## Cloudflare Compatibility Notes

- `FetchHttpClient` uses `globalThis.fetch` — fully compatible with Workers
- No Node.js imports, no Undici dependency
- The `unstable` namespace is the correct import path in Effect 4 — these modules moved from `@effect/platform` into core `effect` package
- `Stream` support works for SSE/streaming responses if needed later
