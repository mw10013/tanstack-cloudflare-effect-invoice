import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  decodeInvoiceExtraction,
  SAMPLE_INVOICE_MARKDOWN,
  InvoiceExtractionJsonSchema,
} from "@/lib/invoice-extraction";

interface AiSuccess {
  ok: true;
  model: string;
  elapsedMs: number;
  parsed: unknown;
  raw: unknown;
}

interface AiFailure {
  ok: false;
  model: string;
  elapsedMs: number;
  error: string;
}

type AiResult = AiSuccess | AiFailure;

const beforeLoadServerFn = createServerFn().handler(
  ({ context: { env } }) => {
    // oxlint-disable-next-line @typescript-eslint/only-throw-error -- notFound is a plain object; TanStack expects these thrown as-is
    if (env.ENVIRONMENT !== "local") throw notFound();
  },
);

const extractInvoice = createServerFn({ method: "POST" })
  .inputValidator((input: { markdown: string }) => input)
  .handler(async ({ data: { markdown }, context: { env } }) => {
    const model: keyof AiModels = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const startedAt = Date.now();
    try {
      const raw = await env.AI.run(
        model,
        {
          messages: [
            {
              role: "user",
              content: `Determine whether the following markdown is an invoice and extract only the total if present. Reply with JSON only.\n\n${markdown}`,
            },
          ],
          response_format: {
            type: "json_schema" as const,
            json_schema: InvoiceExtractionJsonSchema,
          },
          max_tokens: 256,
          temperature: 0,
        },
        {
          gateway: {
            id: env.AI_GATEWAY_ID,
            skipCache: true,
            cacheTtl: 7 * 24 * 60 * 60,
          },
        },
      );
      let responseData: unknown;
      if (typeof raw === "object" && raw !== null && "response" in raw) {
        responseData = raw.response;
      } else if (typeof raw === "string") {
        responseData = JSON.parse(raw) as unknown;
      } else {
        responseData = raw;
      }
      const parsed = decodeInvoiceExtraction(responseData);
      return {
        ok: true,
        model,
        elapsedMs: Date.now() - startedAt,
        parsed,
        raw,
      } satisfies AiSuccess;
    } catch (error) {
      return {
        ok: false,
        model,
        elapsedMs: Date.now() - startedAt,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      } satisfies AiFailure;
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
  const mutation = useMutation<AiResult>({
    mutationFn: async () =>
      (await extractInvoiceFn({ data: { markdown } })) as AiResult,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          Invoice Extraction Test
        </h1>
        <p className="text-sm text-muted-foreground">
          Extract structured invoice data via Workers AI with gateway caching.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            Uses @cf/meta/llama-3.3-70b-instruct-fp8-fast with json_schema
            response format via AI Gateway (skipCache, cacheTtl 7d).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            value={markdown}
            onChange={(event) => {
              setMarkdown(event.target.value);
            }}
            className="min-h-64"
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
            <p className="text-sm text-muted-foreground">
              {mutation.data.model} - {mutation.data.elapsedMs}ms
            </p>
          )}
        </CardContent>
      </Card>

      {mutation.data?.ok === false && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{mutation.data.error}</AlertDescription>
        </Alert>
      )}

      {mutation.data?.ok === true && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
            <CardDescription>Parsed extraction and raw payload</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <pre className="overflow-auto rounded-md border bg-muted/30 p-4 text-sm leading-5 whitespace-pre-wrap">
              {JSON.stringify(mutation.data.parsed, null, 2)}
            </pre>
            <pre className="overflow-auto rounded-md border bg-muted/30 p-4 text-xs leading-5 whitespace-pre-wrap">
              {JSON.stringify(mutation.data.raw, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
