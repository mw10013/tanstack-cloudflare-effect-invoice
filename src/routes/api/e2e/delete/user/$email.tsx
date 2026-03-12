import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import * as Option from "effect/Option";

import { D1 } from "@/lib/D1";
import { Repository } from "@/lib/Repository";
import { Stripe } from "@/lib/Stripe";

export const Route = createFileRoute("/api/e2e/delete/user/$email")({
  server: {
    handlers: {
      POST: async ({ params: { email }, context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const stripe = yield* Stripe;
            const repository = yield* Repository;
            const d1 = yield* D1;

            // Always delete Stripe customers by email since D1 database may be out of sync
            const customers = yield* Effect.tryPromise(() =>
              stripe.stripe.customers.list({ email }),
            );
            for (const customer of customers.data) {
              yield* Effect.tryPromise(() =>
                stripe.stripe.customers.del(customer.id),
              );
            }

            const userOption = yield* repository.getUser(email);
            if (Option.isNone(userOption)) {
              return Response.json({
                success: true,
                message: `User ${email} already deleted.`,
              });
            }
            const user = userOption.value;
            if (user.role === "admin") {
              return Response.json(
                {
                  success: false,
                  message: `Cannot delete admin user ${email}.`,
                },
                { status: 403 },
              );
            }

            const [deleteOrganizationResult, deleteUserResult] =
              yield* d1.batch(
                [
                  d1
                    .prepare(
                      `
delete from Organization where id in (
  select o.id
  from Organization o
  inner join Member m on m.organizationId = o.id
  where m.userId = ?1
    and m.role = 'owner'
    and not exists (
      select 1
      from Member m1
      where m1.organizationId = m.organizationId
        and m1.userId != ?1
        and m1.role = 'owner'
    )
)
          `,
                    )
                    .bind(user.id),
                  d1
                    .prepare("delete from User where id = ? returning *")
                    .bind(user.id),
                ],
                { idempotentWrite: true },
              );

            const message = `Deleted user ${email}, deletedOrganizationCount: ${String(deleteOrganizationResult.results.length)} deletedUserCount: ${String(deleteUserResult.results.length)})`;
            yield* Effect.logInfo(message);
            return Response.json({
              success: true,
              message,
            });
          }),
        ),
    },
  },
});
