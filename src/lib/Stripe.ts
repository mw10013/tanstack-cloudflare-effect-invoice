import type { Stripe as StripeTypes } from "stripe";

import type { Plan } from "@/lib/Domain";

import { Config, Effect, Layer, Redacted, ServiceMap } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as StripeClient from "stripe";

import { planData, Plan as PlanSchema } from "@/lib/Domain";
import { KV } from "@/lib/KV";

type Price = StripeTypes.Price;
type PriceWithLookupKey = Price & { lookup_key: string };

const isPriceWithLookupKey = (price: Price): price is PriceWithLookupKey =>
  price.lookup_key !== null;

const requirePriceWithLookupKey = (price: Price) =>
  price.lookup_key === null
    ? failStripe("Missing lookup_key")
    : Effect.succeed(price);

export class Stripe extends ServiceMap.Service<Stripe>()("Stripe", {
  make: Effect.gen(function* () {
    const stripeSecretKey = yield* Config.redacted("STRIPE_SECRET_KEY");
    const kv = yield* KV;
    const stripe = new StripeClient.Stripe(Redacted.value(stripeSecretKey), {
      apiVersion: "2025-10-29.clover",
    });

    const getPrices = Effect.fn("Stripe.getPrices")(function* () {
      const lookupKeys = planData.flatMap((plan) => [
        plan.monthlyPriceLookupKey,
        plan.annualPriceLookupKey,
      ]);
      const priceList = yield* tryStripe(() =>
        stripe.prices.list({
          lookup_keys: lookupKeys,
          expand: ["data.product"],
        }),
      );
      if (priceList.data.length === 0) {
        const products = yield* Effect.all(
          planData.map((plan) =>
            tryStripe(() =>
              stripe.products.create({
                name: plan.displayName,
                description: `${plan.displayName} plan.`,
              }),
            ).pipe(Effect.map((product) => ({ plan, product }))),
          ),
        );
        const prices = yield* Effect.all(
          products.flatMap(({ plan, product }) => [
            tryStripe(() =>
              stripe.prices.create({
                product: product.id,
                unit_amount: plan.monthlyPriceInCents,
                currency: "usd",
                recurring: { interval: "month" },
                lookup_key: plan.monthlyPriceLookupKey,
                expand: ["product"],
              }),
            ),
            tryStripe(() =>
              stripe.prices.create({
                product: product.id,
                unit_amount: plan.annualPriceInCents,
                currency: "usd",
                recurring: { interval: "year" },
                lookup_key: plan.annualPriceLookupKey,
                expand: ["product"],
              }),
            ),
          ]),
        );
        return yield* Effect.all(prices.map(requirePriceWithLookupKey));
      }
      const prices = priceList.data.filter(isPriceWithLookupKey);
      if (prices.length !== planData.length * 2) {
        return yield* failStripe(
          `Count of prices not ${String(planData.length * 2)} (${String(prices.length)})`,
        );
      }
      return prices;
    });

    const getPlans = Effect.fn("Stripe.getPlans")(function* () {
      const key = "stripe:plans";
      const cachedPlans = yield* kv.getJson(key);
      if (cachedPlans) {
        const parseResult = Schema.decodeUnknownOption(
          Schema.Array(PlanSchema),
        )(cachedPlans);
        if (Option.isSome(parseResult)) {
          yield* Effect.logInfo("stripe.getPlans.cacheHit");
          return [...parseResult.value] as readonly Plan[];
        }
      }
      yield* Effect.logInfo("stripe.getPlans.cacheMiss");
      const prices = yield* getPrices();
      const plans = yield* Effect.all(
        planData.map((plan) =>
          Effect.gen(function* () {
            const monthlyPrice = prices.find(
              (price) => price.lookup_key === plan.monthlyPriceLookupKey,
            );
            if (!monthlyPrice) {
              return yield* failStripe(
                `Missing monthly price for ${plan.name}`,
              );
            }
            if (typeof monthlyPrice.product === "string") {
              return yield* failStripe("Product should be expanded");
            }
            const annualPrice = prices.find(
              (price) => price.lookup_key === plan.annualPriceLookupKey,
            );
            if (!annualPrice) {
              return yield* failStripe(`Missing annual price for ${plan.name}`);
            }
            return {
              name: plan.name,
              displayName: plan.displayName,
              description: plan.description,
              productId: monthlyPrice.product.id,
              monthlyPriceId: monthlyPrice.id,
              monthlyPriceLookupKey: plan.monthlyPriceLookupKey,
              monthlyPriceInCents: plan.monthlyPriceInCents,
              annualPriceId: annualPrice.id,
              annualPriceLookupKey: plan.annualPriceLookupKey,
              annualPriceInCents: plan.annualPriceInCents,
              freeTrialDays: plan.freeTrialDays,
            };
          }),
        ),
      );
      yield* kv.put(key, JSON.stringify(plans));
      return plans as readonly Plan[];
    });

    const ensureBillingPortalConfiguration = Effect.fn(
      "Stripe.ensureBillingPortalConfiguration",
    )(function* () {
      const key = "stripe:isBillingPortalConfigured";
      const isConfigured = yield* kv.get(key);
      if (isConfigured === "true") return;
      const configurations = yield* tryStripe(() =>
        stripe.billingPortal.configurations.list({
          limit: 2,
        }),
      );
      if (configurations.data.length === 0) {
        const plans = yield* getPlans();
        const basicPlan = plans.find((plan) => plan.name === "basic");
        if (!basicPlan) {
          return yield* failStripe("Missing basic plan");
        }
        const proPlan = plans.find((plan) => plan.name === "pro");
        if (!proPlan) {
          return yield* failStripe("Missing pro plan");
        }
        yield* tryStripe(() =>
          stripe.billingPortal.configurations.create({
            business_profile: {
              headline: "Manage your subscription and billing information",
            },
            features: {
              customer_update: {
                enabled: true,
                allowed_updates: ["name", "phone"],
              },
              invoice_history: {
                enabled: true,
              },
              payment_method_update: {
                enabled: true,
              },
              subscription_cancel: {
                enabled: true,
                mode: "immediately",
                proration_behavior: "create_prorations",
              },
              subscription_update: {
                enabled: true,
                default_allowed_updates: ["price"],
                proration_behavior: "create_prorations",
                products: [
                  {
                    product: basicPlan.productId,
                    prices: [basicPlan.monthlyPriceId, basicPlan.annualPriceId],
                  },
                  {
                    product: proPlan.productId,
                    prices: [proPlan.monthlyPriceId, proPlan.annualPriceId],
                  },
                ],
              },
            },
          }),
        );
        yield* Effect.logInfo(
          "stripe.ensureBillingPortalConfiguration.created",
        );
      } else {
        if (configurations.data.length > 1) {
          yield* Effect.logWarning(
            "stripe.ensureBillingPortalConfiguration.multipleConfigurations",
            { count: configurations.data.length },
          );
        }
        yield* kv.put(key, "true");
      }
    });

    return {
      stripe,
      getPlans,
      ensureBillingPortalConfiguration,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

/** Optional cause: mixed-origin error — wraps rejections (tryStripe) and direct failures (failStripe). */
export class StripeError extends Schema.TaggedErrorClass<StripeError>()(
  "StripeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const tryStripe = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new StripeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));

const failStripe = (message: string) =>
  Effect.fail(new StripeError({ message }));
