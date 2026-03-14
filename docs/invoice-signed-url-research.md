# Invoice Signed URL Clickthrough Research

## Goal

Open an invoice row in a new tab from `src/routes/app.$organizationId.invoices.tsx`, using signed R2 URLs (no public bucket).

## Current invoice data and UI (this repo)

`r2ObjectKey` is already stored on invoice rows in the agent, so the key exists for signing.

```ts
// src/organization-agent.ts
const InvoiceRow = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  eventTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: Schema.String,
  processedAt: Schema.NullOr(Schema.Number),
});
```

The invoices route currently renders file names without a link and only supports delete.

```tsx
// src/routes/app.$organizationId.invoices.tsx
{invoices.map((invoice) => (
  <TableRow key={invoice.id}>
    <TableCell className="flex items-center gap-2 font-medium">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{invoice.fileName}</span>
    </TableCell>
    ...
    <TableCell>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          deleteMutation.mutate({
            invoiceId: invoice.id,
            r2ObjectKey: invoice.r2ObjectKey,
          });
        }}
        disabled={deleteMutation.isPending}
      >
        <Trash2 className="size-4" />
      </Button>
    </TableCell>
  </TableRow>
))}
```

## refs/tca: signed URL pattern (images)

`refs/tca` uses `aws4fetch` to presign GET URLs in production, and a local proxy route in local dev.

```ts
// refs/tca/src/routes/app.$organizationId.upload.tsx
if (environment === "local") {
  return uploads.map((upload) => ({
    ...upload,
    thumbnailUrl: `/api/org/${organizationId}/upload-image/${encodeURIComponent(upload.name)}`,
  }));
}
return yield* Effect.tryPromise(async () => {
  const { AwsClient } = await import("aws4fetch");
  const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: Redacted.value(r2S3AccessKeyId),
    secretAccessKey: Redacted.value(r2S3SecretAccessKey),
  });
  return Promise.all(
    uploads.map(async (upload) => {
      const signed = await client.sign(
        new Request(
          `https://${cfAccountId}.r2.cloudflarestorage.com/${r2BucketName}/${organizationId}/${upload.name}?X-Amz-Expires=900`,
          { method: "GET" },
        ),
        { aws: { signQuery: true } },
      );
      return { ...upload, thumbnailUrl: signed.url };
    }),
  );
});
```

Local proxy route (only enabled for `ENVIRONMENT === "local"`):

```ts
// refs/tca/src/routes/api/org.$organizationId.upload-image.$name.tsx
if (environment !== "local") {
  return new Response("Not Found", { status: 404 });
}
...
const key = `${organizationId}/${name}`;
const object = yield* Effect.tryPromise(() => R2.get(key));
if (!object?.body) {
  return new Response("Not Found", { status: 404 });
}
return new Response(object.body, {
  headers: {
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "private, max-age=60",
    ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
  },
});
```

## refs/tca docs: presigned URL guidance

`aws4fetch` is the recommended Workers-friendly signer, and presigned GET URLs are meant for direct browser usage.

```ts
// refs/tca/docs/archive/cloudflare-r2.md
import { AwsClient } from "aws4fetch";

const client = new AwsClient({
  service: "s3",
  region: "auto",
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
});

const R2_URL = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

const getUrl = (
  await client.sign(
    new Request(`${R2_URL}/my-bucket/photos/cat.png?X-Amz-Expires=3600`),
    { aws: { signQuery: true } },
  )
).url.toString();
```

Additional guidance from the same doc:

```
Presigned GET URLs work directly as `src` attributes:
<img src="https://my-bucket.ACCOUNT_ID.r2.cloudflarestorage.com/photos/cat.png?X-Amz-Algorithm=..." />

- Configure CORS for browser-based presigned URL usage.
- Short expiry: Treat presigned URLs as bearer tokens.
- Presigned URLs only work with <ACCOUNT_ID>.r2.cloudflarestorage.com.
```

## Proposal for invoices (no code changes yet)

### Option A: loader adds `viewUrl` per invoice (closest to refs/tca)

1. Extend the invoices loader (`getInvoices`) to map each invoice row to include a `viewUrl`.
2. Use local proxy URL for `ENVIRONMENT === "local"` and presigned URL for production.
3. Render file name as `<a href={viewUrl} target="_blank" rel="noreferrer">`.

Key values from refs/tca that carry over:

- `AwsClient` config: `service: "s3"`, `region: "auto"`.
- URL base: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`.
- Use `client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } })`.
- `X-Amz-Expires` set to a short value (e.g. 900 seconds in refs/tca).

Invoice-specific detail:

- Use `invoice.r2ObjectKey` directly in the URL path (already stored in DB via `OrganizationAgent`).

Tradeoffs:

- Signed URLs are time-limited; a user leaving the list open might get expired links without a refresh.

### Option B: on-demand sign + open in new tab

1. Add a server fn to sign a single invoice key on click.
2. On click, call the server fn, then `window.open(signedUrl, "_blank")`.

Tradeoffs:

- Always fresh URL, but one extra request per click.

### Local proxy route (if we keep parity with refs/tca)

Follow the `refs/tca` route pattern to stream from R2 in local dev only; the URL shape could mirror invoices, e.g. `/api/org/$organizationId/invoice/$invoiceId` or `/api/org/$organizationId/invoice/$r2ObjectKey`.

## Notes to validate when implementing

- Ensure `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`, `R2_BUCKET_NAME` are available in env and config in this repo; refs/tca depends on these for signing.
- For top-level navigation (`target="_blank"`), CORS is less critical than for XHR, but keep the R2 CORS config aligned with presigned URL usage if images are also embedded.
