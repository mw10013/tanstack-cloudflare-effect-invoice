import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
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
import { R2 } from "@/lib/R2";
import { Request as AppRequest } from "@/lib/Request";

const organizationIdSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
});

const invoiceMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const invoiceFileSchema = Schema.File.check(Schema.isMinSize(1))
  .check(Schema.isMaxSize(10_000_000))
  .check(
    Schema.makeFilter((file) =>
      invoiceMimeTypes.includes(file.type as (typeof invoiceMimeTypes)[number]),
    ),
  );

const uploadFormSchema = Schema.Struct({
  file: invoiceFileSchema,
});

const deleteInvoiceSchema = Schema.Struct({
  invoiceId: Schema.NonEmptyString,
});

const getInvoiceItemsSchema = Schema.Struct({
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

const invoiceItemsQueryKey = (organizationId: string, invoiceId: string) =>
  ["organization", organizationId, "invoiceItems", invoiceId] as const;

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

const uploadInvoice = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new TypeError("Expected FormData");
    return Schema.decodeUnknownSync(uploadFormSchema)(Object.fromEntries(data));
  })
  .handler(({ context: { runEffect }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        const validSession = yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
        );
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const env = yield* CloudflareEnv;
        const r2 = yield* R2;
        const invoiceId = crypto.randomUUID();
        const key = `${organizationId}/invoices/${invoiceId}`;
        const idempotencyKey = crypto.randomUUID();
        yield* r2.put(key, data.file, {
          httpMetadata: { contentType: data.file.type },
          customMetadata: {
            organizationId,
            invoiceId,
            idempotencyKey,
            fileName: data.file.name,
            contentType: data.file.type,
          },
        });
        if (environment === "local") {
          const queue = yield* Effect.fromNullishOr(env.INVOICE_INGEST_Q);
          yield* Effect.tryPromise(() =>
            queue.send({
              account: "local",
              action: "PutObject",
              bucket: "tcei-r2-local",
              object: { key, size: data.file.size, eTag: "local" },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        return { success: true, invoiceId, size: data.file.size };
      }),
    ),
  );

const deleteInvoice = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(deleteInvoiceSchema))
  .handler(({ context: { runEffect }, data }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        const validSession = yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.filterOrFail(
            (s) => !!s.session.activeOrganizationId,
            () => new Cause.NoSuchElementError(),
          ),
        );
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        yield* Effect.tryPromise(() => stub.softDeleteInvoice(data.invoiceId));
        return { success: true, invoiceId: data.invoiceId };
      }),
    ),
  );

const createInvoice = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* AppRequest;
        const auth = yield* Auth;
        const validSession = yield* auth
          .getSession(request.headers)
          .pipe(Effect.flatMap(Effect.fromOption));
        const organizationId = yield* Effect.fromNullishOr(
          validSession.session.activeOrganizationId,
        );
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        const { invoiceId } = yield* Effect.tryPromise(() =>
          stub.createInvoice(),
        );
        return { invoiceId };
      }),
    ),
);

const getInvoiceItems = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(getInvoiceItemsSchema))
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
        return yield* Effect.tryPromise(() => stub.getInvoiceItems(invoiceId));
      }),
    ),
  );

export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: ({ params: { organizationId }, context }) =>
    context.queryClient.ensureQueryData({
      queryKey: invoicesQueryKey(organizationId),
      queryFn: () => getInvoices({ data: { organizationId } }),
    }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const router = useRouter();
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

  const uploadServerFn = useServerFn(uploadInvoice);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      void router.invalidate();
    },
  });

  const createInvoiceServerFn = useServerFn(createInvoice);
  const createMutation = useMutation({
    mutationFn: () => createInvoiceServerFn({ data: undefined }),
    onSuccess: (result) => {
      setSelectedInvoiceId(result.invoiceId);
      void queryClient.invalidateQueries({
        queryKey: invoicesQueryKey(organizationId),
      });
    },
  });

  const deleteServerFn = useServerFn(deleteInvoice);
  const deleteMutation = useMutation({
    mutationFn: (input: { invoiceId: string }) =>
      deleteServerFn({ data: input }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const getInvoiceItemsFn = useServerFn(getInvoiceItems);
  const invoiceItemsQuery = useQuery({
    queryKey: [
      ...invoiceItemsQueryKey(organizationId, selectedInvoice?.id ?? ""),
      getInvoiceItemsFn,
    ],
    queryFn: () =>
      getInvoiceItemsFn({
        data: { organizationId, invoiceId: selectedInvoice?.id ?? "" },
      }),
    enabled: selectedInvoice !== null && selectedInvoice.status === "ready",
  });

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
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  uploadMutation.mutate(formData);
                }}
                className="flex items-center gap-2"
              >
                <Input
                  ref={fileInputRef}
                  name="file"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
                  disabled={!isHydrated || uploadMutation.isPending}
                  className="w-auto"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!isHydrated || uploadMutation.isPending}
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
                  disabled={!isHydrated || createMutation.isPending}
                  onClick={() => { createMutation.mutate(); }}
                >
                  {createMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  New Invoice
                </Button>
              </form>
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
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    uploadMutation.mutate(formData);
                  }}
                  className="flex items-center gap-2"
                >
                  <Input
                    ref={fileInputRef}
                    name="file"
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
                    disabled={!isHydrated || uploadMutation.isPending}
                    className="w-auto"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!isHydrated || uploadMutation.isPending}
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
                    disabled={!isHydrated || createMutation.isPending}
                    onClick={() => { createMutation.mutate(); }}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    New Invoice
                  </Button>
                </form>
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
                      <TableHead>File</TableHead>
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
                      className="cursor-pointer"
                      onClick={() =>{  setSelectedInvoiceId(invoice.id); }}
                    >
                      <TableCell className="flex items-center gap-2 font-medium">
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
                        <span className="truncate">{invoice.name || invoice.fileName}</span>
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
                              deleteMutation.mutate({ invoiceId: invoice.id });
                            }}
                            disabled={deleteMutation.isPending}
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
                if (selectedInvoice === null)
                  return <p className="text-sm text-muted-foreground">No invoice selected.</p>;
                if (selectedInvoice.status === "deleted")
                  return <p className="text-sm text-muted-foreground">This invoice has been deleted.</p>;
                if (selectedInvoice.status === "error")
                  return (
                    <Alert variant="destructive">
                      <AlertCircle className="size-4" />
                      <AlertTitle>Extraction failed</AlertTitle>
                      <AlertDescription>
                        {selectedInvoice.error ?? "Unknown extraction error"}
                      </AlertDescription>
                    </Alert>
                  );
                if (selectedInvoice.status !== "ready")
                  return <p className="text-sm text-muted-foreground">Extraction in progress.</p>;
                return (
                  <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                    <div className="flex flex-col gap-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-lg font-semibold">{selectedInvoice.vendorName || "—"}</p>
                          <p className="whitespace-pre-line text-sm text-muted-foreground">{selectedInvoice.vendorAddress || "—"}</p>
                          {selectedInvoice.vendorEmail && (
                            <p className="text-sm text-muted-foreground">{selectedInvoice.vendorEmail}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium">Invoice #{selectedInvoice.invoiceNumber || "—"}</p>
                          {selectedInvoice.invoiceDate && (
                            <p className="text-sm text-muted-foreground">Date: {selectedInvoice.invoiceDate}</p>
                          )}
                          {selectedInvoice.dueDate && (
                            <p className="text-sm text-muted-foreground">Due: {selectedInvoice.dueDate}</p>
                          )}
                          {selectedInvoice.currency && (
                            <p className="text-sm text-muted-foreground">Currency: {selectedInvoice.currency}</p>
                          )}
                        </div>
                      </div>

                      <Separator />

                      <div>
                        <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Bill To</p>
                        <p className="text-sm font-medium">{selectedInvoice.billToName || "—"}</p>
                        <p className="whitespace-pre-line text-sm text-muted-foreground">{selectedInvoice.billToAddress || "—"}</p>
                        {selectedInvoice.billToEmail && (
                          <p className="text-sm text-muted-foreground">{selectedInvoice.billToEmail}</p>
                        )}
                      </div>

                      <Separator />

                      {(() => {
                        if (invoiceItemsQuery.isLoading)
                          return (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="size-4 animate-spin" />
                              Loading line items...
                            </div>
                          );
                        if (invoiceItemsQuery.data && invoiceItemsQuery.data.length > 0)
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
                                {invoiceItemsQuery.data.map((item) => (
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
                        {selectedInvoice.subtotal && (
                          <div className="flex gap-8">
                            <span className="text-muted-foreground">Subtotal</span>
                            <span>{selectedInvoice.subtotal}</span>
                          </div>
                        )}
                        {selectedInvoice.tax && (
                          <div className="flex gap-8">
                            <span className="text-muted-foreground">Tax</span>
                            <span>{selectedInvoice.tax}</span>
                          </div>
                        )}
                        {selectedInvoice.total && (
                          <div className="flex gap-8">
                            <span className="font-medium">Total</span>
                            <span className="font-medium">{selectedInvoice.total}</span>
                          </div>
                        )}
                        {selectedInvoice.amountDue && (
                          <div className="mt-1 flex gap-8 border-t pt-1">
                            <span className="font-semibold">Amount Due</span>
                            <span className="font-semibold">{selectedInvoice.amountDue}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-sm font-medium">Extracted JSON</h4>
                        {selectedInvoice.extractedJson && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (selectedInvoice.extractedJson) {
                                void copyText(selectedInvoice.extractedJson, "json");
                              }
                            }}
                          >
                            <Copy className="size-4" />
                            {copiedField === "json" ? "Copied" : "Copy JSON"}
                          </Button>
                        )}
                      </div>
                      {selectedInvoice.extractedJson ? (
                        <pre className="max-h-144 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
                          {JSON.stringify(JSON.parse(selectedInvoice.extractedJson), null, 2)}
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
