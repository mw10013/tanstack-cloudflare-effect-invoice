import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import type { OrganizationAgent } from "./organization-agent";

import { AgentWorkflow } from "agents/workflows";
import * as Schema from "effect/Schema";

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
  lineItems: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      quantity: Schema.String,
      unitPrice: Schema.String,
      amount: Schema.String,
      period: Schema.String,
    }),
  ),
  subtotal: Schema.String,
  tax: Schema.String,
  total: Schema.String,
  amountDue: Schema.String,
});

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

interface InvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
  readonly contentType: string;
}

export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  { readonly status: string; readonly message: string }
> {
  async run(
    event: AgentWorkflowEvent<InvoiceExtractionWorkflowParams>,
    step: AgentWorkflowStep,
  ) {
    console.log("[workflow] INVOICE_EXTRACTION_WORKFLOW started", {
      invoiceId: event.payload.invoiceId,
      r2ObjectKey: event.payload.r2ObjectKey,
      fileName: event.payload.fileName,
      contentType: event.payload.contentType,
    });
    const fileBytes = await step.do("load-file", async () => {
      console.log(
        "[workflow:load-file] fetching from R2",
        event.payload.r2ObjectKey,
      );
      const object = await this.env.R2.get(event.payload.r2ObjectKey);
      if (!object) {
        throw new Error(`Invoice file not found: ${event.payload.r2ObjectKey}`);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      console.log("[workflow:load-file] loaded", { bytes: bytes.byteLength });
      return bytes;
    });
    const extractedJson = await step.do("extract-invoice", async () => {
      const result = await runInvoiceExtraction({
        accountId: this.env.CF_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY,
        aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
        fileBytes,
        contentType: event.payload.contentType,
      });
      return result;
    });
    await step.do("save-extracted-json", async () => {
      await this.agent.saveExtractedJson({
        invoiceId: event.payload.invoiceId,
        idempotencyKey: event.payload.idempotencyKey,
        extractedJson: JSON.stringify(extractedJson),
      });
    });
    console.log("[workflow] INVOICE_EXTRACTION_WORKFLOW complete", {
      invoiceId: event.payload.invoiceId,
    });
    return { invoiceId: event.payload.invoiceId };
  }
}

const decodeGeminiResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    candidates: Schema.NonEmptyArray(
      Schema.Struct({
        content: Schema.Struct({
          parts: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
        }),
      }),
    ),
  }),
);

const runInvoiceExtraction = async ({
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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": googleAiStudioApiKey,
      "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
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
        responseJsonSchema:
          Schema.toJsonSchemaDocument(InvoiceExtractionSchema).schema,
      },
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    console.error("[invoice-extraction] ai gateway error", {
      status: response.status,
      body: JSON.stringify(body),
    });
    throw new Error(
      `AI Gateway Response ${String(response.status)}: ${JSON.stringify(body)}`,
    );
  }
    const decoded = Schema.decodeUnknownSync(
      Schema.fromJsonString(InvoiceExtractionSchema),
    )(decodeGeminiResponse(body).candidates[0].content.parts[0].text);
    console.log("[invoice-extraction] decoded", decoded);
    return decoded;
};


