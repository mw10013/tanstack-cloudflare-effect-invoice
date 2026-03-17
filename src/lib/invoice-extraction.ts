import * as Schema from "effect/Schema";

const LineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.NullOr(Schema.String),
  unitPrice: Schema.NullOr(Schema.String),
  amount: Schema.NullOr(Schema.String),
  period: Schema.NullOr(Schema.String),
});

export const InvoiceExtractionSchema = Schema.Struct({
  isInvoice: Schema.Boolean,
  invoiceNumber: Schema.NullOr(Schema.String),
  invoiceDate: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  vendorName: Schema.NullOr(Schema.String),
  vendorEmail: Schema.NullOr(Schema.String),
  vendorAddress: Schema.NullOr(Schema.String),
  billToName: Schema.NullOr(Schema.String),
  billToEmail: Schema.NullOr(Schema.String),
  billToAddress: Schema.NullOr(Schema.String),
  lineItems: Schema.NullOr(Schema.Array(LineItemSchema)),
  subtotal: Schema.NullOr(Schema.String),
  tax: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.String),
  amountDue: Schema.NullOr(Schema.String),
});

export const decodeInvoiceExtraction = Schema.decodeUnknownSync(
  InvoiceExtractionSchema,
);

export const InvoiceExtractionJsonSchema = Schema.toJsonSchemaDocument(
  InvoiceExtractionSchema,
).schema;

export const INVOICE_EXTRACTION_MODEL: keyof AiModels =
  "@cf/meta/llama-4-scout-17b-16e-instruct";

const decodeAiResponse = Schema.decodeUnknownSync(
  Schema.Struct({ response: InvoiceExtractionSchema }),
);

export const runInvoiceExtraction = async ({
  ai,
  gatewayId,
  markdown,
}: {
  readonly ai: Ai;
  readonly gatewayId: string;
  readonly markdown: string;
}) => {
  console.log("[invoice-extraction] starting", {
    model: INVOICE_EXTRACTION_MODEL,
    gatewayId,
    markdownLength: markdown.length,
  });
  let raw: unknown;
  try {
    raw = await ai.run(
      INVOICE_EXTRACTION_MODEL,
      {
        prompt: `You are an invoice data extraction assistant. You will receive markdown converted from a PDF document.

Analyze the document and extract structured invoice data according to the provided JSON schema.

Rules:
- Set isInvoice to true only if the document is clearly an invoice.
- If isInvoice is false, set all other fields to null.
- Extract only information explicitly present in the document. Never infer or guess values.
- Set fields to null when the information is not found in the document.
- Keep amounts as strings exactly as they appear in the document, including currency symbols (e.g., "$5.39", "$0.011 per 1,000").
- Keep dates as strings in whatever format appears in the document.
- For line items, include every line item found. Set quantity, unitPrice, or amount to null if not clearly stated for that item.
- For addresses, concatenate all address components into a single string (e.g., "101 Townsend Street, San Francisco, California 94107, United States"). Set to null if no address is found.

Document:

${markdown}`,
        response_format: {
          type: "json_schema" as const,
          json_schema: InvoiceExtractionJsonSchema,
        },
        max_tokens: 4096,
        temperature: 0,
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
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
  console.log("[invoice-extraction] ai.run returned", JSON.stringify(raw));
  try {
    const decoded = decodeAiResponse(raw);
    console.log("[invoice-extraction] decoded", decoded);
    return decoded.response;
  } catch (error) {
    console.error("[invoice-extraction] decode failed", {
      raw: JSON.stringify(raw),
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
