import { Outlet, createFileRoute } from "@tanstack/react-router";

import {
  getInvoices,
  getInvoiceWithItems,
  invoiceQueryKey,
  invoicesQueryKey,
} from "@/lib/Invoices";

export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: async ({ params: { organizationId }, context }) => {
    const invoices = await context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
      revalidateIfStale: true,
    });
    const firstInvoiceId = invoices[0]?.id;
    if (firstInvoiceId) {
      await context.queryClient.ensureQueryData({
        queryKey: invoiceQueryKey(organizationId, firstInvoiceId),
        queryFn: () =>
          getInvoiceWithItems({
            data: { organizationId, invoiceId: firstInvoiceId },
          }),
        revalidateIfStale: true,
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
