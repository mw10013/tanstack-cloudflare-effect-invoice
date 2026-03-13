import { useAgent } from "agents/react";

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OrganizationAgent } from "@/organization-agent";

export const Route = createFileRoute("/app/$organizationId/agent")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const [message, setMessage] = React.useState("Connecting to organization agent...");
  useAgent<OrganizationAgent, { readonly message: string }>({
    agent: "organization-agent",
    name: organizationId,
    onStateUpdate: (state) => {
      setMessage(state.message);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Agent</h1>
        <p className="text-sm text-muted-foreground">
          Organization agent spike wired through Workers agents.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Test Message</CardTitle>
          <CardDescription>
            State synchronized from the organization agent instance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm" data-testid="organization-agent-message">
            {message}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
