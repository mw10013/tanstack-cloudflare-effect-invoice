import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";

export const resolveMagicLinkRedirectFn = createServerFn({
  method: "GET",
}).handler(({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const request = yield* Request;
      const auth = yield* Auth;
      return yield* auth.getSession(request.headers).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.matchEffect({
          onFailure: () =>
            Effect.succeed({
              error: "Magic link sign-in could not be completed.",
            }),
          onSuccess: ({ user }) =>
            Effect.die(
              redirect({ to: user.role === "admin" ? "/admin" : "/app" }),
            ),
        }),
      );
    }),
  ),
);

export const Route = createFileRoute("/magic-link")({
  loader: async ({ location }) => {
    const params = new URLSearchParams(location.searchStr);
    const error = params.get("error");
    if (error) {
      return { error };
    }
    return resolveMagicLinkRedirectFn();
  },
  component: RouteComponent,
});

function RouteComponent() {
  const loaderData = Route.useLoaderData();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="text-2xl font-bold">Magic Link Error</h1>
      <p className="mt-4">{loaderData.error}</p>
      <p className="mt-4">
        Try{" "}
        <a href="/login" className="underline">
          signing in
        </a>{" "}
        again.
      </p>
    </div>
  );
}
