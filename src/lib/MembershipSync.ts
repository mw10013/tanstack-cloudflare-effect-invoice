import { Effect } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import type * as Domain from "@/lib/Domain";

export const sendMembershipSync = Effect.fn("sendMembershipSync")(
  function* (input: {
    organizationId: Domain.Organization["id"];
    userId: Domain.User["id"];
    change: "added" | "removed" | "role_changed";
  }) {
    const env = yield* CloudflareEnv;
    yield* Effect.tryPromise(() =>
      env.Q.send({
        action: "MembershipSync" as const,
        organizationId: input.organizationId,
        userId: input.userId,
        change: input.change,
      }),
    );
  },
);
