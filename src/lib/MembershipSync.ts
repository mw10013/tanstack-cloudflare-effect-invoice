import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";

export const membershipSyncChangeValues = [
  "added",
  "removed",
  "role_changed",
] as const;

export const MembershipSyncChange = Schema.Literals(membershipSyncChangeValues);

export type MembershipSyncChange = typeof MembershipSyncChange.Type;

export const MembershipSyncQueueMessageSchema = Schema.Struct({
  action: Schema.Literals(["MembershipSync"]),
  organizationId: Domain.Organization.fields.id,
  userId: Domain.User.fields.id,
  change: MembershipSyncChange,
});

export const sendMembershipSync = Effect.fn("sendMembershipSync")(function* (
  input: Omit<typeof MembershipSyncQueueMessageSchema.Type, "action">,
) {
  const env = yield* CloudflareEnv;
  const message: typeof MembershipSyncQueueMessageSchema.Type = {
    action: "MembershipSync",
    organizationId: input.organizationId,
    userId: input.userId,
    change: input.change,
  };
  yield* Effect.tryPromise(() => env.Q.send(message));
});
