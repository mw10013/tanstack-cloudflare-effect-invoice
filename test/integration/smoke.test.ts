import { login } from "@/lib/Login";
import { exports } from "cloudflare:workers";
import type {
  CustomFetch,
  Method,
  RequiredFetcher,
} from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { describe, expect, it } from "vitest";

import { resetDb } from "../test-utils";

type TestServerFn<TInputValidator, TResponse> =
  RequiredFetcher<undefined, TInputValidator, TResponse>;

const runServerFn = async <TInputValidator, TResponse>({
  serverFn,
  data,
}: {
  serverFn: TestServerFn<TInputValidator, TResponse>;
  data: Parameters<TestServerFn<TInputValidator, TResponse>>[0]["data"];
}) => {
  const serverFnWithMeta = serverFn as TestServerFn<TInputValidator, TResponse> & {
    serverFnMeta: { id: string };
  };
  const clientRpc = createClientRpc(serverFnWithMeta.serverFnMeta.id) as (
    options: {
      method: Method;
      fetch: CustomFetch;
      data: Parameters<TestServerFn<TInputValidator, TResponse>>[0]["data"];
    },
  ) => Promise<{ result: Awaited<TResponse>; error?: unknown }>;
  const fetchServerFn = (url: string, init?: RequestInit) =>
    exports.default.fetch(new Request(new URL(url, "http://example.com"), init));
  const result = await runWithStartContext<{
    result: Awaited<TResponse>;
    error?: unknown;
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
      clientRpc({
        data,
        method: serverFn.method,
        fetch: fetchServerFn,
      } as {
        method: Method;
        fetch: CustomFetch;
        data: Parameters<TestServerFn<TInputValidator, TResponse>>[0]["data"];
      }),
  );

  return result.result;
};

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });

  it("calls the login server fn", async () => {
    await resetDb();
    const result = await runServerFn({
      serverFn: login,
      data: { email: "u@u.com" },
    });

    expect(result.success).toBe(true);
    expect(result.magicLink).toContain("/api/auth/magic-link/verify");
  });
});
