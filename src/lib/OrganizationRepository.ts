import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { InvoiceExtractionSchema } from "./InvoiceExtraction";
import * as OrganizationDomain from "./OrganizationDomain";
import { JsonDataFieldHead } from "./SchemaEx";

const decodeInvoice = Schema.decodeUnknownEffect(OrganizationDomain.Invoice);
const decodeInvoices = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(OrganizationDomain.Invoice)),
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
            'invoiceItems', coalesce(
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
        return yield* Schema.decodeUnknownEffect(JsonDataFieldHead(OrganizationDomain.InvoiceWithItems))(rows);
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

      const saveInvoiceExtraction = Effect.fn(
        "OrganizationRepository.saveInvoiceExtraction",
      )(
        function* (input: {
          invoiceId: string;
          idempotencyKey: string;
          extractedInvoice: typeof InvoiceExtractionSchema.Type;
          extractedJson: string;
        }) {
          const { invoiceItems, ...extracted } = input.extractedInvoice;
          const updated = yield* sql`
            update Invoice
            set status = 'ready',
                invoiceConfidence = ${extracted.invoiceConfidence},
                invoiceNumber = ${extracted.invoiceNumber},
                invoiceDate = ${extracted.invoiceDate},
                dueDate = ${extracted.dueDate},
                currency = ${extracted.currency},
                vendorName = ${extracted.vendorName},
                vendorEmail = ${extracted.vendorEmail},
                vendorAddress = ${extracted.vendorAddress},
                billToName = ${extracted.billToName},
                billToEmail = ${extracted.billToEmail},
                billToAddress = ${extracted.billToAddress},
                subtotal = ${extracted.subtotal},
                tax = ${extracted.tax},
                total = ${extracted.total},
                amountDue = ${extracted.amountDue},
                extractedJson = ${input.extractedJson},
                error = ${null}
            where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
            returning id, fileName
          `;
          if (updated.length === 0) return updated;
          yield* sql`delete from InvoiceItem where invoiceId = ${input.invoiceId}`;
          for (let i = 0; i < invoiceItems.length; i++) {
            const item = invoiceItems[i];
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

      const updateInvoice = Effect.fn("OrganizationRepository.updateInvoice")(
        function* (input: { invoiceId: string } & typeof OrganizationDomain.InvoiceFormSchema.Type) {
          return yield* Effect.gen(function* () {
            const updated = yield* sql`
              update Invoice
              set name = ${input.name},
                  status = 'ready',
                  invoiceNumber = ${input.invoiceNumber},
                  invoiceDate = ${input.invoiceDate},
                  dueDate = ${input.dueDate},
                  currency = ${input.currency},
                  vendorName = ${input.vendorName},
                  vendorEmail = ${input.vendorEmail},
                  vendorAddress = ${input.vendorAddress},
                  billToName = ${input.billToName},
                  billToEmail = ${input.billToEmail},
                  billToAddress = ${input.billToAddress},
                  subtotal = ${input.subtotal},
                  tax = ${input.tax},
                  total = ${input.total},
                  amountDue = ${input.amountDue},
                  error = ${null}
              where id = ${input.invoiceId} and status in ('ready', 'error')
              returning id
            `;
            if (updated.length === 0) return yield* Effect.fail(new Error("Invoice cannot be edited"));
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
            return yield* getInvoiceWithItems(input.invoiceId);
          });
        },
      );

      return {
        findInvoice,
        getInvoices,
        getInvoiceWithItems,
        upsertInvoice,
        createInvoice,
        updateInvoice,
        softDeleteInvoice,
        saveInvoiceExtraction,
        setError,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
