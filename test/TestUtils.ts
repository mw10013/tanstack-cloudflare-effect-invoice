import { MessageType } from "agents";
import type { RPCResponse } from "agents";
import type { ClientFnMeta, RequiredFetcher } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { env, exports } from "cloudflare:workers";
import { Effect, Option, Schedule } from "effect";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";

import { login } from "@/lib/Login";
import * as OrganizationDomain from "@/lib/OrganizationDomain";

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

export const fetchWorker = Effect.fn("fetchWorker")(
  function*(url: string, init?: RequestInit) {
    return yield* Effect.promise(() =>
      exports.default.fetch(new Request(new URL(url, "http://example.com"), init))
    );
  },
);

export const runServerFn = Effect.fn("runServerFn")(
  function*<TInputValidator, TResponse>({
    serverFn,
    data,
  }: {
    serverFn: ServerFn<TInputValidator, TResponse>;
    data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"];
  }): Effect.fn.Return<Awaited<TResponse>, Error> {
    return yield* Effect.promise(() => {
      if (!serverFn.serverFnMeta)
        throw new Error("Missing serverFnMeta in integration test");
      const clientRpc = createClientRpc(serverFn.serverFnMeta.id);
      const fetchServerFn = (url: string, init?: RequestInit) =>
        exports.default.fetch(
          new Request(new URL(url, "http://example.com"), init),
        );
      return runWithStartContext(
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

const waitForMessage = Effect.fn("waitForMessage")(
  function*(ws: WebSocket, timeout = 5000) {
    return yield* Effect.promise<unknown>(() =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timeout waiting for WebSocket message"));
        }, timeout as number);
        ws.addEventListener(
          "message",
          (e: MessageEvent) => {
            clearTimeout(timer);
            resolve(JSON.parse(e.data as string));
          },
          { once: true },
        );
      })
    );
  },
);

const skipInitialMessages = Effect.fn("skipInitialMessages")(
  function*(ws: WebSocket) {
    for (let i = 0; i < 3; i++) yield* waitForMessage(ws);
  },
);

export const callAgentRpc = Effect.fn("callAgentRpc")(
  // oxlint-disable-next-line @typescript-eslint/no-inferrable-types -- oxlint sees Effect.fn generator params as any; explicit type prevents no-unsafe-argument on setTimeout
  function*(ws: WebSocket, method: string, args: unknown[] = [], timeout: number = 10_000) {
    return yield* Effect.promise<RPCResponse>(() => {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`RPC timeout: ${method}`));
        }, timeout);
        const handler = (e: MessageEvent) => {
          const msg = JSON.parse(e.data as string) as RPCResponse;
          if (msg.type === MessageType.RPC && msg.id === id) {
            if (msg.success && !msg.done) return;
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve(msg);
          }
        };
        ws.addEventListener("message", handler);
      });
    });
  },
);

export const agentWebSocket = Effect.fn("agentWebSocket")(
  function*(orgId: string, sessionCookie: string) {
    return yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const res = yield* Effect.promise(() =>
          exports.default.fetch(
            `http://example.com/agents/organization-agent/${orgId}`,
            { headers: { Upgrade: "websocket", Cookie: sessionCookie } },
          )
        );
        const ws = res.webSocket;
        if (!ws) return yield* Effect.fail(new Error(`WebSocket upgrade failed: ${String(res.status)}`));
        ws.accept();
        yield* skipInitialMessages(ws);
        return ws;
      }),
      (ws) => Effect.sync(() => { ws.close(); }),
    );
  },
);

export const loginAndGetAuth = Effect.fn("loginAndGetAuth")(function*() {
  yield* resetDb();
  const result = yield* runServerFn({
    serverFn: login,
    data: { email: "u@u.com" },
  });
  const verifyResponse = yield* fetchWorker(result.magicLink ?? "", {
    redirect: "manual",
  });
  const sessionCookie = yield* extractSessionCookie(verifyResponse);
  const appResponse = yield* fetchWorker(
    new URL(
      verifyResponse.headers.get("location") ?? "/",
      result.magicLink,
    ).toString(),
    { headers: { Cookie: sessionCookie } },
  );
  const orgId = new URL(appResponse.url).pathname.split("/")[2];
  if (!orgId) return yield* Effect.fail(new Error("Could not extract orgId from redirect URL"));
  return { sessionCookie, orgId };
});

export const pollInvoiceStatus = Effect.fn("pollInvoiceStatus")(
  function*(ws: WebSocket, invoiceId: string) {
    return yield* callAgentRpc(ws, "getInvoices", []).pipe(
      Effect.flatMap((result) => {
        if (!result.success) return Effect.fail(new Error("getInvoices failed"));
        const invoices = Schema.decodeUnknownSync(
          Schema.Array(OrganizationDomain.Invoice),
        )(result.result);
        const inv = invoices.find((i) => i.id === invoiceId);
        if (inv?.status === "ready" || inv?.status === "error") return Effect.succeed(inv);
        return Effect.fail(new Error("not ready"));
      }),
      Effect.retry(
        Schedule.spaced("2 seconds").pipe(
          Schedule.while(({ elapsed }) => elapsed < 60_000),
        ),
      ),
    );
  },
);
