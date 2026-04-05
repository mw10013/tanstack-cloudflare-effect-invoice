# Research: invoice limit config vs test constant

## Question

Test `test/integration/upload-invoice.test.ts:91` hardcodes `invoiceLimit = 3`. Should be sourced from Effect v4 `Config`. Also need to confirm how env vars flow into `Config`.

## Findings

1. `INVOICE_LIMIT` already read via `Config.number("INVOICE_LIMIT")` inside the `OrganizationAgent` paths that enforce the limit.

Excerpt `src/organization-agent.ts`:
```ts
const invoiceLimit = yield* Config.number("INVOICE_LIMIT");
const repo = yield* OrganizationRepository;
const count = yield* repo.countInvoices();
if (count >= invoiceLimit)
  return yield* new InvoiceLimitExceededError({ limit: invoiceLimit, message: `Invoice limit of ${String(invoiceLimit)} reached` });
```

2. The agent runtime installs a `ConfigProvider` backed by the Cloudflare `env` object, so `Config.*` reads from env bindings/vars.

Excerpt `src/organization-agent.ts`:
```ts
const envLayer = Layer.succeedServices(
  ServiceMap.make(CloudflareEnv, env).pipe(
    ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  ),
);
```

3. Local and production `INVOICE_LIMIT` are defined in `wrangler.jsonc` vars.

Excerpt `wrangler.jsonc` (local vars):
```json
"vars": {
  "ENVIRONMENT": "local",
  "INVOICE_LIMIT": "3"
}
```

Excerpt `wrangler.jsonc` (production vars):
```json
"env": {
  "production": {
    "vars": {
      "ENVIRONMENT": "production",
      "INVOICE_LIMIT": "10"
    }
  }
}
```

4. Effect v4 docs confirm `Config` reads via a `ConfigProvider`, and `ConfigProvider.fromUnknown` is a standard source for plain objects.

Excerpt `refs/effect4/packages/effect/CONFIG.md`:
```ts
- ConfigProvider — reads raw data from a source (environment variables, JSON objects, .env files, directory trees).
- Config — describes what shape and types you expect, then decodes the raw data into typed values.
```

Excerpt `refs/effect4/packages/effect/CONFIG.md`:
```ts
const provider = ConfigProvider.fromUnknown({
  host: "localhost",
  port: 5432
})

const result = Effect.runSync(dbConfig.parse(provider))
```

5. The integration test currently hardcodes `invoiceLimit = 3`.

Excerpt `test/integration/upload-invoice.test.ts:90-96`:
```ts
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const invoiceLimit = 3;

for (let i = 0; i < invoiceLimit; i++) {
  const result = yield* callRpc(ws, "createInvoice", []);
  expect(result.success).toBe(true);
}
```

## Implications

- App-side limit is already driven by env via `Config.number("INVOICE_LIMIT")`.
- Test constant `3` only matches because `wrangler.jsonc` local vars set `INVOICE_LIMIT` to `"3"`. Drift risk if that var changes.

## Options for test alignment (no code changes requested)

- Replace the hardcoded `3` with a value read from `Config.number("INVOICE_LIMIT")` using the same provider (`ConfigProvider.fromUnknown(env)`) already used in app runtime.
- Or read from `env.INVOICE_LIMIT` in the test (env comes from `cloudflare:workers`).

