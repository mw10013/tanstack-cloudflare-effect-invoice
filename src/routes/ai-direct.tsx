import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  INVOICE_EXTRACTION_MODEL,
  SAMPLE_INVOICE_MARKDOWN,
  runInvoiceExtractionViaGateway,
} from "@/lib/invoice-extraction";

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { env } }) => {
    // oxlint-disable-next-line @typescript-eslint/only-throw-error -- notFound is a plain object; TanStack expects these thrown as-is
    if (env.ENVIRONMENT !== "local") throw notFound();
  },
);

const extractInvoice = createServerFn({ method: "POST" })
  .inputValidator((input: { markdown: string }) => input)
  .handler(async ({ data: { markdown }, context: { env } }) => {
    const startedAt = Date.now();
    try {
      const parsed = await runInvoiceExtractionViaGateway({
        accountId: env.CF_ACCOUNT_ID,
        gatewayId: env.AI_GATEWAY_ID,
        workersAiApiToken: env.WORKERS_AI_API_TOKEN,
        aiGatewayToken: env.AI_GATEWAY_TOKEN,
        markdown,
      });
      return {
        ok: true as const,
        model: INVOICE_EXTRACTION_MODEL,
        elapsedMs: Date.now() - startedAt,
        parsed,
      };
    } catch (error) {
      return {
        ok: false as const,
        model: INVOICE_EXTRACTION_MODEL,
        elapsedMs: Date.now() - startedAt,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      };
    }
  });

export const Route = createFileRoute("/ai-direct")({
  beforeLoad: async () => {
    await beforeLoadServerFn();
  },
  component: RouteComponent,
});

function RouteComponent() {
  const [markdown, setMarkdown] = React.useState(SAMPLE_INVOICE_MARKDOWN);
  const extractInvoiceFn = useServerFn(extractInvoice);
  const mutation = useMutation({
    mutationFn: () => extractInvoiceFn({ data: { markdown } }),
  });

  return (
    <div className="mx-auto flex h-screen w-full max-w-3xl flex-col gap-4 overflow-hidden p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          Invoice Extraction Test
        </h1>
        <p className="text-sm text-muted-foreground">
          Extract structured invoice data via Workers AI with gateway caching.
        </p>
      </header>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            Uses {INVOICE_EXTRACTION_MODEL} with json_schema response format via
            AI Gateway (skipCache, cacheTtl 7d).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <Textarea
            value={markdown}
            onChange={(event) => {
              setMarkdown(event.target.value);
            }}
            className="min-h-0 flex-1 resize-none"
          />
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                mutation.mutate();
              }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Extracting..." : "Extract Invoice"}
            </Button>
          </div>
          {mutation.data && (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <p className="text-sm text-muted-foreground">
                {mutation.data.model} - {mutation.data.elapsedMs}ms
              </p>
              {!mutation.data.ok && (
                <p className="text-sm text-destructive">{mutation.data.error}</p>
              )}
              {mutation.data.ok && (
                <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 text-sm leading-5 whitespace-pre-wrap break-words">
                  {JSON.stringify(mutation.data.parsed, null, 2)}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
