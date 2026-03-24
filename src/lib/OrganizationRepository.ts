import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrganizationDomain from "./OrganizationDomain";
import { DataFromResult } from "./SchemaEx";

const decodeInvoice = Schema.decodeUnknownEffect(OrganizationDomain.Invoice);
const decodeInvoices = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.Invoice)),
);
const decodeInvoiceWithItems = Schema.decodeUnknownEffect(
  DataFromResult(OrganizationDomain.InvoiceWithItems),
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

      const getInvoiceWithItems = Effect.fn(
        "OrganizationRepository.getInvoiceWithItems",
      )(function* (invoiceId: string) {
        const rows = yield* sql`
          select json_object(
            'id', i.id,
            'name', i.name,
            'fileName', i.fileName,
            'contentType', i.contentType,
            'createdAt', i.createdAt,
            'r2ActionTime', i.r2ActionTime,
            'idempotencyKey', i.idempotencyKey,
            'r2ObjectKey', i.r2ObjectKey,
            'status', i.status,
            'invoiceConfidence', i.invoiceConfidence,
            'invoiceNumber', i.invoiceNumber,
            'invoiceDate', i.invoiceDate,
            'dueDate', i.dueDate,
            'currency', i.currency,
            'vendorName', i.vendorName,
            'vendorEmail', i.vendorEmail,
            'vendorAddress', i.vendorAddress,
            'billToName', i.billToName,
            'billToEmail', i.billToEmail,
            'billToAddress', i.billToAddress,
            'subtotal', i.subtotal,
            'tax', i.tax,
            'total', i.total,
            'amountDue', i.amountDue,
            'extractedJson', i.extractedJson,
            'error', i.error,
            'items', coalesce(
              (
                select json_group_array(
                  json_object(
                    'id', ii.id,
                    'invoiceId', ii.invoiceId,
                    'order', ii."order",
                    'description', ii.description,
                    'quantity', ii.quantity,
                    'unitPrice', ii.unitPrice,
                    'amount', ii.amount,
                    'period', ii.period
                  )
                )
                from (
                  select *
                  from InvoiceItem
                  where invoiceId = i.id
                  order by "order" asc
                ) as ii
              ),
              json('[]')
            )
          ) as data
          from Invoice i
          where i.id = ${invoiceId}
        `;
        return yield* Effect.fromNullishOr(rows[0]).pipe(
          Effect.flatMap(decodeInvoiceWithItems),
        );
      });

      const upsertInvoice = Effect.fn("OrganizationRepository.upsertInvoice")(
        function* (input: {
          invoiceId: string;
          name: string;
          fileName: string;
          contentType: string;
          r2ActionTime: number;
          idempotencyKey: string;
          r2ObjectKey: string;
          status: OrganizationDomain.InvoiceStatus;
        }) {
          yield* sql`
            insert into Invoice (
              id, name, fileName, contentType, r2ActionTime,
              idempotencyKey, r2ObjectKey, status,
              extractedJson, error
            ) values (
              ${input.invoiceId}, ${input.name}, ${input.fileName}, ${input.contentType},
              ${input.r2ActionTime}, ${input.idempotencyKey},
              ${input.r2ObjectKey}, ${input.status},
              ${null}, ${null}
            )
            on conflict(id) do update set
              name = excluded.name,
              fileName = excluded.fileName,
              contentType = excluded.contentType,
              r2ActionTime = excluded.r2ActionTime,
              idempotencyKey = excluded.idempotencyKey,
              r2ObjectKey = excluded.r2ObjectKey,
              status = excluded.status,
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

      const softDeleteInvoice = Effect.fn("OrganizationRepository.softDeleteInvoice")(
        function* (invoiceId: string) {
          return yield* sql`
            update Invoice
            set status = 'deleted'
            where id = ${invoiceId} and status in ('ready', 'error')
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
            set status = 'ready',
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

      const createInvoice = Effect.fn("OrganizationRepository.createInvoice")(
        function* (invoiceId: string) {
          yield* sql`
            insert into Invoice (id, name, status)
            values (${invoiceId}, ${"Untitled Invoice"}, ${"ready"})
          `;
        },
      );

      return {
        findInvoice,
        getInvoices,
        getInvoiceWithItems,
        upsertInvoice,
        createInvoice,
        softDeleteInvoice,
        saveExtraction,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
