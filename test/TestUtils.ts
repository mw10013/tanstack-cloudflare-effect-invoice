import { MessageType } from "agents";
import type { RPCResponse } from "agents";
import type { ClientFnMeta, RequiredFetcher } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { assertFalse, assertTrue } from "@effect/vitest/utils";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Option, Schedule } from "effect";
import * as Cookies from "effect/unstable/http/Cookies";

import { login as loginServerFn } from "@/lib/Login";
import { getLoaderData as getInvoiceLoaderData } from "@/routes/app.$organizationId.invoices.$invoiceId";

export type ServerFn<TInputValidator, TResponse> = RequiredFetcher<
  undefined,
  TInputValidator,
  TResponse
> & {
  serverFnMeta?: ClientFnMeta;
};

export const resetDb = Effect.fn("resetDb")(function*() {
  yield* Effect.promise(() =>
    env.D1.batch([
      ...["Session", "Member", "Invitation", "Verification", "Organization"].map(
        (table) => env.D1.prepare(`delete from ${table}`),
      ),
      env.D1.prepare(`delete from Account where id <> 'admin'`),
      env.D1.prepare(`delete from User where id <> 'admin'`),
    ])
  );
});

/**
 * Calls the Worker's `fetch` handler directly in-process (no network).
 * The origin is ignored — the Worker only routes on the pathname — so
 * any valid URL works (e.g. `http://x/login`).
 */
export const workerFetch = Effect.fn("workerFetch")(
  function*(url: string, init?: RequestInit) {
    return yield* Effect.promise(() =>
      exports.default.fetch(new Request(url, init))
    );
  },
);

/**
 * Calls a TanStack server function in-process via the Worker's fetch handler.
 *
 * Uses `createClientRpc` to serialize args and build the request, then routes
 * it through `exports.default.fetch` (no network). A stub `runWithStartContext`
 * provides the minimal AsyncLocalStorage context the server handler expects —
 * no client or server middleware actually executes.
 */
export const callServerFn = Effect.fn("callServerFn")(
  function*<TInputValidator, TResponse>({
    serverFn,
    data,
    headers,
  }: {
    serverFn: ServerFn<TInputValidator, TResponse>;
    data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"];
    headers?: HeadersInit;
  }): Effect.fn.Return<Awaited<TResponse>, Error> {
    return yield* Effect.promise(() => {
      if (!serverFn.serverFnMeta)
        throw new Error("Missing serverFnMeta in integration test");
      const clientRpc = createClientRpc(serverFn.serverFnMeta.id);
      const fetchServerFn = (url: string, init?: RequestInit) => {
        const mergedHeaders = new Headers(init?.headers);
        if (headers) {
          const extraHeaders = new Headers(headers);
          for (const [key, value] of extraHeaders.entries()) {
            mergedHeaders.set(key, value);
          }
        }
        return exports.default.fetch(
          new Request(new URL(url, "http://w"), {
            ...init,
            headers: mergedHeaders,
          }),
        );
      };
      return runWithStartContext(
        {
          contextAfterGlobalMiddlewares: {},
          executedRequestMiddlewares: new Set(),
          getRouter: () => {
            throw new Error("unused in integration test");
          },
          request: new Request("http://w"),
          startOptions: {},
        },
        () =>
          clientRpc({
            data,
            method: serverFn.method,
            fetch: fetchServerFn,
          }) as Promise<{ result: Awaited<TResponse>; error?: unknown }>,
      ).then((r) => r.result);
    });
  },
);

export const extractSessionCookie = Effect.fn("extractSessionCookie")(
  function*(response: Response): Effect.fn.Return<string, Error> {
    const cookies = Cookies.fromSetCookie(response.headers.getSetCookie());
    const token = Cookies.getValue(cookies, "better-auth.session_token");
    if (Option.isNone(token))
      return yield* Effect.fail(new Error("Missing session cookie"));
    return Cookies.toCookieHeader(cookies);
  },
);

/**
 * Calls a @callable() method on a Cloudflare Agent over its shared WebSocket.
 *
 * Uses `Effect.callback` to bridge the callback-based `addEventListener` API
 * into Effect. `addEventListener` doesn't return a Promise — the result arrives
 * later through the handler function. `Effect.callback((resume) => ...)` lets us
 * call `resume(Effect.succeed(msg))` when the handler fires, which completes
 * the Effect with that value.
 *
 * The function returned from the `Effect.callback` register is a finalizer —
 * it runs when the Effect is interrupted (e.g. by `Effect.timeout`), removing
 * the event listener so it doesn't leak.
 */
export const callAgentRpc = Effect.fn("callAgentRpc")(
  // oxlint-disable-next-line @typescript-eslint/no-inferrable-types -- oxlint sees Effect.fn generator params as any; explicit type prevents no-unsafe-argument on Effect.timeout
  function*(ws: WebSocket, method: string, args: unknown[] = [], timeout: number = 10_000) {
    return yield* Effect.callback<RPCResponse>((resume) => {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as RPCResponse;
        if (msg.type === MessageType.RPC && msg.id === id) {
          if (msg.success && !msg.done) return;
          ws.removeEventListener("message", handler);
          resume(Effect.succeed(msg));
        }
      };
      ws.addEventListener("message", handler);
      return Effect.sync(() => { ws.removeEventListener("message", handler); });
    }).pipe(
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.die(new Error(`Agent RPC timeout: ${method}`))),
    );
  },
);

/**
 * Opens a WebSocket to a Cloudflare Agent as a scoped resource.
 * The WebSocket is automatically closed when the enclosing Effect scope ends
 * (e.g. when the `it.effect` test completes).
 */
export const agentWebSocket = Effect.fn("agentWebSocket")(
  function*(organizationId: string, sessionCookie: string) {
    return yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const res = yield* Effect.promise(() =>
          exports.default.fetch(
            `http://w/agents/organization-agent/${organizationId}`,
            { headers: { Upgrade: "websocket", Cookie: sessionCookie } },
          )
        );
        const ws = res.webSocket;
        if (!ws) return yield* Effect.fail(new Error(`WebSocket upgrade failed: ${String(res.status)}`));
        ws.accept();
        // No need to drain initial protocol messages (identity, state, mcp_servers)
        // unlike refs/agents tests — callAgentRpc filters by type + id so they're ignored.
        return ws;
      }),
      (ws) => Effect.sync(() => { ws.close(); }),
    );
  },
);

/**
 * Performs a full magic-link login flow in-process: requests a magic link,
 * verifies it, extracts the session cookie, and follows the redirect to
 * resolve the organizationId.
 */
export const login = Effect.fn("login")(function*(email: string) {
  const result = yield* callServerFn({
    serverFn: loginServerFn,
    data: { email },
  });
  const verifyResponse = yield* workerFetch(result.magicLink ?? "", {
    redirect: "manual",
  });
  const sessionCookie = yield* extractSessionCookie(verifyResponse);
  const appResponse = yield* workerFetch(
    new URL(
      verifyResponse.headers.get("location") ?? "/",
      result.magicLink,
    ).toString(),
    { headers: { Cookie: sessionCookie } },
  );
  const organizationId = new URL(appResponse.url).pathname.split("/")[2];
  if (!organizationId) return yield* Effect.fail(new Error(`Could not extract organizationId from redirect URL: ${appResponse.url}`));
  return { sessionCookie, organizationId };
});

export const pollInvoiceStatus = Effect.fn("pollInvoiceStatus")(
  function*(
    {
      sessionCookie,
      organizationId,
      invoiceId,
    }: {
      sessionCookie: string;
      organizationId: string;
      invoiceId: string;
    },
  ) {
    return yield* callServerFn({
      serverFn: getInvoiceLoaderData,
      data: { organizationId, invoiceId },
      headers: { Cookie: sessionCookie },
    }).pipe(
      Effect.flatMap(({ invoice }) =>
        invoice.status === "ready" || invoice.status === "error"
          ? Effect.succeed(invoice)
          : Effect.fail(new Error("not ready")),
      ),
      Effect.retry(
        Schedule.spaced("2 seconds").pipe(
          Schedule.while(({ elapsed }) => elapsed < 60_000),
        ),
      ),
    );
  },
);

/**
 * Resolves a Durable Object stub for the OrganizationAgent by name. Used by
 * tests that need to call `runDurableObjectAlarm` or `runInDurableObject`
 * directly against the agent's storage.
 */
export const getOrganizationAgentStub = (organizationId: string) =>
  env.ORGANIZATION_AGENT.get(env.ORGANIZATION_AGENT.idFromName(organizationId));

/**
 * Drains all pending Durable Object alarms for a stub. Per
 * `refs/cloudflare-docs/.../workers/testing/vitest-integration/known-issues.mdx`,
 * DO alarms persist across test runs and do not respect isolated storage, so
 * tests that schedule alarms must explicitly drain them before completing to
 * avoid stray executions firing into the next test's runtime.
 *
 * `runDurableObjectAlarm` returns `true` while there is a pending alarm and
 * runs it once; the loop terminates as soon as it returns `false`.
 */
export const drainAgentAlarms = Effect.fn("drainAgentAlarms")(
  function* (stub: DurableObjectStub) {
    yield* Effect.promise(async () => {
      while (await runDurableObjectAlarm(stub)) {
        // keep draining
      }
    });
  },
);

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
