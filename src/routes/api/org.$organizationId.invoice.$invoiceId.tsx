import { createFileRoute } from "@tanstack/react-router";
import { Config, Effect } from "effect";
import * as Option from "effect/Option";
import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export const Route = createFileRoute(
  "/api/org/$organizationId/invoice/$invoiceId",
)({
  server: {
    handlers: {
      GET: async ({
        request,
        params: { organizationId, invoiceId },
        context: { runEffect },
      }) =>
        runEffect(
          Effect.gen(function* () {
            const environment = yield* Config.nonEmptyString("ENVIRONMENT");
            if (environment !== "local") {
              return new Response("Not Found", { status: 404 });
            }
            const auth = yield* Auth;
            const sessionOption = yield* auth.getSession(request.headers);
            if (Option.isNone(sessionOption)) {
              return new Response("Unauthorized", { status: 401 });
            }
            if (
              sessionOption.value.session.activeOrganizationId !== organizationId
            ) {
              return new Response("Forbidden", { status: 403 });
            }
            const { R2 } = yield* CloudflareEnv;
            const key = `${organizationId}/invoices/${invoiceId}`;
            const object = yield* Effect.tryPromise(() => R2.get(key));
            if (!object?.body) {
              return new Response("Not Found", { status: 404 });
            }
            return new Response(object.body, {
              headers: {
                "Content-Type":
                  object.httpMetadata?.contentType ?? "application/octet-stream",
                "Cache-Control": "private, max-age=60",
                ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
              },
            });
          }),
        ),
    },
  },
});
