import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const organizationId = yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map(({ session }) => session.activeOrganizationId),
          Effect.flatMap(Effect.fromNullishOr),
        );
        return yield* Effect.die(
          redirect({
            to: "/app/$organizationId",
            params: { organizationId },
          }),
        );
      }),
    ),
);

export const Route = createFileRoute("/app/")({
  beforeLoad: async () => await beforeLoadServerFn(),
});
