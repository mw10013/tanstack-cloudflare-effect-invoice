import { Config, Effect, Layer, Redacted, Schema, ServiceMap } from "effect";
import * as Encoding from "effect/Encoding";
import * as Struct from "effect/Struct";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { trimFields } from "./SchemaEx";
import { Invoice, InvoiceItem } from "./OrganizationDomain";

export const InvoiceItemExtractionSchema = Schema.Struct(
  trimFields(
    Struct.pick(InvoiceItem.fields, [
      "description",
      "quantity",
      "unitPrice",
      "amount",
      "period",
    ]),
  ),
);

export const InvoiceExtractionSchema = Schema.Struct({
  ...trimFields(
    Struct.pick(Invoice.fields, [
      "invoiceConfidence",
      "invoiceNumber",
      "invoiceDate",
      "dueDate",
      "currency",
      "vendorName",
      "vendorEmail",
      "vendorAddress",
      "billToName",
      "billToEmail",
      "billToAddress",
      "subtotal",
      "tax",
      "total",
      "amountDue",
    ]),
  ),
  invoiceItems: Schema.Array(InvoiceItemExtractionSchema),
});

const invoiceExtractionJsonSchema =
  Schema.toJsonSchemaDocument(InvoiceExtractionSchema).schema;

const GeminiResponseSchema = Schema.Struct({
  candidates: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
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
- For invoiceItems, include every line item found. Set quantity, unitPrice, or amount to empty string "" if not clearly stated for that item.
- For addresses, concatenate all address components into a single string (e.g., "101 Townsend Street, San Francisco, California 94107, United States"). Set to empty string "" if no address is found.`;

const makeGatewayUrl = ({
  accountId,
  gatewayId,
}: {
  readonly accountId: string;
  readonly gatewayId: string;
}) =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent`;

/** Optional cause: mixed-origin error — wraps mapError'd failures and direct non-2xx response errors. */
export class InvoiceExtractionError extends Schema.TaggedErrorClass<InvoiceExtractionError>()(
  "InvoiceExtractionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class InvoiceExtraction extends ServiceMap.Service<InvoiceExtraction>()(
  "InvoiceExtraction",
  {
    make: Effect.gen(function* () {
      const config = yield* Config.all({
        accountId: Config.nonEmptyString("CF_ACCOUNT_ID"),
        gatewayId: Config.nonEmptyString("AI_GATEWAY_ID"),
        googleAiStudioApiKey: Config.redacted("GOOGLE_AI_STUDIO_API_KEY"),
        aiGatewayToken: Config.redacted("AI_GATEWAY_TOKEN"),
      });
      const client = yield* HttpClient.HttpClient;

      const extract = Effect.fn("InvoiceExtraction.extract")(function* ({
        fileBytes,
        contentType,
      }: {
        readonly fileBytes: Uint8Array;
        readonly contentType: string;
      }) {
        const response = yield* HttpClientRequest.post(makeGatewayUrl(config), {
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": Redacted.value(config.googleAiStudioApiKey),
            "cf-aig-authorization": `Bearer ${Redacted.value(config.aiGatewayToken)}`,
          },
          body: HttpBody.jsonUnsafe({
            contents: [
              {
                parts: [
                  { text: invoiceExtractionPrompt },
                  {
                    inlineData: {
                      mimeType: contentType,
                      data: Encoding.encodeBase64(fileBytes),
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: invoiceExtractionJsonSchema,
            },
          }),
        }).pipe(
          client.execute,
          Effect.flatMap(decodeInvoiceExtractionResponse),
          Effect.mapError((cause) =>
            cause instanceof InvoiceExtractionError
              ? cause
              : new InvoiceExtractionError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
          Effect.tapError((error) => Effect.logError(error)),
        );

        return response;
      });

      return { extract };
    }).pipe(
      // Redact custom auth headers from Effect HTTP traces/logs.
      Effect.updateService(Headers.CurrentRedactedNames, (names) =>
        [...names, "x-goog-api-key", "cf-aig-authorization"],
      ),
    ),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

const decodeInvoiceExtractionResponse = (
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.status >= 200 && response.status < 300
    ? HttpClientResponse.schemaBodyJson(GeminiResponseSchema)(response).pipe(
        Effect.flatMap(({ candidates }) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(InvoiceExtractionSchema))(
            candidates[0].content.parts[0].text,
          ),
        ),
        Effect.mapError(
          (cause) =>
            new InvoiceExtractionError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ),
      )
    : response.text.pipe(
        Effect.flatMap((body) =>
          Effect.fail(
            new InvoiceExtractionError({
              message: `AI Gateway ${String(response.status)}: ${body}`,
            }),
          ),
        ),
      );
