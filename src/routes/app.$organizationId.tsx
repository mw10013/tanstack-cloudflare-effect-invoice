import type { AuthInstance } from "@/lib/Auth";
import type { OrganizationAgent } from "@/organization-agent";

import {
  createFileRoute,
  getRouteApi,
  Link,
  notFound,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Cause, Effect } from "effect";
import { ChevronsUpDown, LogOut } from "lucide-react";

import { AppLogo } from "@/components/app-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { decodeActivityMessage, shouldInvalidateForInvoice } from "@/lib/Activity";
import { Auth, signOutServerFn } from "@/lib/Auth";
import { OrganizationAgentProvider } from "@/lib/OrganizationAgentContext";
import { Request } from "@/lib/Request";

export const switchOrganizationServerFn = createServerFn({ method: "POST" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(({ data: organizationId, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        yield* Effect.tryPromise(() =>
          auth.api.setActiveOrganization({
            headers: request.headers,
            body: { organizationId },
          }),
        );
      }),
    ),
  );

const beforeLoadServerFn = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(({ context: { runEffect }, data: organizationId }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const sessionUser = yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.filterOrFail(
            (s) => s.session.activeOrganizationId === organizationId,
            () => new Cause.NoSuchElementError(),
          ),
          Effect.map(({ user }) => user),
        );
        const organizations = yield* Effect.tryPromise(() =>
          auth.api.listOrganizations({ headers: request.headers }),
        );
        const organization = organizations.find(
          (org) => org.id === organizationId,
        );
        if (!organization) return yield* Effect.die(notFound());
        return {
          organization,
          organizations,
          sessionUser,
        };
      }),
    ),
  );

const invoicesIndexRoute = getRouteApi("/app/$organizationId/invoices/");

export const Route = createFileRoute("/app/$organizationId")({
  beforeLoad: async ({ params }) =>
    await beforeLoadServerFn({ data: params.organizationId }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const { organization, organizations, sessionUser } = Route.useRouteContext();
  const router = useRouter();

  const agent = useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      const message = decodeActivityMessage(event);
      if (!message) return;
      if (shouldInvalidateForInvoice(message.action)) {
        void router.invalidate({
          filter: (match) => match.routeId === invoicesIndexRoute.id,
        });
      }
    },
  });

  return (
    <OrganizationAgentProvider
      value={{
        call: agent.call,
        stub: agent.stub,
        ready: agent.ready,
        identified: agent.identified,
      }}
    >
      <SidebarProvider>
        <AppSidebar
          organization={organization}
          organizations={organizations}
          user={sessionUser}
        />
        <main className="flex h-svh w-full flex-col overflow-x-hidden">
          <SidebarTrigger />
          <Outlet />
        </main>
      </SidebarProvider>
    </OrganizationAgentProvider>
  );
}

function AppSidebar({
  organization,
  organizations,
  user,
}: {
  organization: AuthInstance["$Infer"]["Organization"];
  organizations: AuthInstance["$Infer"]["Organization"][];
  user: { email: string };
}) {
  const matchRoute = useMatchRoute();

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex w-full items-center gap-3 p-2">
          <Link
            to="/"
            aria-label="Home"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <AppLogo />
          </Link>
          <OrganizationSwitcher
            organizations={organizations}
            organization={organization}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(matchRoute({ to: "/app/$organizationId" }))}
                  render={
                    <Link
                      to="/app/$organizationId"
                      params={{ organizationId: organization.id }}
                    >
                      Organization Home
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(
                    matchRoute({ to: "/app/$organizationId/invoices" }),
                  )}
                  render={
                    <Link
                      to="/app/$organizationId/invoices"
                      params={{ organizationId: organization.id }}
                    >
                      Invoices
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(
                    matchRoute({ to: "/app/$organizationId/invitations" }),
                  )}
                  render={
                    <Link
                      to="/app/$organizationId/invitations"
                      params={{ organizationId: organization.id }}
                      data-testid="sidebar-invitations"
                    >
                      Invitations
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(
                    matchRoute({ to: "/app/$organizationId/members" }),
                  )}
                  render={
                    <Link
                      to="/app/$organizationId/members"
                      params={{ organizationId: organization.id }}
                    >
                      Members
                    </Link>
                  }
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(
                    matchRoute({ to: "/app/$organizationId/billing" }),
                  )}
                  render={
                    <Link
                      to="/app/$organizationId/billing"
                      params={{ organizationId: organization.id }}
                      data-testid="sidebar-billing"
                    >
                      Billing
                    </Link>
                  }
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}

function OrganizationSwitcher({
  organizations,
  organization,
}: {
  organizations: AuthInstance["$Infer"]["Organization"][];
  organization: AuthInstance["$Infer"]["Organization"];
}) {
  const navigate = useNavigate();
  const switchOrganizationFn = useServerFn(switchOrganizationServerFn);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            className="h-auto flex-1 items-center justify-between p-0 text-left font-medium data-hovered:bg-transparent"
          >
            <div className="grid leading-tight">
              <span className="truncate font-medium">{organization.name}</span>
            </div>
            <ChevronsUpDown className="ml-2 size-4 text-muted-foreground" />
          </Button>
        )}
      />
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Switch Organization</DropdownMenuLabel>
          {organizations.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onClick={() => {
                void switchOrganizationFn({ data: org.id }).then(() =>
                  navigate({
                    to: "/app/$organizationId",
                    params: { organizationId: org.id },
                  }),
                );
              }}
            >
              {org.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavUser({ user }: { user: { email: string } }) {
  const signOutFn = useServerFn(signOutServerFn);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <SidebarMenuButton
            {...props}
            className="h-12 w-full justify-start overflow-hidden rounded-md p-2 text-left text-sm font-normal"
          >
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.email}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        )}
      />
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate px-1 py-1.5 text-center text-sm font-medium">
            {user.email}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOutFn()}>
          <LogOut className="mr-2 size-4" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
