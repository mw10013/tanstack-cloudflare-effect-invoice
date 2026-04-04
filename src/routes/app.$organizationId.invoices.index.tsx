import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import {
  Link,
  createFileRoute,
  redirect,
  useHydrated,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import {
  AlertCircle,
  Copy,
  FilePenLine,
  FileText,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getInvoice, getInvoicesWithViewUrl } from "@/lib/Invoices";
import { useOrganizationAgent } from "@/lib/OrganizationAgentContext";

const getStatusVariant = (
  status: string,
): "default" | "destructive" | "secondary" => {
  if (status === "ready") return "default";
  if (status === "error") return "destructive";
  return "secondary";
};

const invoiceSearchSchema = Schema.Struct({
  selectedInvoiceId: Schema.optional(Schema.String),
});

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        organizationId: Schema.NonEmptyString,
        selectedInvoiceId: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(
    ({ context: { runEffect }, data: { organizationId, selectedInvoiceId } }) =>
      runEffect(
        Effect.gen(function* () {
          const invoices = yield* getInvoicesWithViewUrl(organizationId);

          if (!selectedInvoiceId)
            return {
              invoice: null,
              invoices,
              selectedInvoice: null,
              selectedInvoiceId: null,
            };

          const selectedInvoice =
            invoices.find((invoice) => invoice.id === selectedInvoiceId) ??
            null;

          if (!selectedInvoice)
            return yield* Effect.die(
              redirect({
                params: { organizationId },
                search: {},
                to: "/app/$organizationId/invoices",
              }),
            );

          const invoice =
            selectedInvoice.status === "ready"
              ? yield* getInvoice(organizationId, selectedInvoice.id)
              : null;

          return {
            invoice,
            invoices,
            selectedInvoice,
            selectedInvoiceId: selectedInvoice.id,
          };
        }),
      ),
  );

export const Route = createFileRoute("/app/$organizationId/invoices/")({
  validateSearch: Schema.toStandardSchemaV1(invoiceSearchSchema),
  loaderDeps: ({ search: { selectedInvoiceId } }) => ({ selectedInvoiceId }),
  loader: ({ params: { organizationId }, deps: { selectedInvoiceId } }) =>
    getLoaderData({ data: { organizationId, selectedInvoiceId } }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const { selectedInvoiceId } = Route.useSearch();
  const { invoice, invoices, selectedInvoice } = Route.useLoaderData();
  const isHydrated = useHydrated();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [copiedField, setCopiedField] = React.useState<"json" | null>(null);
  const [pendingSelectedInvoiceId, setPendingSelectedInvoiceId] =
    React.useState<string | null>(null);

  const setSelectedInvoiceId = React.useCallback(
    (invoiceId: string | undefined) => {
      setPendingSelectedInvoiceId(null);
      void navigate({
        search: (prev) => ({ ...prev, selectedInvoiceId: invoiceId }),
        replace: true,
      });
    },
    [navigate],
  );

  const copyText = React.useCallback(async (value: string, field: "json") => {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 2000);
  }, []);

  React.useEffect(() => {
    if (!pendingSelectedInvoiceId || selectedInvoiceId) return;
    if (!invoices.some((invoice) => invoice.id === pendingSelectedInvoiceId))
      return;
    void navigate({
      replace: true,
      search: (prev) => ({
        ...prev,
        selectedInvoiceId: pendingSelectedInvoiceId,
      }),
    });
    setPendingSelectedInvoiceId(null);
  }, [invoices, navigate, pendingSelectedInvoiceId, selectedInvoiceId]);

  const { stub } = useOrganizationAgent();
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCodePoint(...new Uint8Array(buffer)));
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
      return stub.uploadInvoice({
        fileName: file.name,
        contentType: file.type,
        base64,
      });
    },
    onSuccess: (result) => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPendingSelectedInvoiceId(result.invoiceId);
    },
    onSettled: () => {
      void router.invalidate({
        filter: (match) => match.routeId === Route.id,
      });
    },
  });
  const createInvoiceMutation = useMutation({
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
    mutationFn: () => stub.createInvoice(),
    onSuccess: (result) => {
      void navigate({
        to: "/app/$organizationId/invoices/$invoiceId",
        params: { organizationId, invoiceId: result.invoiceId },
      });
    },
  });
  const deleteInvoiceMutation = useMutation({
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
    mutationFn: ({ invoiceId }: { invoiceId: string }) =>
      stub.deleteInvoice({ invoiceId }),
    onSettled: () => {
      void router.invalidate({
        filter: (match) => match.routeId === Route.id,
      });
    },
  });
  const displayedInvoice =
    selectedInvoice?.status === "ready"
      ? (invoice ?? selectedInvoice)
      : selectedInvoice;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Manage, upload, and review your invoices.
        </p>
      </header>

      {invoices.length === 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>No invoices yet</CardTitle>
                <CardDescription>
                  Upload or create an invoice to get started.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
                  disabled={!isHydrated || uploadMutation.isPending}
                  className="w-auto"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!isHydrated || uploadMutation.isPending}
                  onClick={() => {
                    const file = fileInputRef.current?.files?.[0];
                    if (file) uploadMutation.mutate(file);
                  }}
                >
                  {uploadMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {uploadMutation.isPending ? "Uploading..." : "Upload"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!isHydrated || createInvoiceMutation.isPending}
                  onClick={() => {
                    createInvoiceMutation.mutate();
                  }}
                >
                  {createInvoiceMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  New Invoice
                </Button>
              </div>
            </div>
            {(uploadMutation.error ?? createInvoiceMutation.error) && (
              <Alert variant="destructive" className="mt-2">
                <AlertCircle className="size-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  {(uploadMutation.error ?? createInvoiceMutation.error)?.message}
                </AlertDescription>
              </Alert>
            )}
          </CardHeader>
        </Card>
      )}

      {invoices.length > 0 && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardTitle>
                  {invoices.length} Invoice{invoices.length !== 1 && "s"}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
                    disabled={!isHydrated || uploadMutation.isPending}
                    className="w-auto"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!isHydrated || uploadMutation.isPending}
                    onClick={() => {
                      const file = fileInputRef.current?.files?.[0];
                      if (file) uploadMutation.mutate(file);
                    }}
                  >
                    {uploadMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {uploadMutation.isPending ? "Uploading..." : "Upload"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!isHydrated || createInvoiceMutation.isPending}
                    onClick={() => {
                      createInvoiceMutation.mutate();
                    }}
                  >
                    {createInvoiceMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    New Invoice
                  </Button>
                </div>
              </div>
              {(uploadMutation.error ?? createInvoiceMutation.error) && (
                <Alert variant="destructive" className="mt-2">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {(uploadMutation.error ?? createInvoiceMutation.error)?.message}
                  </AlertDescription>
                </Alert>
              )}
            </CardHeader>
            <CardContent>
              <div className="max-h-52 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-35" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((invoice) => (
                      <TableRow
                        key={invoice.id}
                        data-state={
                          selectedInvoice?.id === invoice.id
                            ? "selected"
                            : undefined
                        }
                        className="h-12"
                        onClick={() => {
                          setSelectedInvoiceId(invoice.id);
                        }}
                      >
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-2">
                            <span className="truncate">
                              {invoice.name || invoice.fileName}
                            </span>
                            {invoice.viewUrl && (
                              <a
                                href={invoice.viewUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                }}
                              >
                                <FileText className="size-4 shrink-0 text-muted-foreground hover:text-foreground" />
                              </a>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={getStatusVariant(invoice.status)}>
                            {invoice.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(invoice.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {(invoice.status === "ready" ||
                            invoice.status === "error") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteInvoiceMutation.mutate({
                                  invoiceId: invoice.id,
                                });
                              }}
                              disabled={deleteInvoiceMutation.isPending}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Invoice</CardTitle>
                  <CardDescription>
                    {(() => {
                      if (!selectedInvoice)
                        return "Select an invoice to view details.";
                      if (selectedInvoice.name)
                        return `${selectedInvoice.name} (${selectedInvoice.fileName})`;
                      return `(${selectedInvoice.fileName})`;
                    })()}
                  </CardDescription>
                </div>
                {selectedInvoice &&
                  (selectedInvoice.status === "ready" ||
                    selectedInvoice.status === "error") && (
                    <Link
                      from={Route.fullPath}
                      to="/app/$organizationId/invoices/$invoiceId"
                      params={{ organizationId, invoiceId: selectedInvoice.id }}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      <FilePenLine className="size-4" />
                      Edit invoice
                    </Link>
                  )}
              </div>
            </CardHeader>
            <CardContent>
              {(() => {
                if (displayedInvoice === null)
                  return (
                    <p className="text-sm text-muted-foreground">
                      No invoice selected.
                    </p>
                  );
                if (displayedInvoice.status === "error")
                  return (
                    <Alert variant="destructive">
                      <AlertCircle className="size-4" />
                      <AlertTitle>Extraction failed</AlertTitle>
                      <AlertDescription>
                        {displayedInvoice.error ?? "Unknown extraction error"}
                      </AlertDescription>
                    </Alert>
                  );
                if (displayedInvoice.status !== "ready")
                  return (
                    <p className="text-sm text-muted-foreground">
                      Extraction in progress.
                    </p>
                  );
                return (
                  <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                    <div className="flex flex-col gap-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-lg font-semibold">
                            {displayedInvoice.vendorName || "—"}
                          </p>
                          <p className="text-sm whitespace-pre-line text-muted-foreground">
                            {displayedInvoice.vendorAddress || "—"}
                          </p>
                          {displayedInvoice.vendorEmail && (
                            <p className="text-sm text-muted-foreground">
                              {displayedInvoice.vendorEmail}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium">
                            Invoice #{displayedInvoice.invoiceNumber || "—"}
                          </p>
                          {displayedInvoice.invoiceDate && (
                            <p className="text-sm text-muted-foreground">
                              Date: {displayedInvoice.invoiceDate}
                            </p>
                          )}
                          {displayedInvoice.dueDate && (
                            <p className="text-sm text-muted-foreground">
                              Due: {displayedInvoice.dueDate}
                            </p>
                          )}
                          {displayedInvoice.currency && (
                            <p className="text-sm text-muted-foreground">
                              Currency: {displayedInvoice.currency}
                            </p>
                          )}
                        </div>
                      </div>

                      <Separator />

                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
                          Bill To
                        </p>
                        <p className="text-sm font-medium">
                          {displayedInvoice.billToName || "—"}
                        </p>
                        <p className="text-sm whitespace-pre-line text-muted-foreground">
                          {displayedInvoice.billToAddress || "—"}
                        </p>
                        {displayedInvoice.billToEmail && (
                          <p className="text-sm text-muted-foreground">
                            {displayedInvoice.billToEmail}
                          </p>
                        )}
                      </div>

                      <Separator />

                      {(() => {
                        if (invoice && invoice.invoiceItems.length > 0)
                          return (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Description</TableHead>
                                  <TableHead className="text-right">
                                    Qty
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Unit Price
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Amount
                                  </TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {invoice.invoiceItems.map((item) => (
                                    <TableRow key={item.id}>
                                      <TableCell>
                                        <p>{item.description || "—"}</p>
                                        {item.period && (
                                          <p className="text-xs text-muted-foreground">
                                            {item.period}
                                          </p>
                                        )}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {item.quantity || "—"}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {item.unitPrice || "—"}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {item.amount || "—"}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                              </TableBody>
                            </Table>
                          );
                        return (
                          <p className="text-sm text-muted-foreground">
                            No line items.
                          </p>
                        );
                      })()}

                      <Separator />

                      <div className="flex flex-col items-end gap-1 text-sm">
                        {displayedInvoice.subtotal && (
                          <div className="flex gap-8">
                            <span className="text-muted-foreground">
                              Subtotal
                            </span>
                            <span>{displayedInvoice.subtotal}</span>
                          </div>
                        )}
                        {displayedInvoice.tax && (
                          <div className="flex gap-8">
                            <span className="text-muted-foreground">Tax</span>
                            <span>{displayedInvoice.tax}</span>
                          </div>
                        )}
                        {displayedInvoice.total && (
                          <div className="flex gap-8">
                            <span className="font-medium">Total</span>
                            <span className="font-medium">
                              {displayedInvoice.total}
                            </span>
                          </div>
                        )}
                        {displayedInvoice.amountDue && (
                          <div className="mt-1 flex gap-8 border-t pt-1">
                            <span className="font-semibold">Amount Due</span>
                            <span className="font-semibold">
                              {displayedInvoice.amountDue}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-sm font-medium">Extracted JSON</h4>
                        {displayedInvoice.extractedJson && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (displayedInvoice.extractedJson) {
                                void copyText(
                                  displayedInvoice.extractedJson,
                                  "json",
                                );
                              }
                            }}
                          >
                            <Copy className="size-4" />
                            {copiedField === "json" ? "Copied" : "Copy JSON"}
                          </Button>
                        )}
                      </div>
                      {displayedInvoice.extractedJson ? (
                        <pre className="max-h-144 overflow-auto rounded-md border bg-muted/30 p-4 text-xs leading-5 whitespace-pre-wrap">
                          {JSON.stringify(
                            JSON.parse(displayedInvoice.extractedJson),
                            null,
                            2,
                          )}
                        </pre>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No extracted data.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
