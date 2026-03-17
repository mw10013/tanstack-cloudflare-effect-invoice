import * as Schema from "effect/Schema";

const LineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
});

export const InvoiceExtractionSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  invoiceNumber: Schema.String,
  invoiceDate: Schema.String,
  dueDate: Schema.String,
  currency: Schema.String,
  vendorName: Schema.String,
  vendorEmail: Schema.String,
  vendorAddress: Schema.String,
  billToName: Schema.String,
  billToEmail: Schema.String,
  billToAddress: Schema.String,
  lineItems: Schema.Array(LineItemSchema),
  subtotal: Schema.String,
  tax: Schema.String,
  total: Schema.String,
  amountDue: Schema.String,
});

export const decodeInvoiceExtraction = Schema.decodeUnknownSync(
  InvoiceExtractionSchema,
);

const decodeInvoiceExtractionFromJsonString = Schema.decodeUnknownSync(
  Schema.fromJsonString(InvoiceExtractionSchema),
);

export const InvoiceExtractionJsonSchema = Schema.toJsonSchemaDocument(
  InvoiceExtractionSchema,
).schema;

export const INVOICE_EXTRACTION_MODEL: keyof AiModels =
  "@cf/openai/gpt-oss-120b";

const isResponsesApiModel = (model: keyof AiModels) =>
  model === "@cf/openai/gpt-oss-120b" || model === "@cf/openai/gpt-oss-20b";

const AiResponseSchema = Schema.Struct({
  response: Schema.Union([
    InvoiceExtractionSchema,
    Schema.fromJsonString(InvoiceExtractionSchema),
  ]),
});

const decodeAiResponse = Schema.decodeUnknownSync(AiResponseSchema);

const ResponsesApiTextSchema = Schema.Struct({
  output_text: Schema.String,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractResponsesApiPayload = (raw: unknown) =>
  isRecord(raw) && "result" in raw ? raw.result : raw;

const extractResponsesApiOutputText = (raw: unknown): string => {
  const payload = extractResponsesApiPayload(raw);
  const direct = Schema.decodeUnknownOption(ResponsesApiTextSchema)(payload);
  if (direct._tag === "Some") return direct.value.output_text;
  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error("Responses API payload missing output_text");
  }
  for (const item of payload.output) {
    if (isRecord(item) && item.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (
          isRecord(content) &&
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          return content.text;
        }
      }
    }
  }
  throw new Error("Responses API message output_text not found");
};

const AiGatewayErrorSchema = Schema.Struct({
  name: Schema.String,
  internalCode: Schema.Number,
  httpCode: Schema.Number,
  message: Schema.String,
  description: Schema.String,
  requestId: Schema.String,
});

const buildPrompt = (markdown: string) =>
  `You are an invoice data extraction assistant. You will receive markdown converted from a PDF document.

Analyze the document and extract structured invoice data according to the provided JSON schema.

Rules:
- Set isInvoice to true only if the document is clearly an invoice.
- If isInvoice is false, set all other fields to empty string "".
- Extract only information explicitly present in the document. Never infer or guess values.
- Set fields to empty string "" when the information is not found in the document.
- Keep amounts as strings exactly as they appear in the document, including currency symbols (e.g., "$5.39", "$0.011 per 1,000").
- Keep dates as strings in whatever format appears in the document.
- For line items, include every line item found. Set quantity, unitPrice, or amount to empty string "" if not clearly stated for that item.
- For addresses, concatenate all address components into a single string (e.g., "101 Townsend Street, San Francisco, California 94107, United States"). Set to empty string "" if no address is found.

Document:

${markdown}`;

const buildTextGenerationRequestBody = (markdown: string) => ({
  prompt: buildPrompt(markdown),
  response_format: {
    type: "json_schema" as const,
    json_schema: InvoiceExtractionJsonSchema,
  },
  max_tokens: 8192,
  temperature: 0,
});

const buildResponsesApiRequestBody = (markdown: string): ResponsesInput => ({
  input: buildPrompt(markdown),
  text: {
    format: {
      type: "json_schema",
      name: "invoice_extraction",
      schema: InvoiceExtractionJsonSchema,
      strict: true,
    },
  },
  max_output_tokens: 8192,
  reasoning: {
    effort: "medium",
  },
  temperature: 0,
});

const buildRequestBody = (markdown: string) =>
  isResponsesApiModel(INVOICE_EXTRACTION_MODEL)
    ? buildResponsesApiRequestBody(markdown)
    : buildTextGenerationRequestBody(markdown);

const decodeInvoiceExtractionResponse = (raw: unknown) => {
  if (isResponsesApiModel(INVOICE_EXTRACTION_MODEL)) {
    return decodeInvoiceExtractionFromJsonString(
      extractResponsesApiOutputText(raw),
    );
  }
  return decodeAiResponse(raw).response;
};

export const runInvoiceExtraction = async ({
  ai,
  gatewayId,
  markdown,
}: {
  readonly ai: Ai;
  readonly gatewayId: string;
  readonly markdown: string;
}) => {
  console.log("[invoice-extraction] starting via ai.run()", {
    model: INVOICE_EXTRACTION_MODEL,
    gatewayId,
    markdownLength: markdown.length,
  });
  let raw: unknown;
  const startedAt = Date.now();
  try {
    raw = await ai.run(
      INVOICE_EXTRACTION_MODEL,
      {
        ...buildRequestBody(markdown),
      },
      {
        gateway: {
          id: gatewayId,
          skipCache: true,
          cacheTtl: 7 * 24 * 60 * 60,
        },
      },
    );
  } catch (error) {
    console.error("[invoice-extraction] ai.run threw", {
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  console.log("[invoice-extraction] ai.run returned", {
    elapsedMs: Date.now() - startedAt,
    raw: JSON.stringify(raw),
  });
  try {
    const decoded = decodeInvoiceExtractionResponse(raw);
    console.log("[invoice-extraction] decoded", decoded);
    return decoded;
  } catch (error) {
    console.error("[invoice-extraction] decode failed", {
      raw: JSON.stringify(raw),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

const GATEWAY_REQUEST_TIMEOUT_MS = 300_000;

export const runInvoiceExtractionViaGateway = async ({
  accountId,
  gatewayId,
  workersAiApiToken,
  aiGatewayToken,
  markdown,
}: {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly workersAiApiToken: string;
  readonly aiGatewayToken: string;
  readonly markdown: string;
}) => {
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${INVOICE_EXTRACTION_MODEL}`;
  console.log("[invoice-extraction] starting via gateway REST API", {
    model: INVOICE_EXTRACTION_MODEL,
    url,
    timeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
    markdownLength: markdown.length,
  });
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workersAiApiToken}`,
      "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
      "cf-aig-request-timeout": String(GATEWAY_REQUEST_TIMEOUT_MS),
    },
    body: JSON.stringify(buildRequestBody(markdown)),
  });
  const elapsedMs = Date.now() - startedAt;
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = Schema.decodeUnknownOption(AiGatewayErrorSchema)(body);
    if (parsed._tag === "Some") {
      console.error("[invoice-extraction] gateway error", {
        elapsedMs,
        ...parsed.value,
      });
      throw new Error(
        `AiGatewayError ${String(parsed.value.internalCode)}: ${parsed.value.description} (${parsed.value.requestId})`,
      );
    }
    console.error("[invoice-extraction] gateway error (unstructured)", {
      elapsedMs,
      status: response.status,
      body: JSON.stringify(body),
    });
    throw new Error(
      `AI Gateway ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
  console.log("[invoice-extraction] gateway returned", {
    elapsedMs,
    raw: JSON.stringify(body),
  });
  try {
    const decoded = decodeInvoiceExtractionResponse(body);
    console.log("[invoice-extraction] decoded", decoded);
    return decoded;
  } catch (error) {
    console.error("[invoice-extraction] decode failed", {
      raw: JSON.stringify(body),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const SAMPLE_INVOICE_MARKDOWN = `# cloudflare-invoice-2026-03-04.pdf
## Contents
### Page 1
Page 1 of 6InvoiceInvoice number IN�58976233Date of issue March 4, 2026
Date due March 4, 2026Cloudflare, Inc.101 Townsend Street
San Francisco, California 94107
United States
billing@cloudflare.comBill toDaniel Alin Andrei Calota
Av. Reyes Católicos
37300 Peñaranda de Bracamonte Salamanca
Spain
gitcoinbitcoin@gmail.com$5.39 USD due March 4, 2026Pay onlineVAT�Code: ESS�000DDescription Qty Unit price AmountDurable Objects SQL Storage �First 5 GB-month included)
Feb 4�Mar 3, 2026
0 $0.20 $0.00Durable Objects Storage Rows Written �First 50M included)
Feb 4�Mar 3, 2026
0 $1.00
per
1,000,000
$0.00Durable Objects Storage Rows Read �First 25B included)
Feb 4�Mar 3, 2026
0 $0.001
per
1,000,000
$0.00Browser Rendering - Browser Hours �First 10 hours included)
Feb 4�Mar 3, 2026
0 $0.00
First 10 0 $0.00 $0.00Browser Rendering - Average Concurrent Browsers �First 10 browsers included)
Feb 4�Mar 3, 2026
0 $0.00
First 10 0 $0.00 $0.00Container Egress, Oceania, Taiwan, and Korea, per GB �First 500 GB included)
Feb 4�Mar 3, 2026
0 $0.00
First 500 0 $0.00 $0.00



### Page 2
Page 2 of 6Container Egress, North America + Europe, per GB �First 1 TB included)
Feb 4�Mar 3, 2026
0 $0.00
First 1,000 0 $0.00 $0.00Container Egress, Everywhere Else, per GB �First 500 GB included)
Feb 4�Mar 3, 2026
0 $0.00
First 500 0 $0.00 $0.00Container vCPU �First 375 vCPU-minutes included)
Feb 4�Mar 3, 2026
0 $0.00
First 22,500 0 $0.00 $0.00Container Memory, per GiB�Second �First 25 GiB-hours included) (per GB-seconds)
Feb 4�Mar 3, 2026
0 $0.00
First 90,000 0 $0.00 $0.00Container Disk, per GB second �First 200 GB hours included)
Feb 4�Mar 3, 2026
0 $0.00
First 720,000 0 $0.00 $0.00Worker Build Minutes �6000 minutes included per month)
Feb 4�Mar 3, 2026
0 $0.005 $0.00Observability - Logs �First 20M included)
Feb 4�Mar 3, 2026
0 $0.60 $0.00Vectorize - Stored Dimensions �First 10 million dimension-month included)
Feb 4�Mar 3, 2026
0 $0.05
per
100,000,000
$0.00Vectorize - Queried Dimensions �First 50 million included)
Feb 4�Mar 3, 2026
0 $0.01
per
1,000,000
$0.00R2 Infrequent Access - Data Retrieval
Feb 4�Mar 3, 2026
0 $0.01 $0.00R2 Infrequent Access - Class A Operations
Feb 4�Mar 3, 2026
0 $9.00
per
1,000,000
$0.00



### Page 3
Page 3 of 6R2 Infrequent Access - Storage
Feb 4�Mar 3, 2026
0 $0.01 $0.00R2 Infrequent Access - Class B Operations
Feb 4�Mar 3, 2026
0 $0.90
per
1,000,000
$0.00R2 Storage Class B Operations �First 10M included)
Feb 4�Mar 3, 2026
0 $0.36
per
1,000,000
$0.00R2 Storage Class A Operations �First 1M included)
Feb 4�Mar 3, 2026
0 $4.50
per
1,000,000
$0.00R2 Data Storage �First 10GB�Month included)
Feb 4�Mar 3, 2026
0 $0.015 $0.00D1 - Storage GB-mo (first 5GB included)
Feb 4�Mar 3, 2026
0 $0.75 $0.00D1 - Rows Written (first 50 million included)
Feb 4�Mar 3, 2026
0 $1.00
per
1,000,000
$0.00D1 - Rows Read (first 25 billion included)
Feb 4�Mar 3, 2026
0 $0.001
per
1,000,000
$0.00Fast Twitch Neurons �FTN�Feb 4�Mar 3, 2026
0 $0.125
per 1,000
$0.00Regular Twitch Neurons �RTN�Feb 4�Mar 3, 2026
34,690 $0.011
per 1,000
$0.39Workers CPU ms (first 30M are included)
Feb 4�Mar 3, 2026
0 $0.02
per
1,000,000
$0.00Workers Standard Requests (first 10M are included)
Feb 4�Mar 3, 2026
0 $0.30
per
1,000,000
$0.00



### Page 4
Page 4 of 6Zaraz Loads
Feb 4�Mar 3, 2026
0 $0.50
per 1,000
$0.00Queues - Standard operations �First 1M included)
Feb 4�Mar 3, 2026
0 $0.40
per
1,000,000
$0.00Durable Objects Compute Duration �GB*S, First 400,000 GB*S is included)
Feb 4�Mar 3, 2026
0 $12.50
per
1,000,000
$0.00Durable Objects Compute Requests �First 1M is included)
Feb 4�Mar 3, 2026
0 $0.15
per
1,000,000
$0.00Durable Objects Storage Writes �First 1M is included)
Feb 4�Mar 3, 2026
0 $1.00
per
1,000,000
$0.00Durable Objects Storage Deletes �First 1M is included)
Feb 4�Mar 3, 2026
0 $1.00
per
1,000,000
$0.00Durable Objects Storage �First 1 GB-month included)
Feb 4�Mar 3, 2026
0 $0.20 $0.00Durable Objects Storage Reads �First 1M is included)
Feb 4�Mar 3, 2026
0 $0.20
per
1,000,000
$0.00Logpush Enabled Workers Requests �First 10M included)
Feb 4�Mar 3, 2026
0 $0.05
per
1,000,000
$0.00KV Read Operations �First 10M is included)
Feb 4�Mar 3, 2026
0 $0.50
per
1,000,000
$0.00KV List Operations �First 1M is included)
Feb 4�Mar 3, 2026
0 $5.00
per
1,000,000
$0.00KV Storage �GB, First GB is included)
Feb 4�Mar 3, 2026
0 $0.50 $0.00



### Page 5
Page 5 of 6KV Write Operations �First 1M is included)
Feb 4�Mar 3, 2026
0 $5.00
per
1,000,000
$0.00KV Delete Operations �First 1M is included)
Feb 4�Mar 3, 2026
0 $5.00
per
1,000,000
$0.00Workers Bundled Requests �First 10M is included)
Feb 4�Mar 3, 2026
0 $0.50
per
1,000,000
$0.00Workers Unbound Duration �GB*S, First 400,000 GB*S is included)
Feb 4�Mar 3, 2026
0 $12.50
per
1,000,000
$0.00Workers Unbound Requests �First 1M is included)
Feb 4�Mar 3, 2026
0 $0.15
per
1,000,000
$0.00Vectorize - Enabled
Mar 4�Apr 3, 2026
1 $0.00 $0.00R2 Infrequent Access
Mar 4�Apr 3, 2026
1 $0.00 $0.00R2 Paid
Mar 4�Apr 3, 2026
1 $0.00 $0.00Zaraz - Enabled
Mar 4�Apr 3, 2026
1 $0.00 $0.00Queues - Enabled
Mar 4�Apr 3, 2026
1 $0.00 $0.00Workers Paid
Mar 4�Apr 3, 2026
1 $5.00 $5.00Subtotal $5.39
Total $5.39Amount due $5.39 USDIf this request is concerning an Enterprise invoice reach out to ar@cloudflare.com. For all other billing concerns, submit your
request here: https://dash.cloudflare.com/?to=/:account/support



### Page 6
Page 6 of 6
`;
