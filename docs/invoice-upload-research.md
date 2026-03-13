# Invoice Upload Feature Research

## Overview

Upload invoices (PDF + standard web image types) to R2, trigger queue notification on R2 put, queue handler calls OrganizationAgent to insert into `Invoice` table and broadcast. Later iterations kick off a workflow to process the invoice.

**Sample invoices:** `invoices/cloudflare-invoice-2026-03-04.pdf`, `invoices/invoice_EU-ES608274.pdf`

---

## Architecture Flow

```
User picks file via form (no name required)
  → Server fn receives FormData (file only)
  → Generates invoiceId (crypto.randomUUID)
  → R2 key: {organizationId}/invoices/{invoiceId}
  → R2.put via R2 Effect service with customMetadata { organizationId, invoiceId, idempotencyKey, fileName, contentType }
  → R2 event notification (production) / manual queue send (local)
  → Queue consumer decodes message, extracts metadata from R2 head
  → Gets OrganizationAgent stub by organizationId
  → Calls agent.onInvoiceUpload(...)
  → Agent inserts row into Invoice table (PK: id)
  → Agent broadcasts to connected clients
  → (Future) Agent kicks off invoice processing workflow
```

---

## 1. Route: `app.$organizationId.invoices.tsx`

New file route at `/app/$organizationId/invoices`.

### Sidebar

Add sidebar link in `src/routes/app.$organizationId.tsx` between Agent and Invitations:

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    isActive={Boolean(matchRoute({ to: "/app/$organizationId/invoices" }))}
    render={
      <Link to="/app/$organizationId/invoices" params={{ organizationId: organization.id }}>
        Invoices
      </Link>
    }
  />
</SidebarMenuItem>
```

### Loader

Server fn `getInvoices` calls OrganizationAgent `getInvoices()` via RPC.

Pattern from refs/tca `app.$organizationId.upload.tsx`:
```ts
const getInvoices = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ context: { runEffect }, data: { organizationId } }) =>
    runEffect(
      Effect.gen(function* () {
        const { ORGANIZATION_AGENT } = yield* CloudflareEnv;
        const id = ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = ORGANIZATION_AGENT.get(id);
        return yield* Effect.tryPromise(() => stub.getInvoices());
      }),
    ),
  );
```

### Upload Server Fn

Uses the `R2` Effect service (not raw R2 binding). The R2 service is already available via `makeHttpRunEffect` layer stack (`kvLayer` provides env → `CloudflareEnv` → `R2`). However, the upload server fn also needs `R2_UPLOAD_QUEUE` from `CloudflareEnv` for local queue simulation.

**No name field** — server generates `invoiceId` via `crypto.randomUUID()`.

```ts
const uploadInvoice = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return Schema.decodeUnknownSync(uploadFormSchema)(Object.fromEntries(data));
  })
  .handler(({ context: { runEffect }, data }) =>
    runEffect(
      Effect.gen(function* () {
        // auth: get organizationId from session/context
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        const { R2_UPLOAD_QUEUE } = yield* CloudflareEnv;
        const r2 = yield* R2;
        const invoiceId = crypto.randomUUID();
        const key = `${organizationId}/invoices/${invoiceId}`;
        const idempotencyKey = crypto.randomUUID();
        yield* r2.put(key, data.file, {
          httpMetadata: { contentType: data.file.type },
          customMetadata: { organizationId, invoiceId, idempotencyKey, fileName: data.file.name, contentType: data.file.type },
        });
        if (environment === "local") {
          yield* Effect.tryPromise(() =>
            R2_UPLOAD_QUEUE.send({
              account: "local",
              action: "PutObject",
              bucket: "tcei-r2-local",
              object: { key, size: data.file.size, eTag: "local" },
              eventTime: new Date().toISOString(),
            }),
          );
        }
        return { success: true, invoiceId, size: data.file.size };
      }),
    ),
  );
```

### File Validation Schema

Accepted types: PDF + standard web image types. 10MB limit.

**Size limits are fine:** Cloudflare Workers accept request bodies up to 100MB (Free/Pro plans, per `refs/cloudflare-docs/src/content/docs/workers/platform/limits.mdx`). R2 single PUT supports up to 5 GiB. No streaming needed for 10MB.

```ts
const invoiceMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const invoiceFileSchema = Schema.File
  .check(Schema.isMinSize(1))
  .check(Schema.isMaxSize(10_000_000))
  .check(
    Schema.makeFilter((file) =>
      invoiceMimeTypes.includes(file.type as (typeof invoiceMimeTypes)[number]),
    ),
  );

const uploadFormSchema = Schema.Struct({
  file: invoiceFileSchema,
});
```

### RouteComponent

**File-only upload form** — no name field. User just picks a file.

Two sections:
1. **Upload form** — file input (`accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"`) + submit button
2. **Invoice list** — table from loader data showing id, fileName, createdAt, status

Pattern: `useMutation` wrapping `useServerFn(uploadInvoice)`, submitting FormData.

```tsx
const uploadMutation = useMutation({
  mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
  onSuccess: () => { void router.invalidate(); },
});
```

Agent WebSocket for real-time updates (broadcast messages):
```tsx
useAgent<OrganizationAgent, unknown>({
  agent: "organization-agent",
  name: organizationId,
  onMessage: (event) => {
    // decode, filter invoice-related messages, invalidate router
  },
});
```

---

## 2. Wrangler Configuration

### Queue Binding

Add to `wrangler.jsonc` (top-level and `env.production`):

```jsonc
"queues": {
  "producers": [
    {
      "queue": "r2-invoice-notifications",
      "binding": "R2_UPLOAD_QUEUE"
    }
  ],
  "consumers": [
    {
      "queue": "r2-invoice-notifications",
      "max_batch_size": 10,
      "max_batch_timeout": 5,
      "max_retries": 3,
      "dead_letter_queue": "r2-invoice-notifications-dlq"
    }
  ]
}
```

### R2 Event Notification (Production)

Created via CLI (not in wrangler.jsonc — R2 event notifications are configured separately):

```bash
pnpm exec wrangler r2 bucket notification create tcei-r2-production \
  --event-type object-create \
  --queue r2-invoice-notifications \
  --prefix "invoices/"
```

From `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`:
> Event notifications are configured per-bucket via Dashboard or Wrangler CLI. Notifications send messages to a Queue when objects are created/deleted.

### R2 Notification Message Format

From `refs/cloudflare-docs/src/content/docs/queues/event-subscriptions/events-schemas.mdx`:
```json
{
  "account": "account-id",
  "action": "PutObject",
  "bucket": "my-bucket",
  "object": { "key": "file.txt", "size": 1024, "eTag": "etag-value" },
  "eventTime": "2024-05-24T19:36:44.379Z"
}
```

---

## 3. Worker Queue Handler

Add `queue` export to `src/worker.ts`. Pattern from refs/tca:

```ts
const r2QueueMessageSchema = Schema.Struct({
  action: Schema.NonEmptyString,
  object: Schema.Struct({ key: Schema.NonEmptyString }),
  eventTime: Schema.NonEmptyString,
});

// In the ExportedHandler:
async queue(batch, env) {
  for (const message of batch.messages) {
    const result = Schema.decodeUnknownExit(r2QueueMessageSchema)(message.body);
    if (Exit.isFailure(result)) { message.ack(); continue; }
    const notification = result.value;
    if (notification.action !== "PutObject") { message.ack(); continue; }

    const head = await env.R2.head(notification.object.key);
    if (!head) { message.ack(); continue; }

    const organizationId = head.customMetadata?.organizationId;
    const invoiceId = head.customMetadata?.invoiceId;
    const idempotencyKey = head.customMetadata?.idempotencyKey;
    const fileName = head.customMetadata?.fileName;
    const contentType = head.customMetadata?.contentType;
    if (!organizationId || !invoiceId || !idempotencyKey) { message.ack(); continue; }

    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    try {
      await stub.onInvoiceUpload({
        invoiceId,
        eventTime: notification.eventTime,
        idempotencyKey,
        r2ObjectKey: notification.object.key,
        fileName: fileName ?? "unknown",
        contentType: contentType ?? "application/octet-stream",
      });
      message.ack();
    } catch (error) {
      console.error("queue onInvoiceUpload failed", { key: notification.object.key, error });
      message.retry();
    }
  }
}
```

### Local Workaround

R2 event notifications don't fire in local dev (`wrangler dev`). The upload server fn manually sends to `R2_UPLOAD_QUEUE` when `ENVIRONMENT === "local"` — same pattern as refs/tca.

---

## 4. OrganizationAgent Changes

### Invoice Table (SQLite in Agent DO)

Primary key is a generated string id (`invoiceId` from upload). No user-provided name — `fileName` stores the original upload filename for display.

Add to constructor:
```ts
void this.sql`create table if not exists Invoice (
  id text primary key,
  fileName text not null,
  contentType text not null,
  createdAt integer not null,
  eventTime integer not null,
  idempotencyKey text not null unique,
  r2ObjectKey text not null,
  status text not null default 'uploaded',
  processedAt integer
)`;
```

### onInvoiceUpload Method

Called by queue handler. Inserts/upserts into Invoice table, broadcasts.

R2 key is generated by the upload server fn as `{organizationId}/invoices/{invoiceId}` and passed through via `r2ObjectKey`.

```ts
@callable()
onInvoiceUpload(upload: {
  invoiceId: string;
  eventTime: string;
  idempotencyKey: string;
  r2ObjectKey: string;
  fileName: string;
  contentType: string;
}) {
  const eventTime = Date.parse(upload.eventTime);
  if (!Number.isFinite(eventTime)) throw new Error(`Invalid eventTime: ${upload.eventTime}`);

  void this.sql`
    insert into Invoice (id, fileName, contentType, createdAt, eventTime, idempotencyKey, r2ObjectKey, status, processedAt)
    values (${upload.invoiceId}, ${upload.fileName}, ${upload.contentType}, ${eventTime}, ${eventTime}, ${upload.idempotencyKey}, ${upload.r2ObjectKey}, 'uploaded', null)
    on conflict(id) do update set
      eventTime = excluded.eventTime,
      idempotencyKey = excluded.idempotencyKey,
      status = 'uploaded',
      processedAt = null
  `;

  this.broadcast(JSON.stringify({ type: "invoice_uploaded", invoiceId: upload.invoiceId, fileName: upload.fileName }));
}
```

### getInvoices Method

```ts
@callable()
getInvoices() {
  return this.sql`select * from Invoice order by createdAt desc`;
}
```

---

## 5. CloudflareEnv / Env Type

`R2_UPLOAD_QUEUE` must be in the `Env` interface. After adding the queue binding to `wrangler.jsonc`, run `pnpm typecheck` (which generates wrangler types) to get `R2_UPLOAD_QUEUE: Queue` in `Env`.

Current `CloudflareEnv` is `ServiceMap.Service<Env>("CloudflareEnv")` — no changes needed, it passes through the full `Env`.

---

## 6. Key Patterns from refs/tca

### Upload Route (`app.$organizationId.upload.tsx`)
- `createServerFn({ method: "POST" })` with raw FormData `inputValidator`
- Manual `Schema.decodeUnknownSync` of `Object.fromEntries(data)` for FormData
- R2.put with `httpMetadata` + `customMetadata` (organizationId, name, idempotencyKey)
- Local env: manually send to queue since R2 event notifications are production-only
- `useMutation` + `useServerFn` for upload
- `useAgent` WebSocket for real-time broadcast messages

### Queue Handler (`worker.ts`)
- `Schema.decodeUnknownExit(r2QueueMessageSchema)` for message validation
- `env.R2.head()` to get customMetadata from the R2 object
- `getAgentByName` → `stub.onUpload(...)` RPC call
- `message.ack()` on success, `message.retry()` on failure

### Agent (`organization-agent.ts`)
- Constructor creates SQLite tables via `this.sql`
- `@callable()` decorator for RPC-accessible methods
- `this.broadcast(JSON.stringify(msg))` for WebSocket notifications
- Idempotency via `on conflict` upsert
- Event time comparison to handle out-of-order notifications

---

## 7. Effect v4 Patterns

From `refs/effect4`:
- **Services**: `ServiceMap.Service<Self>()("Id", { make })` — our `R2` service already follows this
- **Effect.fn**: `Effect.fn("Name")(function* (...) { ... })` for traced functions
- **Effect.gen**: `yield*` for effectful operations
- **Schema.TaggedErrorClass**: for typed errors
- **Layer composition**: `Layer.provideMerge` and `Layer.merge`

---

## 8. R2 Key Structure

**Decision:** `{organizationId}/invoices/{invoiceId}`

- `invoices` (plural) — consistent with route name `/invoices`, REST conventions, and the table name `Invoice` (singular for entity, plural for collection/namespace)
- `invoiceId` — `crypto.randomUUID()` generated server-side on upload
- Enables prefix-based R2 event notifications scoped to `invoices/`
- `fileName` (original upload name) stored in R2 `customMetadata` and Invoice table for display

---

## 9. Delete Support

**Yes, include in v1.** refs/tca supports delete via:
- `deleteUpload` server fn (`createServerFn({ method: "POST" })`) — calls `R2.delete(key)` + local queue send
- `onDelete` agent method — deletes from SQLite, terminates any active workflow, broadcasts `upload_deleted`
- Queue handler handles `DeleteObject` action

For invoices, implement the same pattern:
- `deleteInvoice` server fn — R2 delete + local queue send
- `onInvoiceDelete` agent method — delete from Invoice table, broadcast

---

## 10. Signed URLs

Required for viewing PDFs/images in-browser. refs/tca pattern:
- **Local:** API proxy route (`/api/org/$organizationId/invoice/$invoiceId`) that reads from R2 and streams the response
- **Production:** Presigned URLs via `aws4fetch` (`AwsClient` with `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY`)

Implement local API proxy first; production presigned URLs can follow.

---

## 11. Implementation Steps

1. **wrangler.jsonc** — add `queues` config (producers + consumers)
2. **`pnpm typecheck`** — regenerate `Env` types with `R2_UPLOAD_QUEUE`
3. **`src/organization-agent.ts`** — add Invoice table, `onInvoiceUpload`, `getInvoices`
4. **`src/worker.ts`** — add `queue` handler
5. **`src/routes/app.$organizationId.invoices.tsx`** — route with file-only upload form + invoice list
6. **`src/routes/app.$organizationId.tsx`** — add Invoices sidebar link
7. **Verify** — `pnpm typecheck && pnpm lint`

yes
