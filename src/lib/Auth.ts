import type { Subscription as StripeSubscription } from "@better-auth/stripe";
import type { Auth as BetterAuth, BetterAuthOptions } from "better-auth";
import type {
  DefaultOrganizationPlugin,
  OrganizationOptions,
} from "better-auth/plugins";
import type { Stripe as StripeTypes } from "stripe";

import { stripe as stripePlugin } from "@better-auth/stripe";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, magicLink, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Config, Effect, Layer, Redacted, ServiceMap } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";

import { KV } from "./KV";
import { Repository } from "./Repository";
import { Request } from "./Request";
import { Stripe } from "./Stripe";

export type AuthInstance = ReturnType<typeof makeAuth>;

export class Auth extends ServiceMap.Service<Auth>()("Auth", {
  make: Effect.gen(function* () {
    const services = yield* Effect.services<KV | Stripe | Repository>();
    const runEffect = Effect.runPromiseWith(services);
    const stripe = yield* Stripe;
    const authConfig = yield* Config.all({
      betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
      betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
      transactionalEmail: Config.nonEmptyString("TRANSACTIONAL_EMAIL"),
      stripeWebhookSecret: Config.redacted("STRIPE_WEBHOOK_SECRET"),
    });
    const { D1: database, ORGANIZATION_AGENT: organizationAgent, Q: queue } =
      yield* CloudflareEnv;

    const auth = makeAuth({
      database,
      organizationAgent,
      queue,
      stripeClient: stripe.stripe,
      runEffect,
      ...authConfig,
    });
    const handler = Effect.fn("auth.handler")(function* (request: Request) {
      return yield* Effect.tryPromise(() => auth.handler(request));
    });
    const getSession = Effect.fn("auth.getSession")(function* (
      headers: Headers,
    ) {
      return Option.fromNullishOr(
        yield* Effect.tryPromise(() => auth.api.getSession({ headers })),
      );
    });

    return {
      auth,
      api: auth.api,
      handler,
      getSession,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const makeAuth = ({
  database,
  organizationAgent,
  queue,
  stripeClient,
  runEffect,
  betterAuthUrl,
  betterAuthSecret,
  transactionalEmail,
  stripeWebhookSecret,
}: {
  database: D1Database;
  organizationAgent: Env["ORGANIZATION_AGENT"];
  queue: Env["Q"];
  stripeClient: StripeTypes;
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, KV | Stripe | Repository>,
  ) => Promise<A>;
  betterAuthUrl: string;
  betterAuthSecret: Redacted.Redacted;
  transactionalEmail: string;
  stripeWebhookSecret: Redacted.Redacted;
}) => {
  // This is a late-bound Better Auth API reference used only inside the auth
  // options object. `auth` is created from `options`, so closing over `auth`
  // directly here creates a type cycle and causes Better Auth plugin inference
  // to collapse. Typing only the organization plugin's `createOrganization`
  // API keeps the reference narrow and breaks that cycle.
  let organizationApiCreate = null as unknown as BetterAuth<
    BetterAuthOptions & {
      plugins: [DefaultOrganizationPlugin<OrganizationOptions>];
    }
  >["api"]["createOrganization"];
  const options = {
    baseURL: betterAuthUrl,
    secret: Redacted.value(betterAuthSecret),
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    database,
    user: { modelName: "User" },
    session: { modelName: "Session", storeSessionInDatabase: true },
    account: {
      modelName: "Account",
      accountLinking: { enabled: true },
    },
    verification: { modelName: "Verification" },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: (user) =>
            runEffect(
              Effect.gen(function* () {
                if (user.role !== "user") return;
                yield* Effect.logInfo("databaseHooks.user.create.after", {
                  userId: user.id,
                  role: user.role,
                });
                const repository = yield* Repository;
                const org = yield* Effect.tryPromise(() =>
                  organizationApiCreate({
                    body: {
                      name: `${user.email.charAt(0).toUpperCase() + user.email.slice(1)}'s Organization`,
                      slug: user.email
                        .replaceAll(/[^a-z0-9]/g, "-")
                        .toLowerCase(),
                      userId: user.id,
                    },
                  }),
                );
                yield* Effect.logInfo("auth.organization.created", {
                  userId: user.id,
                  organizationId: org.id,
                });
                const organizationId = Schema.decodeUnknownSync(Domain.Organization.fields.id)(org.id);
                const userId = Schema.decodeUnknownSync(Domain.User.fields.id)(user.id);
                yield* repository.initializeActiveOrganizationForUserSessions({
                  organizationId,
                  userId,
                });
                const id = organizationAgent.idFromName(organizationId);
                const stub = organizationAgent.get(id);
                yield* Effect.tryPromise(() => stub.setName(organizationId));
                yield* Effect.tryPromise(() =>
                  queue.send({
                    action: "FinalizeMembershipSync" as const,
                    organizationId,
                    userId,
                    change: "added" as const,
                  }),
                );
                yield* Effect.tryPromise(() =>
                  stub.syncMembership({ userId, change: "added" }),
                );
              }),
            ),
        },
      },
      session: {
        create: {
          before: (session) =>
            runEffect(
              Effect.gen(function* () {
                yield* Effect.logDebug("databaseHooks.session.create.before", {
                  sessionId: session.id,
                  userId: session.userId,
                });
                const repository = yield* Repository;
                const activeOrganization =
                  yield* repository.getOwnerOrganizationByUserId(
                    Schema.decodeUnknownSync(Domain.User.fields.id)(session.userId),
                  );
                return {
                  data: {
                    ...session,
                    activeOrganizationId: activeOrganization.pipe(
                      Option.map((organization) => organization.id),
                      Option.getOrUndefined,
                    ),
                  },
                };
              }),
            ),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware((ctx) =>
        runEffect(
          Effect.gen(function* () {
            if (
              ctx.path === "/subscription/upgrade" ||
              ctx.path === "/subscription/billing-portal" ||
              ctx.path === "/subscription/cancel-subscription"
            ) {
              yield* Effect.logInfo(
                "hooks.before.ensureBillingPortalConfiguration",
                {
                  path: ctx.path,
                },
              );
              const stripe = yield* Stripe;
              yield* stripe.ensureBillingPortalConfiguration();
            }
          }),
        ),
      ),
    },
    plugins: [
      magicLink({
        storeToken: "hashed",
        sendMagicLink: (data) =>
          runEffect(
            Effect.gen(function* () {
              yield* Effect.logInfo("sendMagicLink", {
                email: data.email,
                url: data.url,
              });
              const kvService = yield* KV;
              yield* kvService.put("demo:magicLink", data.url, {
                expirationTtl: 60,
              });
              yield* Effect.logInfo("magicLink.email.simulation", {
                to: data.email,
                subject: "Your Magic Link",
                from: transactionalEmail,
              });
            }),
          ),
      }),
      admin(),
      organization({
        organizationLimit: 1,
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        schema: {
          organization: { modelName: "Organization" },
          member: { modelName: "Member" },
          invitation: { modelName: "Invitation" },
        },
        sendInvitationEmail: (data) =>
          runEffect(
            Effect.logInfo("organization.invitation.email.simulation", {
              email: data.email,
              from: transactionalEmail,
              subject: "You're invited!",
              url: `${betterAuthUrl}/accept-invitation/${data.id}`,
            }),
          ),
      }),
      stripePlugin({
        stripeClient: stripeClient,
        stripeWebhookSecret: Redacted.value(stripeWebhookSecret),
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          requireEmailVerification: true,
          plans: () =>
            runEffect(
              Effect.gen(function* () {
                const stripe = yield* Stripe;
                return (yield* stripe.getPlans()).map((plan) => ({
                  name: plan.name,
                  priceId: plan.monthlyPriceId,
                  annualDiscountPriceId: plan.annualPriceId,
                  freeTrial: {
                    days: plan.freeTrialDays,
                    onTrialStart: (subscription: StripeSubscription) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialStart", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }),
                      ),
                    onTrialEnd: ({
                      subscription,
                    }: {
                      subscription: StripeSubscription;
                    }) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialEnd", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }),
                      ),
                    onTrialExpired: (subscription: StripeSubscription) =>
                      runEffect(
                        Effect.logInfo("stripe.subscription.onTrialExpired", {
                          planName: plan.name,
                          subscriptionId: subscription.id,
                        }),
                      ),
                  },
                }));
              }),
            ),
          authorizeReference: ({ user, referenceId, action }) =>
            runEffect(
              Effect.gen(function* () {
                const repository = yield* Repository;
                const member = yield* repository.getMemberByUserAndOrg({
                  userId: Schema.decodeUnknownSync(Domain.User.fields.id)(user.id),
                  organizationId: Schema.decodeUnknownSync(
                    Domain.Organization.fields.id,
                  )(referenceId),
                });
                const result =
                  Option.isSome(member) && member.value.role === "owner";
                yield* Effect.logDebug(
                  "stripe.subscription.authorizeReference",
                  {
                    userId: user.id,
                    referenceId,
                    action,
                    authorized: result,
                  },
                );
                return result;
              }),
            ),
          onSubscriptionComplete: ({ subscription, plan }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionComplete", {
                subscriptionId: subscription.id,
                planName: plan.name,
              }),
            ),
          onSubscriptionUpdate: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionUpdate", {
                subscriptionId: subscription.id,
              }),
            ),
          onSubscriptionCancel: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionCancel", {
                subscriptionId: subscription.id,
              }),
            ),
          onSubscriptionDeleted: ({ subscription }) =>
            runEffect(
              Effect.logInfo("stripe.subscription.onSubscriptionDeleted", {
                subscriptionId: subscription.id,
              }),
            ),
        },
        organization: {
          enabled: true,
          getCustomerCreateParams: (_organization, ctx) => {
            const userEmail = ctx.context.session?.user.email;
            return Promise.resolve(userEmail ? { email: userEmail } : {});
          },
        },
        schema: {
          subscription: {
            modelName: "Subscription",
          },
        },
        onCustomerCreate: ({ stripeCustomer, user }) =>
          runEffect(
            Effect.logInfo("stripe.onCustomerCreate", {
              stripeCustomerId: stripeCustomer.id,
              userEmail: user.email,
            }),
          ),
        onEvent: (event) =>
          runEffect(Effect.logInfo("stripe.onEvent", { type: event.type })),
      }),
      tanstackStartCookies(),
    ],
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);
  organizationApiCreate = auth.api.createOrganization;
  return auth;
};

export const signOutServerFn = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        yield* Effect.tryPromise(() =>
          auth.api.signOut({ headers: request.headers }),
        );
        return yield* Effect.die(redirect({ to: "/" }));
      }),
    ),
);
