import { env } from "cloudflare:workers";
import { Effect, Layer, Option, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { expect } from "vitest";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { D1 } from "@/lib/D1";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

const envLayer = Layer.succeedServices(ServiceMap.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);

const seedUser = Effect.fn("seed.user")(function* (overrides?: {
  id?: Domain.User["id"];
  name?: Domain.User["name"];
  email?: Domain.User["email"];
  role?: Domain.UserRole;
  emailVerified?: Domain.User["emailVerified"];
  stripeCustomerId?: Domain.User["stripeCustomerId"];
}) {
  const d1 = yield* D1;
  const id = overrides?.id ?? Schema.decodeUnknownSync(Domain.User.fields.id)(crypto.randomUUID());
  const email = overrides?.email ?? `${id}@test.com`;
  const stripeCustomerId = overrides?.stripeCustomerId ?? null;
  yield* d1.run(
    d1.prepare(
      "insert into User (id, name, email, role, emailVerified, stripeCustomerId) values (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(
      id,
      overrides?.name ?? "Test User",
      email,
      overrides?.role ?? "user",
      overrides?.emailVerified ? 1 : 0,
      stripeCustomerId,
    ),
  );
  return { id, email, stripeCustomerId };
});

const seedOrganization = Effect.fn("seed.organization")(function* (overrides?: {
  id?: Domain.Organization["id"];
  name?: Domain.Organization["name"];
  slug?: Domain.Organization["slug"];
}) {
  const d1 = yield* D1;
  const id = overrides?.id ?? Schema.decodeUnknownSync(Domain.Organization.fields.id)(crypto.randomUUID());
  yield* d1.run(
    d1.prepare(
      "insert into Organization (id, name, slug) values (?1, ?2, ?3)",
    ).bind(id, overrides?.name ?? "Test Org", overrides?.slug ?? `org-${id.slice(0, 8)}`),
  );
  return { id };
});

const seedMember = Effect.fn("seed.member")(function* ({
  userId,
  organizationId,
  role,
}: {
  userId: Domain.Member["userId"];
  organizationId: Domain.Member["organizationId"];
  role: Domain.MemberRole;
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Member.fields.id)(crypto.randomUUID());
  yield* d1.run(
    d1.prepare(
      "insert into Member (id, userId, organizationId, role) values (?1, ?2, ?3, ?4)",
    ).bind(id, userId, organizationId, role),
  );
  return { id };
});

const seedSession = Effect.fn("seed.session")(function* ({
  userId,
  expiresAt,
  activeOrganizationId,
}: {
  userId: Domain.Session["userId"];
  expiresAt: string;
  activeOrganizationId?: Domain.Session["activeOrganizationId"];
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Session.fields.id)(crypto.randomUUID());
  const token = crypto.randomUUID();
  yield* d1.run(
    d1.prepare(
      "insert into Session (id, expiresAt, token, userId, activeOrganizationId) values (?1, ?2, ?3, ?4, ?5)",
    ).bind(id, expiresAt, token, userId, activeOrganizationId ?? null),
  );
  return { id, token };
});

const seedInvitation = Effect.fn("seed.invitation")(function* ({
  email,
  inviterId,
  organizationId,
  role,
  status,
}: {
  email: Domain.Invitation["email"];
  inviterId: Domain.Invitation["inviterId"];
  organizationId: Domain.Invitation["organizationId"];
  role: Domain.MemberRole;
  status: Domain.InvitationStatus;
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Invitation.fields.id)(crypto.randomUUID());
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 604_800_000).toISOString();
  yield* d1.run(
    d1.prepare(
      "insert into Invitation (id, email, inviterId, organizationId, role, status, createdAt, expiresAt) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(id, email, inviterId, organizationId, role, status, now, expiresAt),
  );
  return { id };
});

const seedSubscription = Effect.fn("seed.subscription")(function* ({
  referenceId,
  stripeCustomerId,
  status,
  plan,
}: {
  referenceId: Domain.Subscription["referenceId"];
  stripeCustomerId?: Domain.Subscription["stripeCustomerId"];
  status: Domain.SubscriptionStatus;
  plan?: Domain.Subscription["plan"];
}) {
  const d1 = yield* D1;
  const id = Schema.decodeUnknownSync(Domain.Subscription.fields.id)(crypto.randomUUID());
  yield* d1.run(
    d1.prepare(
      "insert into Subscription (id, plan, referenceId, stripeCustomerId, status, cancelAtPeriodEnd) values (?1, ?2, ?3, ?4, ?5, 0)",
    ).bind(id, plan ?? "basic", referenceId, stripeCustomerId ?? null, status),
  );
  return { id };
});

layer(repositoryLayer)("Repository", (it) => {
  it.effect("getUser — existing user", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const result = yield* repo.getUser("a@a.com");
      const user = Option.getOrThrow(result);
      expect(user.email).toBe("a@a.com");
      expect(user.role).toBe("admin");
    }));

  it.effect("getUser — nonexistent", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const result = yield* repo.getUser("nonexistent@test.com");
      expect(Option.isNone(result)).toBe(true);
    }));

  it.effect("getMemberByUserAndOrg — found", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "admin" });
      const result = yield* repo.getMemberByUserAndOrg({
        userId: user.id,
        organizationId: org.id,
      });
      const member = Option.getOrThrow(result);
      expect(member.userId).toBe(user.id);
      expect(member.organizationId).toBe(org.id);
      expect(member.role).toBe("admin");
    }));

  it.effect("getMemberByUserAndOrg — wrong org", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "member" });
      const result = yield* repo.getMemberByUserAndOrg({
        userId: user.id,
        organizationId: Schema.decodeUnknownSync(Domain.Organization.fields.id)("nonexistent"),
      });
      expect(Option.isNone(result)).toBe(true);
    }));

  it.effect("getOwnerOrganizationByUserId — user is owner", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });
      const result = yield* repo.getOwnerOrganizationByUserId(user.id);
      const organization = Option.getOrThrow(result);
      expect(organization.id).toBe(org.id);
    }));

  it.effect("getOwnerOrganizationByUserId — user is member not owner", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "member" });
      const result = yield* repo.getOwnerOrganizationByUserId(user.id);
      expect(Option.isNone(result)).toBe(true);
    }));

  it.effect("getOwnerOrganizationByUserId — no memberships", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const result = yield* repo.getOwnerOrganizationByUserId(user.id);
      expect(Option.isNone(result)).toBe(true);
    }));

  it.effect("initializeActiveOrganizationForUserSessions — backfills null", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });
      const session = yield* seedSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      yield* repo.initializeActiveOrganizationForUserSessions({
        organizationId: org.id,
        userId: user.id,
      });
      const d1 = yield* D1;
      const row = yield* d1.first<{ activeOrganizationId: string }>(
        d1.prepare("select activeOrganizationId from Session where id = ?1")
          .bind(session.id),
      );
      expect(Option.getOrThrow(row).activeOrganizationId).toBe(org.id);
    }));

  it.effect("initializeActiveOrganizationForUserSessions — does not overwrite existing", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org1 = yield* seedOrganization();
      const org2 = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org1.id, role: "owner" });
      yield* seedMember({ userId: user.id, organizationId: org2.id, role: "owner" });
      const session = yield* seedSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        activeOrganizationId: org1.id,
      });
      yield* repo.initializeActiveOrganizationForUserSessions({
        organizationId: org2.id,
        userId: user.id,
      });
      const d1 = yield* D1;
      const row = yield* d1.first<{ activeOrganizationId: string }>(
        d1.prepare("select activeOrganizationId from Session where id = ?1")
          .bind(session.id),
      );
      expect(Option.getOrThrow(row).activeOrganizationId).toBe(org1.id);
    }));

  it.effect("getUsers — returns all users with count", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const u1 = yield* seedUser({ email: "aaa@getusers.com" });
      const u2 = yield* seedUser({ email: "bbb@getusers.com" });
      const result = yield* repo.getUsers({ limit: 100, offset: 0 });
      expect(result.count).toBeGreaterThanOrEqual(3);
      const emails = result.users.map((u) => u.email);
      expect(emails).toContain("a@a.com");
      expect(emails).toContain(u1.email);
      expect(emails).toContain(u2.email);
    }));

  it.effect("getUsers — search filters by email", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      yield* seedUser({ email: `${tag}-match@search.com` });
      yield* seedUser({ email: `other@nomatch.com` });
      const result = yield* repo.getUsers({ limit: 100, offset: 0, searchValue: tag });
      expect(result.count).toBe(1);
      expect(result.users[0]?.email).toContain(tag);
    }));

  it.effect("getUsers — pagination", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      yield* seedUser({ email: `${tag}-a@page.com` });
      yield* seedUser({ email: `${tag}-b@page.com` });
      const page1 = yield* repo.getUsers({ limit: 1, offset: 0, searchValue: tag });
      const page2 = yield* repo.getUsers({ limit: 1, offset: 1, searchValue: tag });
      expect(page1.users).toHaveLength(1);
      expect(page2.users).toHaveLength(1);
      expect(page1.users[0]?.email).not.toBe(page2.users[0]?.email);
      expect(page1.count).toBe(2);
    }));

  it.effect("getAppDashboardData — with invitations and members", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const inviter = yield* seedUser();
      const invitee = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: inviter.id, organizationId: org.id, role: "owner" });
      yield* seedMember({ userId: invitee.id, organizationId: org.id, role: "member" });
      yield* seedInvitation({
        email: "new@test.com",
        inviterId: inviter.id,
        organizationId: org.id,
        role: "member",
        status: "pending",
      });
      yield* seedInvitation({
        email: "new@test.com",
        inviterId: inviter.id,
        organizationId: org.id,
        role: "member",
        status: "accepted",
      });
      const result = yield* repo.getAppDashboardData({
        userEmail: "new@test.com",
        organizationId: org.id,
      });
      expect(result.memberCount).toBe(2);
      expect(result.pendingInvitationCount).toBe(1);
      expect(result.userInvitations).toHaveLength(1);
      const invitation = result.userInvitations[0];
      expect(invitation?.status).toBe("pending");
      expect(invitation?.organization.id).toBe(org.id);
      expect(invitation?.inviter.id).toBe(inviter.id);
    }));

  it.effect("getAppDashboardData — no invitations", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });
      const result = yield* repo.getAppDashboardData({
        userEmail: user.email,
        organizationId: org.id,
      });
      expect(result.memberCount).toBe(1);
      expect(result.pendingInvitationCount).toBe(0);
      expect(result.userInvitations).toHaveLength(0);
    }));

  it.effect("getAdminDashboardData — counts customers and subscriptions", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user1 = yield* seedUser({ stripeCustomerId: `cus_${crypto.randomUUID()}` });
      const user2 = yield* seedUser({ stripeCustomerId: `cus_${crypto.randomUUID()}` });
      const org1 = yield* seedOrganization();
      const org2 = yield* seedOrganization();
      yield* seedSubscription({ referenceId: org1.id, stripeCustomerId: user1.stripeCustomerId, status: "active" });
      yield* seedSubscription({ referenceId: org2.id, stripeCustomerId: user2.stripeCustomerId, status: "trialing" });
      const result = yield* repo.getAdminDashboardData();
      expect(result.customerCount).toBeGreaterThanOrEqual(2);
      expect(result.activeSubscriptionCount).toBeGreaterThanOrEqual(1);
      expect(result.trialingSubscriptionCount).toBeGreaterThanOrEqual(1);
    }));

  it.effect("getCustomers — with and without subscription", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      const custId = `cus_${crypto.randomUUID()}`;
      const withSub = yield* seedUser({
        email: `${tag}-sub@cust.com`,
        stripeCustomerId: custId,
      });
      const org = yield* seedOrganization();
      yield* seedSubscription({ referenceId: org.id, stripeCustomerId: custId, status: "active" });
      yield* seedUser({ email: `${tag}-nosub@cust.com` });
      const result = yield* repo.getCustomers({ limit: 100, offset: 0, searchValue: tag });
      expect(result.count).toBe(2);
      const withSubCustomer = result.customers.find((c) => c.id === withSub.id);
      expect(withSubCustomer?.subscription).not.toBeNull();
      expect(withSubCustomer?.subscription?.status).toBe("active");
      const noSubCustomer = result.customers.find((c) => c.id !== withSub.id);
      expect(noSubCustomer?.subscription).toBeNull();
    }));

  it.effect("getCustomers — excludes admin users", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const result = yield* repo.getCustomers({ limit: 100, offset: 0, searchValue: "a@a.com" });
      expect(result.count).toBe(0);
    }));

  it.effect("getSubscriptions — joins subscription with user", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      const custId = `cus_${crypto.randomUUID()}`;
      const user = yield* seedUser({
        email: `${tag}@subs.com`,
        stripeCustomerId: custId,
      });
      const org = yield* seedOrganization();
      yield* seedSubscription({ referenceId: org.id, stripeCustomerId: custId, status: "active" });
      const result = yield* repo.getSubscriptions({ limit: 100, offset: 0, searchValue: tag });
      expect(result.count).toBe(1);
      const sub = result.subscriptions[0];
      expect(sub?.user.id).toBe(user.id);
      expect(sub?.status).toBe("active");
    }));

  it.effect("getSessions — joins session with user", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      const user = yield* seedUser({ email: `${tag}@sess.com` });
      yield* seedSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const result = yield* repo.getSessions({ limit: 100, offset: 0, searchValue: tag });
      expect(result.count).toBe(1);
      const sess = result.sessions[0];
      expect(sess?.user.id).toBe(user.id);
      expect(sess?.userId).toBe(user.id);
    }));

  it.effect("getSessions — pagination", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const tag = crypto.randomUUID().slice(0, 8);
      const user = yield* seedUser({ email: `${tag}@sessp.com` });
      yield* seedSession({ userId: user.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      yield* seedSession({ userId: user.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      const page1 = yield* repo.getSessions({ limit: 1, offset: 0, searchValue: tag });
      const page2 = yield* repo.getSessions({ limit: 1, offset: 1, searchValue: tag });
      expect(page1.sessions).toHaveLength(1);
      expect(page2.sessions).toHaveLength(1);
      expect(page1.count).toBe(2);
    }));

  it.effect("updateInvitationRole — updates role", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const org = yield* seedOrganization();
      yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });
      const invitation = yield* seedInvitation({
        email: "invitee@test.com",
        inviterId: user.id,
        organizationId: org.id,
        role: "member",
        status: "pending",
      });
      yield* repo.updateInvitationRole({ invitationId: invitation.id, role: "admin" });
      const d1 = yield* D1;
      const row = yield* d1.first<{ role: string }>(
        d1.prepare("select role from Invitation where id = ?1")
          .bind(invitation.id),
      );
      expect(Option.getOrThrow(row).role).toBe("admin");
    }));

  it.effect("deleteExpiredSessions — deletes expired, keeps valid", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      const expired = yield* seedSession({
        userId: user.id,
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      const valid = yield* seedSession({
        userId: user.id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const deletedCount = yield* repo.deleteExpiredSessions();
      expect(deletedCount).toBeGreaterThanOrEqual(1);
      const d1 = yield* D1;
      const expiredRow = yield* d1.first(
        d1.prepare("select id from Session where id = ?1").bind(expired.id),
      );
      expect(Option.isNone(expiredRow)).toBe(true);
      const validRow = yield* d1.first(
        d1.prepare("select id from Session where id = ?1").bind(valid.id),
      );
      expect(Option.isSome(validRow)).toBe(true);
    }));

  it.effect("deleteExpiredSessions — returns 0 when none expired", () =>
    Effect.gen(function* () {
      const repo = yield* Repository;
      const user = yield* seedUser();
      yield* seedSession({
        userId: user.id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const deletedCount = yield* repo.deleteExpiredSessions();
      expect(deletedCount).toBe(0);
    }));
});
