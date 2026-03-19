import * as Schema from "effect/Schema";

const LineItemSchema = Schema.Struct({
  description: Schema.String,
  quantity: Schema.String,
  unitPrice: Schema.String,
  amount: Schema.String,
  period: Schema.String,
});

export const InvoiceExtractionSchema = Schema.Struct({
  invoiceConfidence: Schema.Number,
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

const GEMINI_REQUEST_TIMEOUT_MS = 300_000;

export const INVOICE_EXTRACTION_MODEL = "gemini-2.5-flash";

const invoiceExtractionPrompt = `You are an invoice data extraction assistant. You will receive a document (PDF or image).

Analyze the document and extract structured invoice data according to the provided JSON schema.

Rules:
- Set invoiceConfidence to a number from 0 to 1 indicating how likely the document is an invoice.
- Always try to populate every field from visible document content regardless of invoiceConfidence.
- Extract only information explicitly present in the document. Never infer or guess values.
- Set fields to empty string "" when the information is not found in the document.
- Keep amounts as strings exactly as they appear in the document, including currency symbols (e.g., "$5.39", "$0.011 per 1,000").
- Keep dates as strings in whatever format appears in the document.
- For line items, include every line item found. Set quantity, unitPrice, or amount to empty string "" if not clearly stated for that item.
- For addresses, concatenate all address components into a single string (e.g., "101 Townsend Street, San Francisco, California 94107, United States"). Set to empty string "" if no address is found.`;

const GeminiResponseSchema = Schema.Struct({
  candidates: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
});

const decodeGeminiResponse = Schema.decodeUnknownSync(GeminiResponseSchema);

export const runInvoiceExtraction = async ({
  accountId,
  gatewayId,
  googleAiStudioApiKey,
  aiGatewayToken,
  fileBytes,
  contentType,
}: {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly googleAiStudioApiKey: string;
  readonly aiGatewayToken: string;
  readonly fileBytes: Uint8Array;
  readonly contentType: string;
}) => {
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent`;
  console.log("[invoice-extraction] starting gemini via gateway", {
    url,
    timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
    contentType,
    isPng: contentType === "image/png",
    fileBytesLength: fileBytes.length,
  });
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": googleAiStudioApiKey,
      "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
      "cf-aig-request-timeout": String(GEMINI_REQUEST_TIMEOUT_MS),
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: invoiceExtractionPrompt },
            {
              inlineData: {
                mimeType: contentType,
                data: Buffer.from(fileBytes).toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: InvoiceExtractionJsonSchema,
      },
    }),
  });
  const elapsedMs = Date.now() - startedAt;
  const body: unknown = await response.json();
  if (!response.ok) {
    console.error("[invoice-extraction] gemini gateway error", {
      elapsedMs,
      status: response.status,
      body: JSON.stringify(body),
    });
    throw new Error(
      `Gemini Gateway ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
  console.log("[invoice-extraction] gemini gateway returned", {
    elapsedMs,
    raw: JSON.stringify(body),
  });
  try {
    const decoded = decodeInvoiceExtractionFromJsonString(
      decodeGeminiResponse(body).candidates[0].content.parts[0].text,
    );
    console.log("[invoice-extraction] gemini decoded", decoded);
    return decoded;
  } catch (error) {
    console.error("[invoice-extraction] gemini decode failed", {
      raw: JSON.stringify(body),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
