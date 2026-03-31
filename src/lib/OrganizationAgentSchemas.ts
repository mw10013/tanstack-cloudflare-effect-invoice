import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Invoice, InvoiceItem } from "./OrganizationDomain";
import { trimFields } from "./SchemaEx";

export const UpdateInvoiceInput = Schema.Struct({
  invoiceId: Invoice.fields.id,
  ...trimFields(
    Struct.pick(Invoice.fields, [
      "name",
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
  invoiceItems: Schema.Array(Schema.Struct(
    trimFields(
      Struct.pick(InvoiceItem.fields, [
        "description",
        "quantity",
        "unitPrice",
        "amount",
        "period",
      ]),
    ),
  )),
});

export const UploadInvoiceInput = Schema.Struct({
  fileName: Invoice.fields.fileName.check(Schema.isNonEmpty()),
  contentType: Invoice.fields.contentType.check(Schema.isNonEmpty()),
  base64: Schema.NonEmptyString,
});

export const GetInvoiceInput = Schema.Struct({
  invoiceId: Invoice.fields.id,
});

export const SoftDeleteInvoiceInput = Schema.Struct({
  invoiceId: Invoice.fields.id,
});
