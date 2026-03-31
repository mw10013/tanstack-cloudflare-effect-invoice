import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Auth } from "@/lib/Auth";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { Request } from "@/lib/Request";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const splitEmails = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const Route = createFileRoute("/app/$organizationId/invitations")({
  loader: ({ params: data }) => getLoaderData({ data }),
  component: RouteComponent,
});

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator((data: { organizationId: string }) => data)
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const { success: canManageInvitations } = yield* Effect.tryPromise(() =>
          auth.api.hasPermission({
            headers: request.headers,
            body: {
              organizationId: data.organizationId,
              permissions: { invitation: ["create", "cancel"] },
            },
          }),
        );
        const invitations = yield* Effect.tryPromise(() =>
          auth.api.listInvitations({
            headers: request.headers,
            query: { organizationId: data.organizationId },
          }),
        );
        return { canManageInvitations, invitations };
      }),
    ),
  );

function RouteComponent() {
  const { canManageInvitations, invitations } = Route.useLoaderData();
  const { organizationId } = Route.useParams();

  return (
    <div className="flex flex-col gap-8 p-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Invitations</h1>
        <p className="text-sm text-muted-foreground">
          Invite new members and manage your invitations.
        </p>
      </header>

      {canManageInvitations && <InviteForm organizationId={organizationId} />}

      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            Review and manage invitations sent for this organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invitations.length > 0 ? (
            <div
              aria-label="Organization invitations"
              data-testid="invitations-list"
            >
              {invitations.map((invitation) => (
                <InvitationItem
                  key={invitation.id}
                  invitation={invitation}
                  canManageInvitations={canManageInvitations}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No invitations have been sent for this organization yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const inviteSchema = Schema.Struct({
  organizationId: Domain.Organization.fields.id,
  emails: Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String.check(Schema.isPattern(emailPattern)))
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(10)),
      SchemaTransformation.transform({
        decode: (value): readonly string[] => splitEmails(value),
        encode: (emails: readonly string[]) => emails.join(", "),
      }),
    ),
  ),
  role: Schema.Literals(Domain.AssignableMemberRoleValues),
});

const invitationIdSchema = Schema.Struct({ invitationId: Domain.Invitation.fields.id });

/**
 * Authorization is enforced by better-auth createInvitation.
 */
const invite = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(inviteSchema))
  .handler(
    ({ data: { organizationId, emails, role }, context: { runEffect } }) =>
      runEffect(
        Effect.gen(function* () {
          const request = yield* Request;
          const auth = yield* Auth;
          const repository = yield* Repository;
          for (const email of emails) {
            const result = yield* Effect.tryPromise(() =>
              auth.api.createInvitation({
                headers: request.headers,
                body: {
                  email,
                  role,
                  organizationId,
                  resend: true,
                },
              }),
            );
            // Workaround for better-auth createInvitation role bug.
            // Occurs when a pending invitation exists and a new invitation is created with a different role.
            if (result.role !== role) {
              yield* Effect.logInfo("auth.invitation.roleMismatchWorkaround", {
                expectedRole: role,
                actualRole: result.role,
                invitationId: result.id,
              });
              yield* repository.updateInvitationRole({
                invitationId: result.id,
                role,
              });
            }
          }
        }),
      ),
  );

function InviteForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const isHydrated = useHydrated();
  const inviteServerFn = useServerFn(invite);
  const defaultValues = {
    organizationId,
    emails: "",
    role: "member" as Extract<Domain.MemberRole, "member" | "admin">,
  } satisfies typeof inviteSchema.Encoded;

  const inviteMutation = useMutation({
    mutationFn: (data: typeof defaultValues) => inviteServerFn({ data }),
    onSuccess: () => {
      form.reset();
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: Schema.toStandardSchemaV1(inviteSchema),
    },
    onSubmit: ({ value }) => {
      inviteMutation.mutate(value);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite New Members</CardTitle>
        <CardDescription>
          Enter email addresses separated by commas to send invitations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            {inviteMutation.error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  {inviteMutation.error.message}
                </AlertDescription>
              </Alert>
            )}
            <form.Field name="emails">
              {(field) => {
                const isInvalid = field.state.meta.errors.length > 0;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>
                      Email Addresses
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                      }}
                      placeholder="user1@example.com, user2@example.com"
                      aria-invalid={isInvalid}
                      disabled={!isHydrated}
                    />
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="role">
              {(field) => {
                const isInvalid = field.state.meta.errors.length > 0;
                return (
                  <Field data-invalid={isInvalid} className="w-fit">
                    <FieldLabel htmlFor={field.name}>Role</FieldLabel>
                    <Select
                      value={field.state.value}
                      onValueChange={(value) => {
                        if (value) field.handleChange(value);
                      }}
                      disabled={!isHydrated}
                    >
                      <SelectTrigger className="capitalize">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>
            <form.Subscribe selector={(state) => state.canSubmit}>
              {(canSubmit) => (
                <Button
                  type="submit"
                  disabled={
                    !canSubmit || !isHydrated || inviteMutation.isPending
                  }
                  className="self-end"
                >
                  Invite
                </Button>
              )}
            </form.Subscribe>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Authorization is enforced by better-auth cancelInvitation.
 */
const cancelInvitation = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(invitationIdSchema))
  .handler(({ data: { invitationId }, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        yield* Effect.tryPromise(() =>
          auth.api.cancelInvitation({
            headers: request.headers,
            body: { invitationId },
          }),
        );
      }),
    ),
  );

function InvitationItem({
  invitation,
  canManageInvitations,
}: {
  invitation: (typeof Route)["types"]["loaderData"]["invitations"][number];
  canManageInvitations: boolean;
}) {
  const router = useRouter();
  const isHydrated = useHydrated();
  const cancelInvitationServerFn = useServerFn(cancelInvitation);
  const cancelInvitationMutation = useMutation({
    mutationFn: () =>
      cancelInvitationServerFn({
        data: { invitationId: invitation.id },
      }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  return (
    <Item size="sm" className="gap-4 px-0">
      <ItemContent>
        <ItemTitle>{invitation.email}</ItemTitle>
        <ItemDescription>
          {invitation.role} — {invitation.status}
          {invitation.status === "pending" && (
            <>
              <br />
              <span className="text-xs">
                Expires:{" "}
                {new Date(invitation.expiresAt)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 16)}{" "}
                UTC
              </span>
            </>
          )}
        </ItemDescription>
      </ItemContent>
      {canManageInvitations && invitation.status === "pending" && (
        <ItemActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Cancel invitation for ${invitation.email}`}
            disabled={!isHydrated || cancelInvitationMutation.isPending}
            onClick={() => {
              cancelInvitationMutation.mutate();
            }}
          >
            Cancel
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}
