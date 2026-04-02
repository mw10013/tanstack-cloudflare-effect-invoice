# Vitest Integration Research

## Summary

Vitest is integrated here as a Cloudflare Worker test harness around the real app Worker.

- `pnpm test` runs `vitest run`
- `pnpm test:integration` runs `pnpm vitest --config test/integration/vitest.config.ts run`
- root `vitest.config.ts` re-exports `test/integration/vitest.config`
- the Worker under test comes from `wrangler.jsonc`, which points at `src/worker.ts`
- integration tests call the Worker through `cloudflare:workers`
- D1 migrations are loaded into Miniflare and applied in `test/apply-migrations.ts`

## Entry Points

`package.json` wires the scripts like this:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:integration": "pnpm vitest --config test/integration/vitest.config.ts run",
    "typecheck:test": "tsc -p test/tsconfig.json"
  }
}
```

The repo-level Vitest config forwards everything to the integration config:

`vitest.config.ts`

```ts
export { default } from "./test/integration/vitest.config";
```

That makes `pnpm test` and `pnpm test:integration` use the same Vitest setup.

## Integration Config

The main integration wiring lives in `test/integration/vitest.config.ts`:

```ts
import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: path.join(rootDir, "wrangler.jsonc") },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
      tsconfigPaths({
        projects: [path.join(rootDir, "tsconfig.json")],
      }),
      tanstackStart(),
      viteReact({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.join(rootDir, "src"),
      },
    },
    test: {
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});
```

Current responsibilities of this config:

- `cloudflareTest()` boots the Worker test runtime
- `wrangler.configPath` makes Wrangler config the source of truth for the Worker
- `remoteBindings: false` keeps bindings local to the test runtime
- `readD1Migrations()` loads SQL migrations into `TEST_MIGRATIONS`
- `root` is pinned to the repo root, not `test/integration`
- `tanstackStart()`, `viteReact()`, and `tsconfigPaths()` make the test Vite runtime match the app's Vite runtime closely enough for TanStack Start SSR modules to resolve
- the explicit `@` alias matches the main app config

## Worker Under Test

`wrangler.jsonc` defines the app Worker entrypoint:

```jsonc
{
  "main": "./src/worker.ts"
}
```

`src/worker.ts` exports the Worker module Vitest exercises:

```ts
export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const isMagicLinkRequest =
      (url.pathname === "/login" && request.method === "POST") ||
      url.pathname === "/api/auth/magic-link/verify";

    if (isMagicLinkRequest) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
    }

    return serverEntry.fetch(request, {
      context: {
        env,
        runEffect,
      },
    });
  },
};
```

So the tests target the actual Worker module, not a separate test-only server entry.

## Vite Alignment With The App

The integration config intentionally mirrors the main app Vite config.

`vite.config.ts`

```ts
plugins: [
  devtools(),
  cloudflare({ viteEnvironment: { name: "ssr" } }),
  viteTsConfigPaths({
    projects: ["./tsconfig.json"],
  }),
  tailwindcss(),
  tanstackStart(),
  viteReact({
    babel: {
      plugins: [
        ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
      ],
    },
  }),
],
```

The test config does not need every app plugin, but it does carry the important SSR-facing pieces:

- `tsconfigPaths()`
- `tanstackStart()`
- `viteReact()` with the decorators Babel plugin
- `@` alias to `src`

That keeps the Worker test runtime compatible with the same route and module resolution the app uses in development and build.

## D1 Migration Setup

Migrations are loaded in the Vitest config and applied before tests execute.

`test/apply-migrations.ts`

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.D1, env.TEST_MIGRATIONS);
```

`test/env.d.ts`

```ts
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

This gives the test runtime a typed `TEST_MIGRATIONS` binding while keeping the real D1 binding on `env.D1`.

## TypeScript Wiring

`test/tsconfig.json` provides the test-only type environment:

```json
{
  "compilerOptions": {
    "types": [
      "vitest",
      "node",
      "@cloudflare/vitest-pool-workers/types",
      "@playwright/test"
    ],
    "module": "esnext",
    "moduleResolution": "bundler",
    "rootDirs": [".."]
  }
}
```

That gives the tests Vitest globals, Cloudflare Worker test types, and access to the generated Worker bindings in `worker-configuration.d.ts`.

## Test Invocation Pattern

The current route-level smoke test calls the Worker through `cloudflare:workers`:

`test/integration/smoke.test.ts`

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });
});
```

This is the core test shape for the current integration:

- import the Worker module from `cloudflare:workers`
- call `exports.default.fetch()` with an app URL
- assert on the full Worker response

## Current Suite Shape

Current integration tests under `test/integration/`:

- `smoke.test.ts` exercises `/login` through `exports.default.fetch()`
- `auth.test.ts` is present but wrapped in `describe.skip(...)`

`auth.test.ts` still uses `cloudflare:test` imports:

```ts
import { env, SELF } from "cloudflare:test";

describe.skip("auth (integration)", () => {
```

So today the active, non-skipped integration coverage is the smoke-style Worker fetch path.

## Bottom Line

Vitest is integrated here as a Worker-first integration setup:

- the real Worker comes from `wrangler.jsonc` -> `src/worker.ts`
- Vitest runs through `@cloudflare/vitest-pool-workers`
- the test Vite config includes the TanStack Start and React plugins the app depends on
- D1 migrations are injected into Miniflare and applied in a setup file
- tests exercise the Worker by calling `exports.default.fetch()`

That is the current integration model in this repo.
