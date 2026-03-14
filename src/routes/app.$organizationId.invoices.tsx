import type { OrganizationAgent } from "@/organization-agent";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Cause, Config, Effect } from "effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { AlertCircle, FileText, Trash2, Upload } from "lucide-react";

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
  r2ObjectKey: Schema.NonEmptyString,
});

const invoiceMessageSchema = Schema.Struct({
  type: Schema.Literals(["invoice_uploaded", "invoice_deleted"]),
});

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
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        return yield* Effect.tryPromise(() => stub.getInvoices());
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
        yield* auth.getSession(request.headers).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.filterOrFail(
            (s) => !!s.session.activeOrganizationId,
            () => new Cause.NoSuchElementError(),
          ),
        );
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const env = yield* CloudflareEnv;
        const r2 = yield* R2;
        yield* r2.delete(data.r2ObjectKey);
        if (environment === "local") {
          const queue = yield* Effect.fromNullishOr(env.INVOICE_INGEST_Q);
          yield* Effect.tryPromise(() =>
            queue.send({
              account: "local",
              action: "DeleteObject",
              bucket: "tcei-r2-local",
              object: { key: data.r2ObjectKey },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        return { success: true, invoiceId: data.invoiceId };
      }),
    ),
  );

export const Route = createFileRoute("/app/$organizationId/invoices")({
  loader: ({ params: data }) => getInvoices({ data }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const invoices = Route.useLoaderData();
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      const result = Schema.decodeUnknownExit(
        Schema.fromJsonString(invoiceMessageSchema),
      )(String(event.data));
      if (Exit.isFailure(result)) return;
      void router.invalidate();
    },
  });

  const uploadServerFn = useServerFn(uploadInvoice);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      void router.invalidate();
    },
  });

  const deleteServerFn = useServerFn(deleteInvoice);
  const deleteMutation = useMutation({
    mutationFn: (input: { invoiceId: string; r2ObjectKey: string }) =>
      deleteServerFn({ data: input }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Upload and manage invoices. Supported formats: PDF, PNG, JPEG, WEBP,
          GIF (up to 10MB).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-5" />
            Upload Invoice
          </CardTitle>
          <CardDescription>
            Select a file to upload as an invoice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              uploadMutation.mutate(formData);
            }}
            className="flex items-end gap-3"
          >
            <div className="flex-1">
              <Input
                ref={fileInputRef}
                name="file"
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
                disabled={!isHydrated || uploadMutation.isPending}
              />
            </div>
            <Button
              type="submit"
              disabled={!isHydrated || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? "Uploading..." : "Upload"}
            </Button>
          </form>
          {uploadMutation.error && (
            <Alert variant="destructive" className="mt-3">
              <AlertCircle className="size-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>
                {uploadMutation.error.message}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {invoices.length} Invoice{invoices.length !== 1 && "s"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="w-25" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="flex items-center gap-2 font-medium">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{invoice.fileName}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invoice.contentType.split("/")[1]?.toUpperCase() ??
                        invoice.contentType}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          invoice.status === "uploaded"
                            ? "secondary"
                            : "default"
                        }
                      >
                        {invoice.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(invoice.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          deleteMutation.mutate({
                            invoiceId: invoice.id,
                            r2ObjectKey: invoice.r2ObjectKey,
                          });
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
