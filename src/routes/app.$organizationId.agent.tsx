import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useOrganizationAgent } from "@/lib/OrganizationAgentContext";

export const Route = createFileRoute("/app/$organizationId/agent")({
  component: RouteComponent,
});

function RouteComponent() {
  const { stub } = useOrganizationAgent();
  const [message, setMessage] = React.useState("Loading...");

  React.useEffect(() => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
    void stub.getTestMessage().then(setMessage);
  }, [stub]);

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
            Message fetched via RPC stub from the organization agent instance.
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
