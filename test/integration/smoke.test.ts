import { login } from "@/lib/Login";
import { exports } from "cloudflare:workers";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { describe, expect, it } from "vitest";

import { resetDb } from "../test-utils";

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });

  it("calls the login server fn", async () => {
    await resetDb();
    const loginServerFn = login as typeof login & {
      serverFnMeta: { id: string };
    };
    const loginClientRpc = createClientRpc(loginServerFn.serverFnMeta.id);
    const fetchServerFn = (url: string, init?: RequestInit) =>
      exports.default.fetch(new Request(new URL(url, "http://example.com"), init));
    const result = await runWithStartContext<{
      result: Awaited<ReturnType<typeof login>>;
    }>(
      {
        contextAfterGlobalMiddlewares: {},
        executedRequestMiddlewares: new Set(),
        getRouter: () => {
          throw new Error("unused in integration test");
        },
        request: new Request("http://example.com"),
        startOptions: {},
      },
      () =>
        loginClientRpc({
          data: { email: "u@u.com" },
          method: "POST",
          fetch: fetchServerFn,
        }),
    );

    expect(result.result.success).toBe(true);
    expect(result.result.magicLink).toContain("/api/auth/magic-link/verify");
  });
});
