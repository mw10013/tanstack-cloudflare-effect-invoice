import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/$organizationId/invoices")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
