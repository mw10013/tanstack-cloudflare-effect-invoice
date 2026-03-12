import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Domain schemas and inferred types for the application.
 * Each Zod schema is exported in PascalCase, followed by its inferred type with the same name.
 *
 * Schemas must align with corresponding database tables especially code tables for roles and statuses.
 */

const intToBoolean = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (num) => num !== 0,
      encode: (bool) => (bool ? 1 : 0),
    }),
  ),
);

/**
 * Custom codec for ISO datetime strings. Can't use z.iso() because it expects 'T' separator,
 * but SQLite supports ISO strings without 'T' (e.g., "2023-01-01 12:00:00").
 */
const isoDatetimeToDate = Schema.String.pipe(
  Schema.decodeTo(
    Schema.DateValid,
    SchemaTransformation.transform({
      decode: (str) => new Date(str),
      encode: (date) => date.toISOString(),
    }),
  ),
);

const emailSchema = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

export const EnvironmentValues = ["production", "local"] as const;
export const Environment = Schema.Literals(EnvironmentValues);
export type Environment = typeof Environment.Type;

export const UserRoleValues = ["user", "admin"] as const;
export const UserRole = Schema.Literals(UserRoleValues);
export type UserRole = typeof UserRole.Type;

export const MemberRoleValues = ["member", "owner", "admin"] as const;
export const AssignableMemberRoleValues = ["member", "admin"] as const;
export const MemberRole = Schema.Literals(MemberRoleValues);
export type MemberRole = typeof MemberRole.Type;

export const InvitationStatusValues = [
  "pending",
  "accepted",
  "rejected",
  "canceled",
] as const;
export const InvitationStatus = Schema.Literals(InvitationStatusValues);
export type InvitationStatus = typeof InvitationStatus.Type;

/**
 * Subscription status values that must align with Stripe's Subscription.Status.
 */
export const SubscriptionStatusValues = [
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;
export const SubscriptionStatus = Schema.Literals(SubscriptionStatusValues);
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

export const Invitation = Schema.Struct({
  id: Schema.String,
  email: emailSchema,
  inviterId: Schema.String,
  organizationId: Schema.String,
  role: MemberRole,
  status: InvitationStatus,
  expiresAt: isoDatetimeToDate,
});
export type Invitation = typeof Invitation.Type;

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: emailSchema,
  emailVerified: intToBoolean,
  image: Schema.NullOr(Schema.String),
  role: UserRole,
  banned: intToBoolean,
  banReason: Schema.NullOr(Schema.String),
  banExpires: Schema.NullOr(isoDatetimeToDate),
  stripeCustomerId: Schema.NullOr(Schema.String),
  createdAt: isoDatetimeToDate,
  updatedAt: isoDatetimeToDate,
});
export type User = typeof User.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  expiresAt: isoDatetimeToDate,
  token: Schema.String,
  createdAt: isoDatetimeToDate,
  updatedAt: isoDatetimeToDate,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  userId: Schema.String,
  impersonatedBy: Schema.NullOr(Schema.String),
  activeOrganizationId: Schema.NullOr(Schema.String),
});
export type Session = typeof Session.Type;

export const Member = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  organizationId: Schema.String,
  role: MemberRole,
  createdAt: isoDatetimeToDate,
});
export type Member = typeof Member.Type;

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  logo: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Schema.String),
  createdAt: isoDatetimeToDate,
});
export type Organization = typeof Organization.Type;

export const planData = [
  // in display order
  {
    name: "basic", // lowercase to accomodate better-auth
    displayName: "Basic",
    description: "For personal use.",
    monthlyPriceInCents: 5000,
    monthlyPriceLookupKey: "basic-monthly",
    annualPriceInCents: Math.round(5000 * 12 * 0.8), // 20% discount for annual,
    annualPriceLookupKey: "basic-annual",
    freeTrialDays: 2,
  },
  {
    name: "pro",
    displayName: "Pro",
    description: "For professionals.",
    monthlyPriceInCents: 10000,
    monthlyPriceLookupKey: "pro-monthly",
    annualPriceInCents: Math.round(10000 * 12 * 0.8),
    annualPriceLookupKey: "pro-annual",
    freeTrialDays: 7,
  },
] as const;

export const Plan = Schema.Struct({
  name: Schema.NonEmptyString,
  displayName: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  productId: Schema.NonEmptyString,
  monthlyPriceId: Schema.NonEmptyString,
  monthlyPriceLookupKey: Schema.String,
  monthlyPriceInCents: Schema.Int,
  annualPriceId: Schema.NonEmptyString,
  annualPriceLookupKey: Schema.NonEmptyString,
  annualPriceInCents: Schema.Int,
  freeTrialDays: Schema.Int,
});
export type Plan = typeof Plan.Type;

export const Subscription = Schema.Struct({
  id: Schema.String,
  plan: Schema.NonEmptyString,
  referenceId: Schema.String,
  stripeCustomerId: Schema.NullOr(Schema.String),
  stripeSubscriptionId: Schema.NullOr(Schema.String),
  status: SubscriptionStatus,
  periodStart: Schema.NullOr(isoDatetimeToDate),
  periodEnd: Schema.NullOr(isoDatetimeToDate),
  cancelAtPeriodEnd: intToBoolean,
  cancelAt: Schema.NullOr(isoDatetimeToDate),
  canceledAt: Schema.NullOr(isoDatetimeToDate),
  endedAt: Schema.NullOr(isoDatetimeToDate),
  seats: Schema.NullOr(Schema.Int),
  billingInterval: Schema.NullOr(Schema.String),
  stripeScheduleId: Schema.NullOr(Schema.String),
  trialStart: Schema.NullOr(isoDatetimeToDate),
  trialEnd: Schema.NullOr(isoDatetimeToDate),
});
export type Subscription = typeof Subscription.Type;

export const UserWithSubscription = User.pipe(
  Schema.fieldsAssign({
    subscription: Schema.NullOr(Subscription),
  }),
);
export type UserWithSubscription = typeof UserWithSubscription.Type;

export const SubscriptionWithUser = Subscription.pipe(
  Schema.fieldsAssign({
    user: User,
  }),
);
export type SubscriptionWithUser = typeof SubscriptionWithUser.Type;

export const InvitationWithOrganizationAndInviter = Invitation.pipe(
  Schema.fieldsAssign({
    organization: Organization,
    inviter: User,
  }),
);
export type InvitationWithOrganizationAndInviter =
  typeof InvitationWithOrganizationAndInviter.Type;

export const SessionWithUser = Session.pipe(
  Schema.fieldsAssign({
    user: User,
  }),
);
export type SessionWithUser = typeof SessionWithUser.Type;
