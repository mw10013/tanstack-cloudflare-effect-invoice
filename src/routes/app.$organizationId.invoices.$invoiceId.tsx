/* oxlint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-confusing-void-expression -- TanStack Form: number-indexed template literals, void-returning field methods */
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AlertCircle, ArrowDown, ArrowLeft, ArrowUp, ExternalLink, FilePenLine, Loader2, Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getInvoiceViewUrl, getOrganizationAgentStub } from "@/lib/Invoices";
import { InvoiceFormSchema } from "@/lib/OrganizationAgentSchemas";
import { Organization } from "@/lib/Domain";
import * as OrganizationDomain from "@/lib/OrganizationDomain";
import { useOrganizationAgent } from "@/lib/OrganizationAgentContext";
import { Textarea } from "@/components/ui/textarea";

const invoiceFormStandardSchema = Schema.toStandardSchemaV1(InvoiceFormSchema);
const emptyInvoiceItem = () => ({ description: "", quantity: "", unitPrice: "", amount: "", period: "" });

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(Schema.Struct({ organizationId: Organization.fields.id, invoiceId: OrganizationDomain.Invoice.fields.id })))
  .handler(({ context: { runEffect }, data: { organizationId, invoiceId } }) =>
    runEffect(
      Effect.gen(function* () {
        const stub = yield* getOrganizationAgentStub(organizationId);
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
        const invoice: OrganizationDomain.InvoiceWithItems | null = yield* Effect.tryPromise(
          () => stub.getInvoice({ invoiceId }),
        );
        if (!invoice) return yield* Effect.die(notFound());
        const viewUrl = yield* getInvoiceViewUrl(organizationId, invoice);
        return { invoice: structuredClone(invoice), viewUrl };
      }),
    ),
  );

export const Route = createFileRoute("/app/$organizationId/invoices/$invoiceId")({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId, invoiceId } = Route.useParams();
  const { invoice, viewUrl } = Route.useLoaderData();
  const isHydrated = useHydrated();
  const router = useRouter();
  const { stub } = useOrganizationAgent();

  const defaultValues = {
    ...Struct.pick(invoice, ["name", "invoiceNumber", "invoiceDate", "dueDate", "currency", "vendorName", "vendorEmail", "vendorAddress", "billToName", "billToEmail", "billToAddress", "subtotal", "tax", "total", "amountDue"]),
    invoiceItems: invoice.invoiceItems.map((item) => Struct.pick(item, ["description", "quantity", "unitPrice", "amount", "period"])),
  } satisfies typeof InvoiceFormSchema.Type;

  const saveMutation = useMutation({
    mutationFn: (data: typeof defaultValues) =>
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- oxlint can't resolve Cloudflare Rpc conditional types; tsc infers correctly
      stub.updateInvoice({ invoiceId, ...data }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: invoiceFormStandardSchema,
    },
    onSubmit: ({ value }) => {
      void saveMutation.mutateAsync(value);
    },
  });

  const canEdit = invoice.status === "ready" || invoice.status === "error";

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/app/$organizationId/invoices"
            params={{ organizationId }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft className="size-4" />
            Back to invoices
          </Link>
          <div className="flex items-center gap-2">
            {viewUrl && (
              <a
                href={viewUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <ExternalLink className="size-4" />
                Open source file
              </a>
            )}
            <form.Subscribe selector={(state) => state.canSubmit}>
              {(canSubmit) => (
                <Button
                  type="button"
                  size="sm"
                  disabled={!isHydrated || !canEdit || !canSubmit || saveMutation.isPending}
                  onClick={() => void form.handleSubmit()}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FilePenLine className="size-4" />
                  )}
                  Save invoice
                </Button>
              )}
            </form.Subscribe>
          </div>
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Invoice</h1>
          <p className="text-sm text-muted-foreground">
            Update invoice fields and manage line items.
          </p>
        </div>
      </header>

      {invoice.status === "error" && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Extraction failed</AlertTitle>
          <AlertDescription>
            {invoice.error ?? "Unknown extraction error"} Saving manual edits will clear the error and mark the invoice ready.
          </AlertDescription>
        </Alert>
      )}

      {!canEdit && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>
            {invoice.status === "extracting"
              ? "This invoice is still extracting and cannot be edited yet."
              : "This invoice cannot be edited."}
          </AlertDescription>
        </Alert>
      )}

      {saveMutation.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>{saveMutation.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Invoice Details</CardTitle>
            <CardDescription>Edit all invoice-owned fields.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-6">
              <div className="grid gap-4 md:grid-cols-2">
                <form.Field name="name">{(field) => (<Field><FieldLabel>Invoice Name</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="invoiceNumber">{(field) => (<Field><FieldLabel>Invoice Number</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="invoiceDate">{(field) => (<Field><FieldLabel>Invoice Date</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="dueDate">{(field) => (<Field><FieldLabel>Due Date</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="currency">{(field) => (<Field><FieldLabel>Currency</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <form.Field name="vendorName">{(field) => (<Field><FieldLabel>Vendor Name</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="vendorEmail">{(field) => (<Field><FieldLabel>Vendor Email</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
              </div>

              <form.Field name="vendorAddress">{(field) => (<Field><FieldLabel>Vendor Address</FieldLabel><Textarea value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>

              <div className="grid gap-4 md:grid-cols-2">
                <form.Field name="billToName">{(field) => (<Field><FieldLabel>Bill To Name</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="billToEmail">{(field) => (<Field><FieldLabel>Bill To Email</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
              </div>

              <form.Field name="billToAddress">{(field) => (<Field><FieldLabel>Bill To Address</FieldLabel><Textarea value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <form.Field name="subtotal">{(field) => (<Field><FieldLabel>Subtotal</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="tax">{(field) => (<Field><FieldLabel>Tax</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="total">{(field) => (<Field><FieldLabel>Total</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
                <form.Field name="amountDue">{(field) => (<Field><FieldLabel>Amount Due</FieldLabel><Input value={field.state.value} disabled={!isHydrated || !canEdit} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></Field>)}</form.Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="flex h-0 min-h-full flex-col overflow-hidden">
          <CardHeader className="shrink-0">
            <form.Field name="invoiceItems" mode="array">
              {(itemsField) => (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Line Items</CardTitle>
                    <CardDescription>Order follows the row order shown here.</CardDescription>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!isHydrated || !canEdit}
                    onClick={() => itemsField.pushValue(emptyInvoiceItem())}
                  >
                    <Plus className="size-4" />
                    Add item
                  </Button>
                </div>
              )}
            </form.Field>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <form.Field name="invoiceItems" mode="array">
                {(itemsField) => (
                  <div className="flex flex-col gap-4">
                    {itemsField.state.value.map((_item, index) => (
                      <div key={index} className="rounded-lg border p-4">
                        <div className="mb-4 flex items-center justify-between gap-3">
                          <p className="text-sm font-medium">Item {index + 1}</p>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              disabled={!isHydrated || !canEdit || index === 0}
                              onClick={() => itemsField.swapValues(index - 1, index)}
                            >
                              <ArrowUp className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              disabled={!isHydrated || !canEdit || index === itemsField.state.value.length - 1}
                              onClick={() => itemsField.swapValues(index, index + 1)}
                            >
                              <ArrowDown className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              disabled={!isHydrated || !canEdit || itemsField.state.value.length === 1}
                              onClick={() => itemsField.removeValue(index)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="grid gap-4">
                          <form.Field name={`invoiceItems[${index}].description`}>
                            {(subField) => (
                              <Field>
                                <FieldLabel>Description</FieldLabel>
                                <Textarea
                                  value={subField.state.value}
                                  disabled={!isHydrated || !canEdit}
                                  onBlur={subField.handleBlur}
                                  onChange={(e) => subField.handleChange(e.target.value)}
                                />
                              </Field>
                            )}
                          </form.Field>
                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                            <form.Field name={`invoiceItems[${index}].quantity`}>
                              {(subField) => (
                                <Field>
                                  <FieldLabel>Quantity</FieldLabel>
                                  <Input
                                    value={subField.state.value}
                                    disabled={!isHydrated || !canEdit}
                                    onBlur={subField.handleBlur}
                                    onChange={(e) => subField.handleChange(e.target.value)}
                                  />
                                </Field>
                              )}
                            </form.Field>
                            <form.Field name={`invoiceItems[${index}].unitPrice`}>
                              {(subField) => (
                                <Field>
                                  <FieldLabel>Unit Price</FieldLabel>
                                  <Input
                                    value={subField.state.value}
                                    disabled={!isHydrated || !canEdit}
                                    onBlur={subField.handleBlur}
                                    onChange={(e) => subField.handleChange(e.target.value)}
                                  />
                                </Field>
                              )}
                            </form.Field>
                            <form.Field name={`invoiceItems[${index}].amount`}>
                              {(subField) => (
                                <Field>
                                  <FieldLabel>Amount</FieldLabel>
                                  <Input
                                    value={subField.state.value}
                                    disabled={!isHydrated || !canEdit}
                                    onBlur={subField.handleBlur}
                                    onChange={(e) => subField.handleChange(e.target.value)}
                                  />
                                </Field>
                              )}
                            </form.Field>
                            <form.Field name={`invoiceItems[${index}].period`}>
                              {(subField) => (
                                <Field>
                                  <FieldLabel>Period</FieldLabel>
                                  <Input
                                    value={subField.state.value}
                                    disabled={!isHydrated || !canEdit}
                                    onBlur={subField.handleBlur}
                                    onChange={(e) => subField.handleChange(e.target.value)}
                                  />
                                </Field>
                              )}
                            </form.Field>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </form.Field>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}


