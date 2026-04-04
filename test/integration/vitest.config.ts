/* oxlint-disable */
import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Integration tests call TanStack server-fn RPC code directly, so seed the
// server-fn base here instead of patching the real worker entrypoint.
process.env.TSS_SERVER_FN_BASE ??= "/_serverFn/";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrationsPath = path.join(rootDir, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: {
          configPath: path.join(rootDir, "wrangler.jsonc"),
        },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
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
    define: {
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(
        process.env.TSS_SERVER_FN_BASE,
      ),
      "import.meta.env.TSS_SERVER_FN_BASE": JSON.stringify(
        process.env.TSS_SERVER_FN_BASE,
      ),
    },
    test: {
      env: {
        TSS_SERVER_FN_BASE: process.env.TSS_SERVER_FN_BASE,
      },
      include: ["test/integration/*.test.ts"],
      onUnhandledError: (error: unknown) => {
        // Better Auth models redirects as APIError("FOUND"). The worker test
        // runtime leaks that redirect sentinel as an unhandled rejection even
        // though the response path under test succeeds.
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          "status" in error &&
          error.name === "APIError" &&
          error.status === "FOUND"
        ) {
          return false;
        }
      },
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});
