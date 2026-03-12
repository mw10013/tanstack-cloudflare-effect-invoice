import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Option from "effect/Option";

import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const session = yield* auth.getSession(request.headers);
        if (Option.isNone(session))
          return yield* Effect.die(redirect({ to: "/login" }));
        if (session.value.user.role !== "user")
          return yield* Effect.die(redirect({ to: "/" }));
        return { sessionUser: session.value.user };
      }),
    ),
);

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    return await beforeLoadServerFn();
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
