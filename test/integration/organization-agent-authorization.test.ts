import { env } from "cloudflare:workers";
import { ConfigProvider, Effect, Layer, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { expect } from "vitest";

import { switchOrganizationServerFn } from "@/routes/app.$organizationId";
import { acceptInvitation } from "@/routes/app.$organizationId.index";
import {
  getLoaderData as getInvitationsLoaderData,
  invite,
} from "@/routes/app.$organizationId.invitations";
import {
  getLoaderData as getMembersLoaderData,
  removeMember,
} from "@/routes/app.$organizationId.members";

import {
  agentWebSocket,
  assertAgentRpcSuccess,
  callAgentRpc,
  callServerFn,
  login,
  workerFetch,
} from "../TestUtils";

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

const invoiceIdResult = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
});

const inviteMember = Effect.fn("inviteMember")(function* ({
  ownerSessionCookie,
  ownerOrganizationId,
  memberEmail,
}: {
  ownerSessionCookie: string;
  ownerOrganizationId: string;
  memberEmail: string;
}) {
  yield* callServerFn({
    serverFn: invite,
    data: {
      organizationId: ownerOrganizationId,
      emails: memberEmail,
      role: "member",
    },
    headers: { Cookie: ownerSessionCookie },
  });
});

const findInvitationId = Effect.fn("findInvitationId")(function* ({
  ownerSessionCookie,
  organizationId,
  email,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  email: string;
}) {
  const loaderData = yield* callServerFn({
    serverFn: getInvitationsLoaderData,
    data: { organizationId },
    headers: { Cookie: ownerSessionCookie },
  });
  const invitation = loaderData.invitations.find(
    (item) =>
      item.organizationId === organizationId &&
      item.email.toLowerCase() === email.toLowerCase() &&
      item.status === "pending",
  );
  if (!invitation)
    return yield* Effect.fail(new Error("Invitation not found for member"));
  return invitation.id;
});

const acceptInvitationInApp = Effect.fn("acceptInvitationInApp")(function* ({
  sessionCookie,
  invitationId,
  organizationId,
}: {
  sessionCookie: string;
  invitationId: string;
  organizationId: string;
}) {
  yield* callServerFn({
    serverFn: acceptInvitation,
    data: { invitationId, organizationId },
    headers: { Cookie: sessionCookie },
  });
});

const setActiveOrganization = Effect.fn("setActiveOrganization")(function* ({
  sessionCookie,
  organizationId,
}: {
  sessionCookie: string;
  organizationId: string;
}) {
  yield* callServerFn({
    serverFn: switchOrganizationServerFn,
    data: organizationId,
    headers: { Cookie: sessionCookie },
  });
});

const getMemberIdByEmail = Effect.fn("getMemberIdByEmail")(function* ({
  ownerSessionCookie,
  organizationId,
  memberEmail,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  memberEmail: string;
}) {
  const loaderData = yield* callServerFn({
    serverFn: getMembersLoaderData,
    data: { organizationId },
    headers: { Cookie: ownerSessionCookie },
  });
  const member = loaderData.members.find(
    (item) => item.user.email.toLowerCase() === memberEmail.toLowerCase(),
  );
  if (!member) return yield* Effect.fail(new Error("Member not found"));
  return member.id;
});

const removeMemberInApp = Effect.fn("removeMemberInApp")(function* ({
  ownerSessionCookie,
  organizationId,
  memberId,
}: {
  ownerSessionCookie: string;
  organizationId: string;
  memberId: string;
}) {
  yield* callServerFn({
    serverFn: removeMember,
    data: { organizationId, memberId },
    headers: { Cookie: ownerSessionCookie },
  });
});

layer(configLayer, { excludeTestServices: true })(
  "organization-agent-authorization",
  (it) => {
    it.effect("invited member is authorized for all invoice callables", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-owner-${crypto.randomUUID()}@test.com`;
        const memberEmail = `int-auth-member-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const member = yield* login(memberEmail);

        yield* inviteMember({
          ownerSessionCookie: owner.sessionCookie,
          ownerOrganizationId: owner.organizationId,
          memberEmail,
        });
        const invitationId = yield* findInvitationId({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          email: memberEmail,
        });
        yield* acceptInvitationInApp({
          sessionCookie: member.sessionCookie,
          invitationId,
          organizationId: owner.organizationId,
        });
        yield* setActiveOrganization({
          sessionCookie: member.sessionCookie,
          organizationId: owner.organizationId,
        });

        const ws = yield* agentWebSocket(owner.organizationId, member.sessionCookie);
        const createResult = yield* callAgentRpc(ws, "createInvoice", []);
        assertAgentRpcSuccess(createResult);
        const { invoiceId } = Schema.decodeUnknownSync(invoiceIdResult)(
          createResult.result,
        );

        const getInvoicesResult = yield* callAgentRpc(ws, "getInvoices", []);
        assertAgentRpcSuccess(getInvoicesResult);

        const getInvoiceResult = yield* callAgentRpc(ws, "getInvoice", [
          { invoiceId },
        ]);
        assertAgentRpcSuccess(getInvoiceResult);

        const updateResult = yield* callAgentRpc(ws, "updateInvoice", [
          {
            invoiceId,
            name: "Auth Coverage",
            invoiceNumber: "AUTH-001",
            invoiceDate: "",
            dueDate: "",
            currency: "",
            vendorName: "",
            vendorEmail: "",
            vendorAddress: "",
            billToName: "",
            billToEmail: "",
            billToAddress: "",
            subtotal: "",
            tax: "",
            total: "",
            amountDue: "",
            invoiceItems: [],
          },
        ]);
        assertAgentRpcSuccess(updateResult);

        const uploadResult = yield* callAgentRpc(ws, "uploadInvoice", [
          {
            fileName: "invoice-1-redacted.png",
            contentType: "image/png",
            base64: env.TEST_INVOICE_PNG_BASE64,
          },
        ]);
        assertAgentRpcSuccess(uploadResult);

        const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [
          { invoiceId },
        ]);
        assertAgentRpcSuccess(deleteResult);
      }));

    it.effect("never-member is blocked by worker gate", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-never-owner-${crypto.randomUUID()}@test.com`;
        const outsiderEmail =
          `int-auth-never-outsider-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const outsider = yield* login(outsiderEmail);

        const response = yield* workerFetch(
          `http://w/agents/organization-agent/${owner.organizationId}`,
          {
            headers: {
              Upgrade: "websocket",
              Cookie: outsider.sessionCookie,
            },
          },
        );

        expect(response.status).toBe(403);
        const text = yield* Effect.promise(() => response.text());
        expect(text).toContain("Forbidden");
      }));

    it.effect("removed member is disconnected", () =>
      Effect.gen(function* () {
        const ownerEmail = `int-auth-removed-owner-${crypto.randomUUID()}@test.com`;
        const memberEmail = `int-auth-removed-member-${crypto.randomUUID()}@test.com`;

        const owner = yield* login(ownerEmail);
        const member = yield* login(memberEmail);

        yield* inviteMember({
          ownerSessionCookie: owner.sessionCookie,
          ownerOrganizationId: owner.organizationId,
          memberEmail,
        });
        const invitationId = yield* findInvitationId({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          email: memberEmail,
        });
        yield* acceptInvitationInApp({
          sessionCookie: member.sessionCookie,
          invitationId,
          organizationId: owner.organizationId,
        });
        yield* setActiveOrganization({
          sessionCookie: member.sessionCookie,
          organizationId: owner.organizationId,
        });

        const ws = yield* agentWebSocket(owner.organizationId, member.sessionCookie);
        const firstCreateResult = yield* callAgentRpc(ws, "createInvoice", []);
        assertAgentRpcSuccess(firstCreateResult);

        const closePromise = new Promise<CloseEvent>((resolve) => {
          ws.addEventListener("close", resolve, { once: true });
        });

        const memberId = yield* getMemberIdByEmail({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          memberEmail,
        });
        yield* removeMemberInApp({
          ownerSessionCookie: owner.sessionCookie,
          organizationId: owner.organizationId,
          memberId,
        });

        const closeEvent = yield* Effect.promise(() => closePromise).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.die(new Error("WebSocket was not closed after member removal"))),
        );
        expect(closeEvent.code).toBe(4003);
        expect(closeEvent.reason).toBe("Membership revoked");

        const reconnectResponse = yield* workerFetch(
          `http://w/agents/organization-agent/${owner.organizationId}`,
          {
            headers: {
              Upgrade: "websocket",
              Cookie: member.sessionCookie,
            },
          },
        );
        expect(reconnectResponse.status).toBe(403);
      }));
  },
);
