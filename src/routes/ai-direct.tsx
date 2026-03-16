import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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

type AiTransport = "direct" | "gateway" | "simple-schema-gateway";

interface AiSuccess {
  ok: true;
  transport: AiTransport;
  model: string;
  elapsedMs: number;
  text: string;
  raw: unknown;
}

interface AiFailure {
  ok: false;
  transport: AiTransport;
  model: string;
  elapsedMs: number;
  error: string;
}

type AiResult = AiSuccess | AiFailure;

interface RunAiInput {
  transport: AiTransport;
  markdown: string;
}

const parseSimpleResponse = (raw: unknown): unknown => {
  if (typeof raw === "string") {
    return decodeInvoiceExtraction(JSON.parse(raw) as unknown);
  }
  if (typeof raw === "object" && raw !== null && "response" in raw) {
    return decodeInvoiceExtraction(
      typeof raw.response === "string"
        ? (JSON.parse(raw.response) as unknown)
        : raw.response,
    );
  }
  return raw;
};

const runAi = createServerFn({ method: "POST" })
  .inputValidator((input: RunAiInput) => input)
  .handler(async ({ data: { transport, markdown }, context: { env } }) => {
    const model: keyof AiModels = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const startedAt = Date.now();
    try {
      let raw: string | object;
      if (transport === "simple-schema-gateway") {
        raw = await env.AI.run(
          model,
          {
            prompt: `Determine whether the following markdown is an invoice and extract only the total if present. Reply with JSON only.\n\n${markdown}`,
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
      } else if (transport === "gateway") {
        raw = await env.AI.run(
          model,
          { prompt: "hi" },
          {
            gateway: {
              id: env.AI_GATEWAY_ID,
              skipCache: true,
              cacheTtl: 7 * 24 * 60 * 60,
            },
          },
        );
      } else {
        raw = await env.AI.run(model, { prompt: "hi" });
      }
      const elapsedMs = Date.now() - startedAt;
      let text: string;
      if (transport === "simple-schema-gateway") {
        text = JSON.stringify(parseSimpleResponse(raw), null, 2);
      } else if (typeof raw === "string") {
        text = raw;
      } else {
        text = JSON.stringify(raw);
      }
      return {
        ok: true,
        transport,
        model,
        elapsedMs,
        text,
        raw,
      } satisfies AiSuccess;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      return {
        ok: false,
        transport,
        model,
        elapsedMs,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      } satisfies AiFailure;
    }
  });

export const Route = createFileRoute("/ai-direct")({
  component: RouteComponent,
});

function RouteComponent() {
  const [markdown, setMarkdown] = React.useState(SAMPLE_INVOICE_MARKDOWN);
  const runAiServerFn = useServerFn(runAi);
  const mutation = useMutation<AiResult, Error, AiTransport>({
    mutationFn: async (transport) =>
      (await runAiServerFn({ data: { transport, markdown } })) as AiResult,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">AI Direct Test</h1>
        <p className="text-sm text-muted-foreground">
          Known-good direct and gateway tests, plus the smallest invoice-schema
          repro.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. `Run Simple Schema`
            is the only structured invoice test kept here.
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
                mutation.mutate("direct");
              }}
              disabled={mutation.isPending}
              variant="outline"
            >
              {mutation.isPending ? "Running..." : "Run Direct"}
            </Button>
            <Button
              onClick={() => {
                mutation.mutate("gateway");
              }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Running..." : "Run Gateway"}
            </Button>
            <Button
              onClick={() => {
                mutation.mutate("simple-schema-gateway");
              }}
              disabled={mutation.isPending}
              variant="outline"
            >
              {mutation.isPending ? "Running..." : "Run Simple Schema"}
            </Button>
          </div>
          {mutation.data && (
            <p className="text-sm text-muted-foreground">
              {mutation.data.transport} - {mutation.data.model} -{" "}
              {mutation.data.elapsedMs}ms
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
            <CardDescription>Text and raw payload</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <pre className="overflow-auto rounded-md border bg-muted/30 p-4 text-sm leading-5 whitespace-pre-wrap">
              {mutation.data.text}
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
