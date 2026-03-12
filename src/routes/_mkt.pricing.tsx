import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  useHydrated,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Auth } from "@/lib/Auth";
import { Request } from "@/lib/Request";
import { Stripe } from "@/lib/Stripe";

export const Route = createFileRoute("/_mkt/pricing")({
  loader: async () => {
    return await getLoaderData();
  },
  component: RouteComponent,
});

const getLoaderData = createServerFn({ method: "GET" }).handler(
  async ({ context: { runEffect } }) => {
    return runEffect(
      Effect.gen(function* () {
        const stripe = yield* Stripe;
        const plans = yield* stripe.getPlans();
        return { plans };
      }),
    );
  },
);

const upgradeSubscriptionServerFn = createServerFn({ method: "POST" })
  .inputValidator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        intent: Schema.NonEmptyString,
      }),
    ),
  )
  .handler(({ data: { intent }, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const session = yield* auth.getSession(request.headers);
        if (Option.isNone(session)) {
          return yield* Effect.die(redirect({ to: "/login" }));
        }
        if (session.value.user.role !== "user") {
          return yield* Effect.fail(new Error("Forbidden"));
        }
        const stripe = yield* Stripe;
        const plans = yield* stripe.getPlans();
        const plan = plans.find(
          (p) =>
            p.monthlyPriceLookupKey === intent ||
            p.annualPriceLookupKey === intent,
        );
        if (!plan) {
          return yield* Effect.die(notFound());
        }
        const activeOrganizationId = yield* Effect.fromNullishOr(
          session.value.session.activeOrganizationId,
        );
        const subscriptions = yield* Effect.tryPromise(() =>
          auth.api.listActiveSubscriptions({
            headers: request.headers,
            query: {
              referenceId: activeOrganizationId,
              customerType: "organization",
            },
          }),
        );
        const subscriptionId =
          subscriptions.length > 0
            ? subscriptions[0].stripeSubscriptionId
            : undefined;
        yield* Effect.logInfo("pricing.upgradeSubscription.start", {
          plan: plan.name,
          subscriptionId,
        });
        const { url, redirect: isRedirect } = yield* Effect.tryPromise(() =>
          auth.api.upgradeSubscription({
            headers: request.headers,
            body: {
              plan: plan.name,
              annual: intent === plan.annualPriceLookupKey,
              referenceId: activeOrganizationId,
              customerType: "organization",
              subscriptionId,
              seats: 1,
              successUrl: "/app",
              cancelUrl: "/pricing",
              returnUrl: `/app/${activeOrganizationId}`,
              disableRedirect: false,
            },
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logError("pricing.upgradeSubscription.failed", { error }),
          ),
        );
        yield* Effect.logInfo("pricing.upgradeSubscription.response", {
          isRedirect,
          url,
        });
        if (!isRedirect || !url) {
          return yield* Effect.fail(
            new Error("Failed to create checkout session"),
          );
        }
        return yield* Effect.die(
          redirect({
            href: url,
          }),
        );
      }),
    ),
  );

function RouteComponent() {
  const { plans } = Route.useLoaderData();
  const upgradeSubscriptionFn = useServerFn(upgradeSubscriptionServerFn);
  const [isAnnual, setIsAnnual] = React.useState(false);
  const isHydrated = useHydrated();

  const upgradeSubscriptionMutation = useMutation({
    mutationFn: (intent: string) =>
      upgradeSubscriptionFn({
        data: { intent },
      }),
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center py-12">
      <div className="relative flex w-full flex-col items-center justify-center gap-4 border px-6 py-48">
        <span className="absolute -top-2.25 left-0 h-5 w-px animate-pulse bg-primary opacity-80" />
        <span className="absolute top-0 -left-2.25 h-px w-5 animate-pulse bg-primary opacity-80" />
        <span className="absolute right-0 -bottom-2.25 h-5 w-px animate-pulse bg-primary opacity-80" />
        <span className="absolute -right-2.25 bottom-0 h-px w-5 animate-pulse bg-primary opacity-80" />
        <div className="absolute inset-0 isolate -z-10 overflow-hidden">
          <div className="absolute inset-y-0 left-1/2 w-300 -translate-x-1/2 mask-[linear-gradient(black,transparent_320px),linear-gradient(90deg,transparent,black_5%,black_95%,transparent)] mask-intersect">
            <svg
              className="pointer-events-none absolute inset-0 text-primary/10"
              width="100%"
              height="100%"
            >
              <defs>
                <pattern
                  id="grid-_r_17_"
                  x="-0.25"
                  y={-1}
                  width={60}
                  height={60}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M 60 0 L 0 0 0 60"
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth={1}
                  />
                </pattern>
              </defs>
              <rect fill="url(#grid-_r_17_)" width="100%" height="100%" />
            </svg>
          </div>
          <div className="absolute top-6 left-1/2 size-20 -translate-x-1/2 -translate-y-1/2 scale-x-[1.6] opacity-10 mix-blend-overlay">
            <div className="absolute -inset-16 bg-[conic-gradient(from_90deg,#22d3ee_5deg,#38bdf8_63deg,#2563eb_115deg,#0ea5e9_170deg,#22d3ee_220deg,#38bdf8_286deg,#22d3ee_360deg)] mix-blend-overlay blur-[50px] grayscale saturate-[2]" />
            <div className="absolute -inset-16 bg-[conic-gradient(from_90deg,#22d3ee_5deg,#38bdf8_63deg,#2563eb_115deg,#0ea5e9_170deg,#22d3ee_220deg,#38bdf8_286deg,#22d3ee_360deg)] mix-blend-overlay blur-[50px] grayscale saturate-[2]" />
          </div>
        </div>

        <h1 className="text-center text-3xl leading-tight font-semibold text-wrap md:text-5xl">
          Find the perfect plan for you.
        </h1>
        <p className="text-center text-xl text-pretty text-muted-foreground">
          Simple and transparent pricing. No hidden fees, no surprises.
        </p>
      </div>
      <div className="relative flex w-full flex-col items-center">
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, var(--muted) 0px, var(--muted) 1px, transparent 1px, transparent 5px)",
          }}
        />
        <div className="absolute -top-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-6 rounded-full bg-secondary p-2 px-3">
          <span className="text-sm font-medium">Monthly</span>
          <Switch
            checked={isAnnual}
            onCheckedChange={setIsAnnual}
            aria-label="Annual pricing"
            className="scale-150"
            disabled={!isHydrated}
          />
          <span className="text-sm font-medium">Annual</span>
        </div>
        {upgradeSubscriptionMutation.error && (
          <div className="w-full border-x p-6">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>
                {upgradeSubscriptionMutation.error.message}
              </AlertDescription>
            </Alert>
          </div>
        )}
        <div className="flex w-full flex-col items-center md:flex-row">
          {plans.map((plan) => {
            const price = isAnnual
              ? plan.annualPriceInCents / 100
              : plan.monthlyPriceInCents / 100;
            const lookupKey = isAnnual
              ? plan.annualPriceLookupKey
              : plan.monthlyPriceLookupKey;
            return (
              <div
                key={plan.name}
                className="group relative flex aspect-square h-full w-full flex-col items-center justify-center gap-4 overflow-hidden border-l p-6 not-sm:border-r"
              >
                <h1 className="text-center text-2xl leading-tight font-semibold text-wrap lg:text-3xl">
                  {plan.displayName}
                </h1>
                <p className="text-center text-2xl leading-tight font-medium text-wrap lg:text-3xl">
                  {plan.description}
                </p>
                <div className="relative flex items-end">
                  <span className="text-4xl font-semibold">${price}</span>
                  <span className="text-2xl text-muted-foreground">
                    {isAnnual ? "/yr" : "/mo"}
                  </span>
                </div>
                <Button
                  onClick={() => {
                    upgradeSubscriptionMutation.reset();
                    upgradeSubscriptionMutation.mutate(lookupKey);
                  }}
                  disabled={
                    !isHydrated || upgradeSubscriptionMutation.isPending
                  }
                  className="mt-6 w-full rounded-full! text-base! font-semibold"
                  data-testid={plan.name}
                >
                  Get <span className="capitalize">{plan.name}</span>
                </Button>
                <svg
                  viewBox="0 0 39 39"
                  fill="none"
                  className="absolute -bottom-16 size-32 grayscale transition-all group-hover:scale-105 group-hover:grayscale-0"
                >
                  <path
                    d="M39 24H24V6H6V24H24V39H0V6H6V0H39V24Z"
                    fill="#81ADEC"
                  />
                </svg>
              </div>
            );
          })}
        </div>
      </div>
      <div className="relative flex w-full flex-col items-start justify-center gap-4 border border-t-0 p-12 py-16">
        <div className="absolute inset-4 -z-10">
          <svg
            className="pointer-events-none absolute inset-0 text-primary/10"
            width="100%"
            height="100%"
          >
            <defs>
              <pattern
                id="dots-_S_2_"
                x={-1}
                y={-1}
                width={12}
                height={12}
                patternUnits="userSpaceOnUse"
              >
                <rect x={1} y={1} width={2} height={2} fill="currentColor" />
              </pattern>
            </defs>
            <rect fill="url(#dots-_S_2_)" width="100%" height="100%" />
          </svg>
        </div>
        <h1 className="text-2xl leading-tight font-semibold text-wrap lg:text-3xl">
          Get started with TCES.
        </h1>
        <p className="text-2xl leading-normal font-medium text-wrap text-muted-foreground sm:max-w-[80%] lg:text-3xl">
          Build with{" "}
          <a
            href="https://ui.shadcn.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 256 256"
              fill="none"
              stroke="currentColor"
              strokeWidth={32}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-6 text-primary"
              aria-hidden="true"
            >
              <line x1="208" y1="128" x2="128" y2="208" />
              <line x1="192" y1="40" x2="40" y2="192" />
            </svg>
            <span className="font-semibold text-primary">Shadcn</span>
          </a>{" "}
          components on{" "}
          <a
            href="https://base-ui.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="24"
              viewBox="0 0 17 24"
              fill="currentColor"
              className="size-6 text-primary"
              aria-hidden="true"
            >
              <path d="M9.5001 7.01537C9.2245 6.99837 9 7.22385 9 7.49999V23C13.4183 23 17 19.4183 17 15C17 10.7497 13.6854 7.27351 9.5001 7.01537Z" />
              <path d="M8 9.8V12V23C3.58172 23 0 19.0601 0 14.2V12V1C4.41828 1 8 4.93989 8 9.8Z" />
            </svg>
            <span className="font-semibold text-primary">Base UI</span>
          </a>
          , authenticate users with{" "}
          <a
            href="https://www.better-auth.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <svg
              viewBox="69 121 361 259"
              fill="currentColor"
              className="size-6 text-primary"
              aria-hidden="true"
            >
              <path d="M69 121h86.988v259H69zM337.575 121H430v259h-92.425z" />
              <path d="M427.282 121v83.456h-174.52V121zM430 296.544V380H252.762v-83.456z" />
              <path d="M252.762 204.455v92.089h-96.774v-92.089z" />
            </svg>
            <span className="font-semibold text-primary">Better-Auth</span>
          </a>
          , monetize through{" "}
          <a
            href="https://stripe.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <span className="inline-flex items-center gap-1.5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 32 32"
                className="size-6 text-primary"
                fill="currentColor"
              >
                <path
                  d="M111.328 15.602c0-4.97-2.415-8.9-7.013-8.9s-7.423 3.924-7.423 8.863c0 5.85 3.32 8.8 8.036 8.8 2.318 0 4.06-.528 5.377-1.26V19.22a10.246 10.246 0 0 1-4.764 1.075c-1.9 0-3.556-.67-3.774-2.943h9.497a39.64 39.64 0 0 0 .063-1.748zm-9.606-1.835c0-2.186 1.35-3.1 2.56-3.1s2.454.906 2.454 3.1zM89.4 6.712a5.434 5.434 0 0 0-3.801 1.509l-.254-1.208h-4.27v22.64l4.85-1.032v-5.488a5.434 5.434 0 0 0 3.444 1.265c3.472 0 6.64-2.792 6.64-8.957.003-5.66-3.206-8.73-6.614-8.73zM88.23 20.1a2.898 2.898 0 0 1-2.288-.906l-.03-7.2a2.928 2.928 0 0 1 2.315-.96c1.775 0 2.998 2 2.998 4.528.003 2.593-1.198 4.546-2.995 4.546zM79.25.57l-4.87 1.035v3.95l4.87-1.032z"
                  fillRule="evenodd"
                />
                <path d="M74.38 7.035h4.87V24.04h-4.87z" />
                <path
                  d="M69.164 8.47l-.302-1.434h-4.196V24.04h4.848V12.5c1.147-1.5 3.082-1.208 3.698-1.017V7.038c-.646-.232-2.913-.658-4.048 1.43zm-9.73-5.646L54.698 3.83l-.02 15.562c0 2.87 2.158 4.993 5.038 4.993 1.585 0 2.756-.302 3.405-.643v-3.95c-.622.248-3.683 1.138-3.683-1.72v-6.9h3.683V7.035h-3.683zM46.3 11.97c0-.758.63-1.05 1.648-1.05a10.868 10.868 0 0 1 4.83 1.25V7.6a12.815 12.815 0 0 0-4.83-.888c-3.924 0-6.557 2.056-6.557 5.488 0 5.37 7.375 4.498 7.375 6.813 0 .906-.78 1.186-1.863 1.186-1.606 0-3.68-.664-5.307-1.55v4.63a13.461 13.461 0 0 0 5.307 1.117c4.033 0 6.813-1.992 6.813-5.485 0-5.796-7.417-4.76-7.417-6.943zM13.88 9.515c0-1.37 1.14-1.9 2.982-1.9A19.661 19.661 0 0 1 25.6 9.876v-8.27A23.184 23.184 0 0 0 16.862.001C9.762.001 5 3.72 5 9.93c0 9.716 13.342 8.138 13.342 12.326 0 1.638-1.4 2.146-3.37 2.146-2.905 0-6.657-1.202-9.6-2.802v8.378A24.353 24.353 0 0 0 14.973 32C22.27 32 27.3 28.395 27.3 22.077c0-10.486-13.42-8.613-13.42-12.56z"
                  fillRule="evenodd"
                />
              </svg>
              <span className="font-semibold text-primary">Stripe</span>
            </span>
          </a>
          , and productionize with{" "}
          <a
            href="https://effect.website/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <svg
              viewBox="0 0 32 32"
              fill="currentColor"
              className="size-6 text-primary"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M29.8022 24.317C30.2747 24.05 30.4361 23.4582 30.1636 22.9953C29.891 22.5329 29.2873 22.3741 28.8148 22.6411L15.9211 29.9362L3.07463 22.6683C2.60281 22.4012 1.999 22.5594 1.72597 23.0225C1.45347 23.4854 1.61541 24.077 2.08741 24.3441L15.3897 31.8698C15.5053 31.9353 15.6327 31.9771 15.7645 31.9929C15.8963 32.0087 16.0299 31.9981 16.1576 31.9617C16.278 31.9433 16.3941 31.9031 16.5002 31.8431L29.8022 24.317Z"
              />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M31.1298 16.6012C31.1974 16.1929 31.0061 15.7675 30.6177 15.5488L16.555 7.63105C16.4443 7.56873 16.3234 7.52682 16.198 7.50732C16.0631 7.46888 15.922 7.45758 15.7827 7.47405C15.6434 7.49053 15.5088 7.53446 15.3865 7.60332L1.32289 15.5214C0.913972 15.7518 0.723686 16.2117 0.824499 16.6391C0.780205 16.9913 0.91787 17.3598 1.32768 17.5916L15.3904 25.5478C15.5127 25.6169 15.6475 25.661 15.7869 25.6776C15.9263 25.6942 16.0675 25.6829 16.2026 25.6445C16.3297 25.6253 16.4522 25.583 16.5642 25.5197L30.6275 17.563C31.0408 17.329 31.1776 16.9562 31.1298 16.6012ZM28.2266 16.5591L15.9459 9.64453L3.67206 16.5554L15.9528 23.5034L28.2266 16.5591Z"
              />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M31.3429 10.6097C31.8677 10.3131 32.0476 9.65608 31.7442 9.14178C31.4416 8.62819 30.7712 8.45201 30.2464 8.74854L15.9269 16.8501L1.66063 8.77876C1.13584 8.48152 0.465408 8.65787 0.162793 9.172C-0.14053 9.68541 0.0391253 10.3432 0.564095 10.6397L15.337 18.9976C15.4654 19.0702 15.607 19.1165 15.7534 19.1339C15.8998 19.1514 16.0482 19.1395 16.19 19.0991C16.3236 19.0791 16.4524 19.0347 16.5701 18.9681L31.3429 10.6097Z"
              />
              <path d="M2.7403 9.6795L15.8991 1.62024L29.0577 9.67879L15.8989 17.2013L2.7403 9.6795Z" />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M31.3255 8.49027C31.8513 8.78627 32.0333 9.44279 31.7325 9.95692C31.4307 10.4707 30.7603 10.6474 30.2344 10.3514L15.9128 2.28787L1.64317 10.3224C1.11731 10.6184 0.44688 10.4415 0.145328 9.92794C-0.15587 9.41381 0.0262664 8.75729 0.55159 8.46129L15.325 0.143725C15.4534 0.0713274 15.5949 0.0251207 15.7412 0.00776107C15.8875 -0.00959854 16.0358 0.00223134 16.1775 0.0425706C16.3093 0.0631109 16.4364 0.107185 16.5526 0.172702L31.3255 8.49027Z"
              />
            </svg>
            <span className="font-semibold text-primary">Effect</span>
          </a>
          .
        </p>
      </div>
    </div>
  );
}
