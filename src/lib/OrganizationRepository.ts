import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type * as Domain from "./Domain";
import type { InvoiceExtractionSchema } from "./InvoiceExtraction";
import type { UpdateInvoiceInput } from "./OrganizationAgentSchemas";
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

      const countInvoices = Effect.fn("OrganizationRepository.countInvoices")(
        function* () {
          const rows = yield* sql`select count(*) as count from Invoice`;
          return (rows[0] as { count: number }).count;
        },
      );

      const findInvoice = Effect.fn("OrganizationRepository.findInvoice")(
        function* (invoiceId: OrganizationDomain.Invoice["id"]) {
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

      const getInvoice = Effect.fn(
        "OrganizationRepository.getInvoice",
      )(function* (invoiceId: OrganizationDomain.Invoice["id"]) {
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
        function* (input: Pick<OrganizationDomain.Invoice, "name" | "fileName" | "contentType" | "r2ObjectKey" | "status"> & {
          invoiceId: OrganizationDomain.Invoice["id"];
          r2ActionTime: NonNullable<OrganizationDomain.Invoice["r2ActionTime"]>;
          idempotencyKey: NonNullable<OrganizationDomain.Invoice["idempotencyKey"]>;
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

      const insertUploadingInvoice = Effect.fn("OrganizationRepository.insertUploadingInvoice")(
        function* (input: Pick<OrganizationDomain.Invoice, "name" | "fileName" | "contentType" | "r2ObjectKey"> & {
          invoiceId: OrganizationDomain.Invoice["id"];
          idempotencyKey: NonNullable<OrganizationDomain.Invoice["idempotencyKey"]>;
        }) {
          yield* sql`
            insert into Invoice (id, name, fileName, contentType, idempotencyKey, r2ObjectKey, status)
            values (
              ${input.invoiceId}, ${input.name}, ${input.fileName}, ${input.contentType},
              ${input.idempotencyKey}, ${input.r2ObjectKey}, ${"uploading"}
            )
            on conflict(id) do nothing
          `;
        },
      );

      const deleteInvoice = Effect.fn("OrganizationRepository.deleteInvoice")(
        function* (invoiceId: OrganizationDomain.Invoice["id"]) {
          return yield* sql`
            delete from Invoice
            where id = ${invoiceId}
            returning id
          `;
        },
      );

      const saveInvoiceExtraction = Effect.fn(
        "OrganizationRepository.saveInvoiceExtraction",
      )(
        function* (input: {
          invoiceId: OrganizationDomain.Invoice["id"];
          idempotencyKey: NonNullable<OrganizationDomain.Invoice["idempotencyKey"]>;
          extractedInvoice: typeof InvoiceExtractionSchema.Type;
          extractedJson: NonNullable<OrganizationDomain.Invoice["extractedJson"]>;
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
            const id = yield* Schema.decodeUnknownEffect(
              OrganizationDomain.InvoiceItem.fields.id,
            )(crypto.randomUUID());
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
        function* (workflowId: string, error: NonNullable<OrganizationDomain.Invoice["error"]>) {
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
        function* (invoiceId: OrganizationDomain.Invoice["id"]) {
          yield* sql`
            insert into Invoice (id, name, status)
            values (${invoiceId}, ${"Untitled Invoice"}, ${"ready"})
          `;
        },
      );

      const updateInvoice = Effect.fn("OrganizationRepository.updateInvoice")(
        function* (input: typeof UpdateInvoiceInput.Type) {
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
              const id = yield* Schema.decodeUnknownEffect(
                OrganizationDomain.InvoiceItem.fields.id,
              )(crypto.randomUUID());
              const order = i + 1;
              yield* sql`
                insert into InvoiceItem (id, invoiceId, "order", description, quantity, unitPrice, amount, period)
                values (${id}, ${input.invoiceId}, ${order}, ${item.description}, ${item.quantity}, ${item.unitPrice}, ${item.amount}, ${item.period})
              `;
            }
            return yield* getInvoice(input.invoiceId);
          });
        },
      );

      const upsertMember = Effect.fn("OrganizationRepository.upsertMember")(
        function* (input: { userId: Domain.User["id"]; role: Domain.MemberRole }) {
          yield* sql`
            insert into Member (userId, role) values (${input.userId}, ${input.role})
            on conflict(userId) do update set role = excluded.role
          `;
        },
      );

      const deleteMember = Effect.fn("OrganizationRepository.deleteMember")(
        function* (userId: Domain.User["id"]) {
          yield* sql`delete from Member where userId = ${userId}`;
        },
      );

      const isMember = Effect.fn("OrganizationRepository.isMember")(
        function* (userId: Domain.User["id"]) {
          const rows = yield* sql`select 1 from Member where userId = ${userId}`;
          return rows.length > 0;
        },
      );

      return {
        countInvoices,
        findInvoice,
        getInvoices,
        getInvoice,
        upsertInvoice,
        insertUploadingInvoice,
        createInvoice,
        updateInvoice,
        deleteInvoice,
        saveInvoiceExtraction,
        setError,
        upsertMember,
        deleteMember,
        isMember,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
