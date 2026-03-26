import { createServerFn } from "@tanstack/react-start";
import { Cause, Config, Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";

import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { Request as AppRequest } from "@/lib/Request";

const organizationIdSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
});

const getInvoiceWithItemsSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
  invoiceId: Schema.NonEmptyString,
});

export const updateInvoiceSchema = Schema.Struct({
  organizationId: Schema.NonEmptyString,
  invoiceId: Schema.NonEmptyString,
  name: Schema.String,
  ...OrganizationDomain.InvoiceExtractionFields.fields,
  invoiceItems: Schema.Array(OrganizationDomain.InvoiceItemFields),
});

interface UpdateInvoiceInput {
  readonly invoiceId: string;
  readonly name: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly vendorEmail: string;
  readonly vendorAddress: string;
  readonly billToName: string;
  readonly billToEmail: string;
  readonly billToAddress: string;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
  readonly amountDue: string;
  readonly invoiceItems: readonly (typeof OrganizationDomain.InvoiceItemFields.Type)[];
}

export const invoicesQueryKey = (organizationId: string) =>
  ["organization", organizationId, "invoices"] as const;

export const invoiceQueryKey = (organizationId: string, invoiceId: string) =>
  ["organization", organizationId, "invoice", invoiceId] as const;

const getOrganizationAgentStub = (organizationId: string) =>
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
    return ORGANIZATION_AGENT.get(id);
  });

export const getInvoices = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ context: { runEffect }, data: { organizationId } }) =>
    runEffect(
      Effect.gen(function* () {
        const stub = yield* getOrganizationAgentStub(organizationId);
        const invoices = yield* Effect.tryPromise(() => stub.getInvoices());
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
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

export const getInvoiceWithItems = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(getInvoiceWithItemsSchema))
  .handler(({ context: { runEffect }, data: { organizationId, invoiceId } }) =>
    runEffect(
      Effect.gen(function* () {
        const stub = yield* getOrganizationAgentStub(organizationId);
        // Type annotation strips Disposable from DO stub return type;
        // structuredClone strips it at runtime for TanStack Start serialization.
        const invoice: OrganizationDomain.InvoiceWithItems | null = yield* Effect.tryPromise(
          () => stub.getInvoiceWithItems(invoiceId),
        );
        return invoice ? structuredClone(invoice) : null;
      }),
    ),
  );

export const updateInvoiceWithAgent = (data: UpdateInvoiceInput & { organizationId: string }) =>
  Effect.gen(function* () {
    const stub = yield* getOrganizationAgentStub(data.organizationId);
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
    return yield* Effect.tryPromise(() =>
      stub.updateInvoice({
        invoiceId: data.invoiceId,
        name: data.name,
        invoiceNumber: data.invoiceNumber,
        invoiceDate: data.invoiceDate,
        dueDate: data.dueDate,
        currency: data.currency,
        vendorName: data.vendorName,
        vendorEmail: data.vendorEmail,
        vendorAddress: data.vendorAddress,
        billToName: data.billToName,
        billToEmail: data.billToEmail,
        billToAddress: data.billToAddress,
        subtotal: data.subtotal,
        tax: data.tax,
        total: data.total,
        amountDue: data.amountDue,
        invoiceItems: data.invoiceItems,
      }),
    );
  });

export type InvoiceListItem = Awaited<ReturnType<typeof getInvoices>>[number];
