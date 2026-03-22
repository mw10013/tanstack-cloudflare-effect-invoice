import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrganizationDomain from "./OrganizationDomain";

const decodeInvoice = Schema.decodeUnknownEffect(OrganizationDomain.Invoice);
const decodeInvoices = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.Invoice)),
);
const decodeInvoiceItems = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.InvoiceItem)),
);

export class OrganizationRepository extends ServiceMap.Service<OrganizationRepository>()(
  "OrganizationRepository",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
        function* (invoiceId: string) {
          const rows = yield* sql`select * from Invoice where id = ${invoiceId}`;
          return rows.length > 0
            ? yield* Effect.asSome(decodeInvoice(rows[0]))
            : Option.none<OrganizationDomain.Invoice>();
        },
      );

      const getInvoices = Effect.fn("OrganizationRepository.getInvoices")(
        function* () {
          const rows = yield* sql`select * from Invoice order by createdAt desc`;
          return yield* decodeInvoices(rows);
        },
      );

      const getInvoiceItems = Effect.fn("OrganizationRepository.getInvoiceItems")(
        function* (invoiceId: string) {
          const rows = yield* sql`select * from InvoiceItem where invoiceId = ${invoiceId} order by "order" asc`;
          return yield* decodeInvoiceItems(rows);
        },
      );

      const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
        function* (input: {
          invoiceId: string;
          fileName: string;
          contentType: string;
          r2ActionTime: number;
          idempotencyKey: string;
          r2ObjectKey: string;
        }) {
          yield* sql`
            insert into Invoice (
              id, fileName, contentType, createdAt, r2ActionTime,
              idempotencyKey, r2ObjectKey, status,
              extractedJson, error
            ) values (
              ${input.invoiceId}, ${input.fileName}, ${input.contentType},
              ${input.r2ActionTime}, ${input.r2ActionTime}, ${input.idempotencyKey},
              ${input.r2ObjectKey}, 'uploaded',
              ${null}, ${null}
            )
            on conflict(id) do update set
              fileName = excluded.fileName,
              contentType = excluded.contentType,
              r2ActionTime = excluded.r2ActionTime,
              idempotencyKey = excluded.idempotencyKey,
              r2ObjectKey = excluded.r2ObjectKey,
              status = 'uploaded',
              invoiceConfidence = 0,
              invoiceNumber = '',
              invoiceDate = '',
              dueDate = '',
              currency = '',
              vendorName = '',
              vendorEmail = '',
              vendorAddress = '',
              billToName = '',
              billToEmail = '',
              billToAddress = '',
              subtotal = '',
              tax = '',
              total = '',
              amountDue = '',
              extractedJson = null,
              error = null
          `;
        },
      );

      const setExtracting = Effect.fn("OrganizationRepository.setExtracting")(
        function* (invoiceId: string, idempotencyKey: string) {
          yield* sql`
            update Invoice
            set status = 'extracting'
            where id = ${invoiceId} and idempotencyKey = ${idempotencyKey}
          `;
        },
      );

      const deleteInvoice = Effect.fn("OrganizationRepository.deleteInvoice")(
        function* (invoiceId: string, r2ActionTime: number) {
          return yield* sql`
            delete from Invoice
            where id = ${invoiceId} and r2ActionTime <= ${r2ActionTime}
            returning id
          `;
        },
      );

      const saveExtraction = Effect.fn(
        "OrganizationRepository.saveExtraction",
      )(
        function* (input: {
          invoiceId: string;
          idempotencyKey: string;
          extracted: typeof OrganizationDomain.InvoiceExtractionFields.Type;
          invoiceItems: readonly (typeof OrganizationDomain.InvoiceItemFields.Type)[];
          extractedJson: string;
        }) {
          const updated = yield* sql`
            update Invoice
            set status = 'extracted',
                invoiceConfidence = ${input.extracted.invoiceConfidence},
                invoiceNumber = ${input.extracted.invoiceNumber},
                invoiceDate = ${input.extracted.invoiceDate},
                dueDate = ${input.extracted.dueDate},
                currency = ${input.extracted.currency},
                vendorName = ${input.extracted.vendorName},
                vendorEmail = ${input.extracted.vendorEmail},
                vendorAddress = ${input.extracted.vendorAddress},
                billToName = ${input.extracted.billToName},
                billToEmail = ${input.extracted.billToEmail},
                billToAddress = ${input.extracted.billToAddress},
                subtotal = ${input.extracted.subtotal},
                tax = ${input.extracted.tax},
                total = ${input.extracted.total},
                amountDue = ${input.extracted.amountDue},
                extractedJson = ${input.extractedJson},
                error = ${null}
            where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
            returning id, fileName
          `;
          if (updated.length === 0) return updated;
          yield* sql`delete from InvoiceItem where invoiceId = ${input.invoiceId}`;
          for (let i = 0; i < input.invoiceItems.length; i++) {
            const item = input.invoiceItems[i];
            const id = crypto.randomUUID();
            const order = i + 1;
            yield* sql`
              insert into InvoiceItem (id, invoiceId, "order", description, quantity, unitPrice, amount, period)
              values (${id}, ${input.invoiceId}, ${order}, ${item.description}, ${item.quantity}, ${item.unitPrice}, ${item.amount}, ${item.period})
            `;
          }
          return updated;
        },
      );

      const setError = Effect.fn("OrganizationRepository.setError")(
        function* (workflowId: string, error: string) {
          return yield* sql`
            update Invoice
            set status = 'error',
                error = ${error}
            where idempotencyKey = ${workflowId}
            returning id, fileName
          `;
        },
      );

      return {
        findInvoice,
        getInvoices,
        getInvoiceItems,
        upsertInvoice,
        setExtracting,
        deleteInvoice,
        saveExtraction,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
