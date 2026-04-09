import type { OrganizationAgent } from "@/organization-agent";

import * as React from "react";
import type { useAgent } from "agents/react";

type AgentReturn = ReturnType<typeof useAgent<OrganizationAgent, unknown>>;

interface OrganizationAgentContextValue {
  readonly call: AgentReturn["call"];
  readonly stub: AgentReturn["stub"];
  readonly ready: AgentReturn["ready"];
  readonly identified: AgentReturn["identified"];
}

const OrganizationAgentContext =
  React.createContext<OrganizationAgentContextValue | null>(null);

export const OrganizationAgentProvider = OrganizationAgentContext;

export const useOrganizationAgent = () => {
  const ctx = React.use(OrganizationAgentContext);
  if (!ctx)
    throw new Error(
      "useOrganizationAgent must be used within OrganizationAgentProvider",
    );
  return ctx;
};
