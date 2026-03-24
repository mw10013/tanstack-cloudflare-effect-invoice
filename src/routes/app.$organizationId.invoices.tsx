import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Cause, Config, Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { AlertCircle, Copy, FileText, Loader2, Plus, Trash2, Upload } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import type { InvoiceWithItems } from "@/lib/OrganizationDomain";
import { useOrganizationAgent } from "@/lib/OrganizationAgentContext";
import { Request as AppRequest } from "@/lib/Request";

const organizationIdSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
});

const getInvoiceWithItemsSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
  invoiceId: Schema.NonEmptyString,
});

const getStatusVariant = (
  status: string,
): "default" | "destructive" | "secondary" => {
  if (status === "ready") return "default";
  if (status === "error") return "destructive";
  return "secondary";
};

const invoicesQueryKey = (organizationId: string) =>
  ["organization", organizationId, "invoices"] as const;

const invoiceQueryKey = (organizationId: string, invoiceId: string) =>
  ["organization", organizationId, "invoice", invoiceId] as const;

const getInvoices = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ context: { runEffect }, data: { organizationId } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.filterOrFail(
            (s) => s.session.activeOrganizationId === organizationId,
            () => new Cause.NoSuchElementError(),
          ),
        );
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        const invoices = yield* Effect.tryPromise(() => stub.getInvoices());
        if (environment === "local") {
          return invoices.map((invoice) => ({
            ...invoice,
            viewUrl: invoice.r2ObjectKey
              ? `/api/org/${organizationId}/invoice/${encodeURIComponent(invoice.id)}`
              : undefined,
          }));
        }
        const r2BucketName = yield* Config.nonEmptyString("R2_BUCKET_NAME");
        const r2S3AccessKeyId = yield* Config.redacted("R2_S3_ACCESS_KEY_ID");
        const r2S3SecretAccessKey =
          yield* Config.redacted("R2_S3_SECRET_ACCESS_KEY");
        const cfAccountId = yield* Config.nonEmptyString("CF_ACCOUNT_ID");
        const { AwsClient } = yield* Effect.tryPromise(() => import("aws4fetch"));
        const client = new AwsClient({
          service: "s3",
          region: "auto",
          accessKeyId: Redacted.value(r2S3AccessKeyId),
          secretAccessKey: Redacted.value(r2S3SecretAccessKey),
        });
        return yield* Effect.all(
          invoices.map((invoice) =>
            invoice.r2ObjectKey
              ? Effect.tryPromise(async () => {
                  const signed = await client.sign(
                    new Request(
                      `https://${cfAccountId}.r2.cloudflarestorage.com/${r2BucketName}/${invoice.r2ObjectKey}?X-Amz-Expires=900`,
                      { method: "GET" },
                    ),
                    { aws: { signQuery: true } },
                  );
                  return { ...invoice, viewUrl: signed.url as string | undefined };
                })
              : Effect.succeed({ ...invoice, viewUrl: undefined as string | undefined }),
          ),
          { concurrency: 10 },
        );
      }),
    ),
  );

const getInvoiceWithItems = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(getInvoiceWithItemsSchema))
  .handler(({ context: { runEffect }, data: { organizationId, invoiceId } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.filterOrFail(
            (s) => s.session.activeOrganizationId === organizationId,
            () => new Cause.NoSuchElementError(),
          ),
        );
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        const invoice: InvoiceWithItems = yield* Effect.tryPromise(() =>
          stub.getInvoiceWithItems(invoiceId),
        );
        return structuredClone(invoice);
      }),
    ),
  );

type InvoiceListItem = Awaited<ReturnType<typeof getInvoices>>[number];

export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: async ({ params: { organizationId }, context }) => {
    const invoices = await context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
    });
    const firstInvoiceId = invoices[0]?.id;
    if (firstInvoiceId) {
      await context.queryClient.ensureQueryData({
        queryKey: invoiceQueryKey(organizationId, firstInvoiceId),
        queryFn: () =>
          getInvoiceWithItems({
            data: { organizationId, invoiceId: firstInvoiceId },
          }),
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = React.useState<string | null>(
    null,
  );
  const [copiedField, setCopiedField] = React.useState<"json" | null>(null);

  const invoicesQuery = useQuery({
    queryKey: invoicesQueryKey(organizationId),
    queryFn: () => getInvoices({ data: { organizationId } }),
  });
  const invoices = invoicesQuery.data ?? [];

  const selectedInvoice =
    invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? invoices[0] ?? null;

  const copyText = React.useCallback(async (value: string, field: "json") => {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 2000);
  }, []);

  React.useEffect(() => {
    if (selectedInvoiceId === null && invoicesQuery.data?.[0]) {
      setSelectedInvoiceId(invoicesQuery.data[0].id);
      return;
    }
    if (
      selectedInvoiceId !== null &&
      invoicesQuery.data &&
      !invoicesQuery.data.some((invoice) => invoice.id === selectedInvoiceId)
    ) {
      setSelectedInvoiceId(invoicesQuery.data[0]?.id ?? null);
    }
  }, [invoicesQuery.data, selectedInvoiceId]);

  const { stub } = useOrganizationAgent();
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCodePoint(...new Uint8Array(buffer)));
      return stub.uploadInvoice({ fileName: file.name, contentType: file.type, base64 });
    },
    onSuccess: (result) => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedInvoiceId(result.invoiceId);
      void queryClient.invalidateQueries({
        queryKey: invoicesQueryKey(organizationId),
      });
    },
  });
  const createInvoiceMutation = useMutation({
    mutationFn: () => stub.createInvoice(),
    onSuccess: (result) => {
      setSelectedInvoiceId(result.invoiceId);
      void queryClient.invalidateQueries({
        queryKey: invoicesQueryKey(organizationId),
      });
    },
  });
  const softDeleteInvoiceMutation = useMutation({
    mutationFn: ({ invoiceId }: { invoiceId: string }) =>
      stub.softDeleteInvoice(invoiceId),
  });

  const getInvoiceWithItemsFn = useServerFn(getInvoiceWithItems);
  const invoiceQuery = useQuery<InvoiceWithItems>({
    queryKey: [
      ...invoiceQueryKey(organizationId, selectedInvoice?.id ?? ""),
      getInvoiceWithItemsFn,
    ],
    queryFn: () =>
      getInvoiceWithItemsFn({
        data: { organizationId, invoiceId: selectedInvoice?.id ?? "" },
      }),
    enabled: selectedInvoice !== null && selectedInvoice.status === "ready",
  });
  const invoice: InvoiceWithItems | null = invoiceQuery.data ?? null;
  const displayedInvoice: InvoiceWithItems | InvoiceListItem | null =
    selectedInvoice?.status === "ready" ? invoice ?? selectedInvoice : selectedInvoice;

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
                <CardDescription>Upload or create an invoice to get started.</CardDescription>
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
                  onClick={() => { createInvoiceMutation.mutate(); }}
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
            {uploadMutation.error && (
              <Alert variant="destructive" className="mt-2">
                <AlertCircle className="size-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  {uploadMutation.error.message}
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
                    onClick={() => { createInvoiceMutation.mutate(); }}
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
              {uploadMutation.error && (
                <Alert variant="destructive" className="mt-2">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {uploadMutation.error.message}
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
                      data-state={selectedInvoiceId === invoice.id ? "selected" : undefined}
                      className="h-12"
                      onClick={() =>{  setSelectedInvoiceId(invoice.id); }}
                    >
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          <span className="truncate">{invoice.name || invoice.fileName}</span>
                          {invoice.viewUrl && (
                            <a
                              href={invoice.viewUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => { e.stopPropagation(); }}
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
                        {(invoice.status === "ready" || invoice.status === "error") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              softDeleteInvoiceMutation.mutate({ invoiceId: invoice.id });
                            }}
                            disabled={softDeleteInvoiceMutation.isPending}
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
              <CardTitle>Invoice</CardTitle>
              <CardDescription>
{(() => {
                  if (!selectedInvoice) return "Select an invoice to view details."
                  if (selectedInvoice.name) return `${selectedInvoice.name} (${selectedInvoice.fileName})`
                  return `(${selectedInvoice.fileName})`
                })()}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                if (displayedInvoice === null)
                  return <p className="text-sm text-muted-foreground">No invoice selected.</p>;
                if (displayedInvoice.status === "deleted")
                  return <p className="text-sm text-muted-foreground">This invoice has been deleted.</p>;
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
                  return <p className="text-sm text-muted-foreground">Extraction in progress.</p>;
                return (
                  <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                    <div className="flex flex-col gap-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-lg font-semibold">{displayedInvoice.vendorName || "—"}</p>
                          <p className="whitespace-pre-line text-sm text-muted-foreground">{displayedInvoice.vendorAddress || "—"}</p>
                          {displayedInvoice.vendorEmail && (
                            <p className="text-sm text-muted-foreground">{displayedInvoice.vendorEmail}</p>
                          )}
                        </div>
                        <div className="text-right">
                           <p className="text-sm font-medium">Invoice #{displayedInvoice.invoiceNumber || "—"}</p>
                           {displayedInvoice.invoiceDate && (
                             <p className="text-sm text-muted-foreground">Date: {displayedInvoice.invoiceDate}</p>
                           )}
                           {displayedInvoice.dueDate && (
                             <p className="text-sm text-muted-foreground">Due: {displayedInvoice.dueDate}</p>
                           )}
                           {displayedInvoice.currency && (
                             <p className="text-sm text-muted-foreground">Currency: {displayedInvoice.currency}</p>
                           )}
                        </div>
                      </div>

                      <Separator />

                      <div>
                        <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Bill To</p>
                        <p className="text-sm font-medium">{displayedInvoice.billToName || "—"}</p>
                        <p className="whitespace-pre-line text-sm text-muted-foreground">{displayedInvoice.billToAddress || "—"}</p>
                        {displayedInvoice.billToEmail && (
                          <p className="text-sm text-muted-foreground">{displayedInvoice.billToEmail}</p>
                        )}
                      </div>

                      <Separator />

                      {(() => {
                        if (invoiceQuery.isLoading)
                          return (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="size-4 animate-spin" />
                              Loading line items...
                            </div>
                          );
                        if (invoice && invoice.items.length > 0)
                          return (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Description</TableHead>
                                  <TableHead className="text-right">Qty</TableHead>
                                  <TableHead className="text-right">Unit Price</TableHead>
                                  <TableHead className="text-right">Amount</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {invoice.items.map((item: InvoiceWithItems["items"][number]) => (
                                  <TableRow key={item.id}>
                                    <TableCell>
                                      <p>{item.description || "—"}</p>
                                      {item.period && (
                                        <p className="text-xs text-muted-foreground">{item.period}</p>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-right">{item.quantity || "—"}</TableCell>
                                    <TableCell className="text-right">{item.unitPrice || "—"}</TableCell>
                                    <TableCell className="text-right">{item.amount || "—"}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          );
                        return <p className="text-sm text-muted-foreground">No line items.</p>;
                      })()}

                      <Separator />

                      <div className="flex flex-col items-end gap-1 text-sm">
                        {displayedInvoice.subtotal && (
                          <div className="flex gap-8">
                            <span className="text-muted-foreground">Subtotal</span>
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
                            <span className="font-medium">{displayedInvoice.total}</span>
                          </div>
                        )}
                        {displayedInvoice.amountDue && (
                          <div className="mt-1 flex gap-8 border-t pt-1">
                            <span className="font-semibold">Amount Due</span>
                            <span className="font-semibold">{displayedInvoice.amountDue}</span>
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
                                void copyText(displayedInvoice.extractedJson, "json");
                              }
                            }}
                          >
                            <Copy className="size-4" />
                            {copiedField === "json" ? "Copied" : "Copy JSON"}
                          </Button>
                        )}
                      </div>
                      {displayedInvoice.extractedJson ? (
                        <pre className="max-h-144 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
                          {JSON.stringify(JSON.parse(displayedInvoice.extractedJson), null, 2)}
                        </pre>
                      ) : (
                        <p className="text-sm text-muted-foreground">No extracted data.</p>
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
