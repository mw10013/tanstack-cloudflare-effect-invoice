import { Effect, Layer, Schema, ServiceMap } from "effect";

import { D1 } from "./D1";
import * as Domain from "./Domain";
import { JsonDataField } from "./SchemaEx";

export class Repository extends ServiceMap.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    const getUser = Effect.fn("Repository.getUser")(function* (
      email: Domain.User["email"],
    ) {
      const result = yield* d1.first(
        d1.prepare(`select * from User where email = ?1`).bind(email),
      );
      return yield* Effect.fromOption(result).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Domain.User)),
        Effect.catchNoSuchElement,
      );
    });
    const getMemberByUserAndOrg = Effect.fn("Repository.getMemberByUserAndOrg")(
      function* ({
        userId,
        organizationId,
      }: {
        userId: Domain.User["id"];
        organizationId: Domain.Organization["id"];
      }) {
        const result = yield* d1.first(
          d1
            .prepare(
              "select * from Member where userId = ?1 and organizationId = ?2",
            )
            .bind(userId, organizationId),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Domain.Member)),
          Effect.catchNoSuchElement,
        );
      },
    );
    const getMemberById = Effect.fn("Repository.getMemberById")(
      function* (memberId: Domain.Member["id"]) {
        const result = yield* d1.first(
          d1.prepare("select * from Member where id = ?1").bind(memberId),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Domain.Member)),
          Effect.catchNoSuchElement,
        );
      },
    );
    const getInvitation = Effect.fn("Repository.getInvitation")(
      function* (invitationId: Domain.Invitation["id"]) {
        const result = yield* d1.first(
          d1.prepare("select * from Invitation where id = ?1").bind(invitationId),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Domain.Invitation)),
          Effect.catchNoSuchElement,
        );
      },
    );
    const getOwnerOrganizationByUserId = Effect.fn(
      "Repository.getOwnerOrganizationByUserId",
    )(function* (userId: Domain.User["id"]) {
      const result = yield* d1.first(
        d1
          .prepare(
            "select o.* from Organization o where o.id in (select organizationId from Member where userId = ?1 and role = 'owner')",
          )
          .bind(userId),
      );
      return yield* Effect.fromOption(result).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Domain.Organization)),
        Effect.catchNoSuchElement,
      );
    });

    /**
     * Updates only sessions whose `activeOrganizationId` is still `null`.
     *
     * Better Auth runs `user.create.after` after the transaction that creates the user
     * and initial session, so this implementation backfills unset sessions without
     * overwriting already-selected organizations on existing sessions.
     */
    const initializeActiveOrganizationForUserSessions = Effect.fn(
      "Repository.initializeActiveOrganizationForUserSessions",
    )(function* ({
      organizationId,
      userId,
    }: {
      organizationId: Domain.Organization["id"];
      userId: Domain.User["id"];
    }) {
      return yield* d1.run(
        d1
          .prepare(
            "update Session set activeOrganizationId = ?1 where userId = ?2 and activeOrganizationId is null",
          )
          .bind(organizationId, userId),
        { idempotentWrite: true },
      );
    });
    const getUsers = Effect.fn("Repository.getUsers")(function* ({
      limit,
      offset,
      searchValue,
    }: {
      limit: number;
      offset: number;
      searchValue?: string;
    }) {
      const searchPattern = searchValue ? `%${searchValue}%` : "%";
      const result = yield* d1.first(
        d1
          .prepare(
            `
select json_object(
  'users', coalesce((
    select json_group_array(
      json_object(
        'id', u.id,
        'name', u.name,
        'email', u.email,
        'emailVerified', u.emailVerified,
        'image', u.image,
        'role', u.role,
        'banned', u.banned,
        'banReason', u.banReason,
        'banExpires', u.banExpires,
        'stripeCustomerId', u.stripeCustomerId,
        'createdAt', u.createdAt,
        'updatedAt', u.updatedAt
      )
    ) from (
      select * from User u
      where u.email like ?1
      order by u.email asc
      limit ?2 offset ?3
    ) as u
  ), json('[]')),
  'count', (
    select count(*) from User u where u.email like ?1
  ),
  'limit', ?2,
  'offset', ?3
) as data
            `,
          )
          .bind(searchPattern, limit, offset),
      );
      return yield* Effect.fromOption(result).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            JsonDataField(
              Schema.Struct({
                users: Schema.Array(Domain.User),
                count: Schema.Number,
                limit: Schema.Number,
                offset: Schema.Number,
              }),
            ),
          ),
        ),
      );
    });
    const getAppDashboardData = Effect.fn("Repository.getAppDashboardData")(
      function* ({
        userEmail,
        organizationId,
      }: {
        userEmail: Domain.User["email"];
        organizationId: Domain.Organization["id"];
      }) {
        const result = yield* d1.first(
          d1
            .prepare(
              `
select json_object(
  'userInvitations', (
    select json_group_array(
      json_object(
        'id', i.id,
        'email', i.email,
        'inviterId', i.inviterId,
        'organizationId', i.organizationId,
        'role', i.role,
        'status', i.status,
        'expiresAt', i.expiresAt,
        'organization', json_object(
          'id', o.id,
          'name', o.name,
          'slug', o.slug,
          'logo', o.logo,
          'metadata', o.metadata,
          'createdAt', o.createdAt
        ),
        'inviter', json_object(
          'id', u.id,
          'name', u.name,
          'email', u.email,
          'emailVerified', u.emailVerified,
          'image', u.image,
          'role', u.role,
          'banned', u.banned,
          'banReason', u.banReason,
          'banExpires', u.banExpires,
          'stripeCustomerId', u.stripeCustomerId,
          'createdAt', u.createdAt,
          'updatedAt', u.updatedAt
        )
      )
    )
    from Invitation i
    inner join Organization o on o.id = i.organizationId
    inner join User u on u.id = i.inviterId
    where i.email = ?1 and i.status = 'pending'
  ),
  'memberCount', (
    select count(*) from Member where organizationId = ?2
  ),
  'pendingInvitationCount', (
    select count(*) from Invitation where organizationId = ?2 and status = 'pending'
  )
) as data
              `,
            )
            .bind(userEmail, organizationId),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              JsonDataField(
                Schema.Struct({
                  userInvitations: Schema.Array(
                    Domain.InvitationWithOrganizationAndInviter,
                  ),
                  memberCount: Schema.Number,
                  pendingInvitationCount: Schema.Number,
                }),
              ),
            ),
          ),
        );
      },
    );
    const getAdminDashboardData = Effect.fn("Repository.getAdminDashboardData")(
      function* () {
        const result = yield* d1.first(
          d1.prepare(
            `
select json_object(
  'customerCount', (
    select count(*) from User where role = 'user'
  ),
  'activeSubscriptionCount', (
    select count(*) from Subscription where status = 'active'
  ),
  'trialingSubscriptionCount', (
    select count(*) from Subscription where status = 'trialing'
  )
) as data
            `,
          ),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              JsonDataField(
                Schema.Struct({
                  customerCount: Schema.Number,
                  activeSubscriptionCount: Schema.Number,
                  trialingSubscriptionCount: Schema.Number,
                }),
              ),
            ),
          ),
        );
      },
    );
    const getCustomers = Effect.fn("Repository.getCustomers")(function* ({
      limit,
      offset,
      searchValue,
    }: {
      limit: number;
      offset: number;
      searchValue?: string;
    }) {
      const searchPattern = searchValue ? `%${searchValue}%` : "%";
      const result = yield* d1.first(
        d1
          .prepare(
            `
select json_object(
  'customers', coalesce((
    select json_group_array(
      json_object(
        'id', u.id,
        'name', u.name,
        'email', u.email,
        'emailVerified', u.emailVerified,
        'image', u.image,
        'role', u.role,
        'banned', u.banned,
        'banReason', u.banReason,
        'banExpires', u.banExpires,
        'stripeCustomerId', u.stripeCustomerId,
        'createdAt', u.createdAt,
        'updatedAt', u.updatedAt,
        'subscription', (
          select json_object(
            'id', s.id,
            'plan', s.plan,
            'referenceId', s.referenceId,
            'stripeCustomerId', s.stripeCustomerId,
            'stripeSubscriptionId', s.stripeSubscriptionId,
            'status', s.status,
            'periodStart', s.periodStart,
            'periodEnd', s.periodEnd,
            'cancelAtPeriodEnd', s.cancelAtPeriodEnd,
            'cancelAt', s.cancelAt,
            'canceledAt', s.canceledAt,
            'endedAt', s.endedAt,
            'seats', s.seats,
            'billingInterval', s.billingInterval,
            'stripeScheduleId', s.stripeScheduleId,
            'trialStart', s.trialStart,
            'trialEnd', s.trialEnd
          ) from Subscription s where s.stripeCustomerId = u.stripeCustomerId limit 1
        )
      )
    ) from (
      select * from User u
      where u.role = 'user'
      and u.email like ?1
      order by u.email asc
      limit ?2 offset ?3
    ) as u
  ), json('[]')),
  'count', (
    select count(*) from User u where u.role = 'user' and u.email like ?1
  ),
  'limit', ?2,
  'offset', ?3
) as data
            `,
          )
          .bind(searchPattern, limit, offset),
      );
      return yield* Effect.fromOption(result).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            JsonDataField(
              Schema.Struct({
                customers: Schema.Array(Domain.UserWithSubscription),
                count: Schema.Number,
                limit: Schema.Number,
                offset: Schema.Number,
              }),
            ),
          ),
        ),
      );
    });
    const getSubscriptions = Effect.fn("Repository.getSubscriptions")(
      function* ({
        limit,
        offset,
        searchValue,
      }: {
        limit: number;
        offset: number;
        searchValue?: string;
      }) {
        const searchPattern = searchValue ? `%${searchValue}%` : "%";
        const result = yield* d1.first(
          d1
            .prepare(
              `
select json_object(
  'subscriptions', coalesce((
    select json_group_array(
      json_object(
        'id', s_subscriptionId,
        'plan', s_plan,
        'referenceId', s_referenceId,
        'stripeCustomerId', s_stripeCustomerId,
        'stripeSubscriptionId', s_stripeSubscriptionId,
        'status', s_status,
        'periodStart', s_periodStart,
        'periodEnd', s_periodEnd,
        'cancelAtPeriodEnd', s_cancelAtPeriodEnd,
        'cancelAt', s_cancelAt,
        'canceledAt', s_canceledAt,
        'endedAt', s_endedAt,
        'seats', s_seats,
        'billingInterval', s_billingInterval,
        'stripeScheduleId', s_stripeScheduleId,
        'trialStart', s_trialStart,
        'trialEnd', s_trialEnd,
        'user', json_object(
          'id', u_userId,
          'name', u_name,
          'email', u_email,
          'emailVerified', u_emailVerified,
          'image', u_image,
          'role', u_role,
          'banned', u_banned,
          'banReason', u_banReason,
          'banExpires', u_banExpires,
          'stripeCustomerId', u_stripeCustomerId,
          'createdAt', u_createdAt,
          'updatedAt', u_updatedAt
        )
      )
    ) from (
      select
        s.id as s_subscriptionId,
        s.plan as s_plan,
        s.referenceId as s_referenceId,
        s.stripeCustomerId as s_stripeCustomerId,
        s.stripeSubscriptionId as s_stripeSubscriptionId,
        s.status as s_status,
        s.periodStart as s_periodStart,
        s.periodEnd as s_periodEnd,
        s.cancelAtPeriodEnd as s_cancelAtPeriodEnd,
        s.cancelAt as s_cancelAt,
        s.canceledAt as s_canceledAt,
        s.endedAt as s_endedAt,
        s.seats as s_seats,
        s.billingInterval as s_billingInterval,
        s.stripeScheduleId as s_stripeScheduleId,
        s.trialStart as s_trialStart,
        s.trialEnd as s_trialEnd,
        u.id as u_userId,
        u.name as u_name,
        u.email as u_email,
        u.emailVerified as u_emailVerified,
        u.image as u_image,
        u.role as u_role,
        u.banned as u_banned,
        u.banReason as u_banReason,
        u.banExpires as u_banExpires,
        u.stripeCustomerId as u_stripeCustomerId,
        u.createdAt as u_createdAt,
        u.updatedAt as u_updatedAt
      from Subscription s
      inner join User u on u.stripeCustomerId = s.stripeCustomerId
      where u.email like ?1
      order by u_email asc, s_subscriptionId asc
      limit ?2 offset ?3
    ) as joined
  ), json('[]')),
  'count', (
    select count(*)
    from Subscription s
    inner join User u on u.stripeCustomerId = s.stripeCustomerId
    where u.email like ?1
  ),
  'limit', ?2,
  'offset', ?3
) as data
            `,
            )
            .bind(searchPattern, limit, offset),
        );
        return yield* Effect.fromOption(result).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              JsonDataField(
                Schema.Struct({
                  subscriptions: Schema.Array(Domain.SubscriptionWithUser),
                  count: Schema.Number,
                  limit: Schema.Number,
                  offset: Schema.Number,
                }),
              ),
            ),
          ),
        );
      },
    );
    const getSessions = Effect.fn("Repository.getSessions")(function* ({
      limit,
      offset,
      searchValue,
    }: {
      limit: number;
      offset: number;
      searchValue?: string;
    }) {
      const searchPattern = searchValue ? `%${searchValue}%` : "%";
      const result = yield* d1.first(
        d1
          .prepare(
            `
select json_object(
  'sessions', coalesce((
    select json_group_array(
      json_object(
        'id', s_sessionId,
        'expiresAt', s_expiresAt,
        'token', s_token,
        'createdAt', s_createdAt,
        'updatedAt', s_updatedAt,
        'ipAddress', s_ipAddress,
        'userAgent', s_userAgent,
        'userId', s_userId,
        'impersonatedBy', s_impersonatedBy,
        'activeOrganizationId', s_activeOrganizationId,
        'user', json_object(
          'id', u_userId,
          'name', u_name,
          'email', u_email,
          'emailVerified', u_emailVerified,
          'image', u_image,
          'role', u_role,
          'banned', u_banned,
          'banReason', u_banReason,
          'banExpires', u_banExpires,
          'stripeCustomerId', u_stripeCustomerId,
          'createdAt', u_createdAt,
          'updatedAt', u_updatedAt
        )
      )
    ) from (
      select
        s.id as s_sessionId,
        s.expiresAt as s_expiresAt,
        s.token as s_token,
        s.createdAt as s_createdAt,
        s.updatedAt as s_updatedAt,
        s.ipAddress as s_ipAddress,
        s.userAgent as s_userAgent,
        s.userId as s_userId,
        s.impersonatedBy as s_impersonatedBy,
        s.activeOrganizationId as s_activeOrganizationId,
        u.id as u_userId,
        u.name as u_name,
        u.email as u_email,
        u.emailVerified as u_emailVerified,
        u.image as u_image,
        u.role as u_role,
        u.banned as u_banned,
        u.banReason as u_banReason,
        u.banExpires as u_banExpires,
        u.stripeCustomerId as u_stripeCustomerId,
        u.createdAt as u_createdAt,
        u.updatedAt as u_updatedAt
      from Session s
      inner join User u on s.userId = u.id
      where u.email like ?1
      order by u_email asc, s_createdAt asc
      limit ?2 offset ?3
    ) as joined
  ), json('[]')),
  'count', (
    select count(*)
    from Session s
    inner join User u on s.userId = u.id
    where u.email like ?1
  ),
  'limit', ?2,
  'offset', ?3
) as data
            `,
          )
          .bind(searchPattern, limit, offset),
      );
      return yield* Effect.fromOption(result).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            JsonDataField(
              Schema.Struct({
                sessions: Schema.Array(Domain.SessionWithUser),
                count: Schema.Number,
                limit: Schema.Number,
                offset: Schema.Number,
              }),
            ),
          ),
        ),
      );
    });
    const updateInvitationRole = Effect.fn("Repository.updateInvitationRole")(
      function* ({
        invitationId,
        role,
      }: {
        invitationId: Domain.Invitation["id"];
        role: Domain.MemberRole;
      }) {
        return yield* d1.run(
          d1
            .prepare("update Invitation set role = ?1 where id = ?2")
            .bind(role, invitationId),
          { idempotentWrite: true },
        );
      },
    );
    const deleteExpiredSessions = Effect.fn("Repository.deleteExpiredSessions")(
      function* () {
        const cutoff = new Date().toISOString();
        return yield* d1
          .run(
            d1.prepare("delete from Session where expiresAt < ?1").bind(cutoff),
            { idempotentWrite: true },
          )
          .pipe(Effect.map((result) => result.meta.changes));
      },
    );
    return {
      getUser,
      getMemberById,
      getInvitation,
      getMemberByUserAndOrg,
      getOwnerOrganizationByUserId,
      /**
       * Backfills active organization only for sessions that do not have one yet.
       */
      initializeActiveOrganizationForUserSessions,
      getUsers,
      getAppDashboardData,
      getAdminDashboardData,
      getCustomers,
      getSubscriptions,
      getSessions,
      updateInvitationRole,
      deleteExpiredSessions,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
