import { createFileRoute } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";

const authAllowlistMiddleware = createMiddleware().server(({ next, request }) =>
  new Set([
    "POST /api/auth/stripe/webhook",
    "GET /api/auth/magic-link/verify",
    "GET /api/auth/subscription/success",
    "GET /api/auth/subscription/cancel/callback",
  ]).has(`${request.method} ${new URL(request.url).pathname}`)
    ? next()
    : new Response("Not Found", { status: 404 }),
);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    middleware: [authAllowlistMiddleware],
    handlers: {
      GET: async ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* Request;
            const auth = yield* Auth;
            return yield* auth.handler(request);
          }),
        ),
      POST: async ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* Request;
            const auth = yield* Auth;
            return yield* auth.handler(request);
          }),
        ),
    },
  },
});
