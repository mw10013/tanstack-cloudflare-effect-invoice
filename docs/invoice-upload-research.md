# Invoice Upload Feature Research

## Overview

Upload invoices (PDF + standard web image types) to R2, trigger queue notification on R2 put, queue handler calls OrganizationAgent to insert into `Invoice` table and broadcast. Later iterations kick off a workflow to process the invoice.

**Sample invoices:** `invoices/cloudflare-invoice-2026-03-04.pdf`, `invoices/invoice_EU-ES608274.pdf`

---

## Architecture Flow

```
User uploads file via form
  → Server fn receives FormData (file + name)
  → R2.put with customMetadata { organizationId, name, idempotencyKey }
  → R2 event notification (production) / manual queue send (local)
  → Queue consumer decodes message, extracts metadata from R2 head
  → Gets OrganizationAgent stub by organizationId
  → Calls agent.onInvoiceUpload(...)
  → Agent inserts row into Invoice table
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

We have R2 service so should not use R2 binding. 

Pattern from refs/tca `uploadFile`:
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
        const { R2, R2_UPLOAD_QUEUE } = yield* CloudflareEnv;
        const key = `${organizationId}/${data.name}`;
        const idempotencyKey = crypto.randomUUID();
        yield* Effect.tryPromise(() =>
          R2.put(key, data.file, {
            httpMetadata: { contentType: data.file.type },
            customMetadata: { organizationId, name: data.name, idempotencyKey },
          }),
        );
        // Local: manually enqueue since R2 event notifications don't fire locally
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
        return { success: true, name: data.name, size: data.file.size, idempotencyKey };
      }),
    ),
  );
```

### File Validation Schema

Accepted types: PDF + standard web image types.

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
  .check(Schema.isMaxSize(10_000_000))  // 10MB limit for invoices
  .check(
    Schema.makeFilter((file) =>
      invoiceMimeTypes.includes(file.type as (typeof invoiceMimeTypes)[number]),
    ),
  );

// No name in the upload schema. We do not want the user to have to type a name.

const uploadFormSchema = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1)).check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  file: invoiceFileSchema,
});
```

### RouteComponent

No name in upload form. we don't want the user to have to type a name.

Two sections:
1. **Upload form** — TanStack Form with name + file input (`accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"`)


We don't have name for now. use id instead.

2. **Invoice list** — table/grid from loader data showing name, createdAt, status

Pattern: `useMutation` wrapping `useServerFn(uploadInvoice)`, submitting FormData.

```tsx
const form = useForm({ defaultValues: { name: "", file: null as File | null } });
const uploadMutation = useMutation({
  mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
  onSuccess: () => { form.reset(); void router.invalidate(); },
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

I think we want to use `pnpm exec wrangler` instead of `npx wrangler`


Created via CLI (not in wrangler.jsonc — R2 event notifications are configured separately):

```bash
npx wrangler r2 bucket notification create tcei-r2-production \
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
    const name = head.customMetadata?.name;
    const idempotencyKey = head.customMetadata?.idempotencyKey;
    if (!organizationId || !name || !idempotencyKey) { message.ack(); continue; }

    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    try {
      await stub.onInvoiceUpload({ name, eventTime: notification.eventTime, idempotencyKey, r2ObjectKey: notification.object.key });
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

No name for now. primary key should string id that is generated.

Add to constructor:
```ts
void this.sql`create table if not exists Invoice (
  name text primary key,
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

No name. I'm not sure how to handle r2ObjectKey. Are we generating that key? I think we need to drill down into the naming convention for invoices. they should probably have an organization id prefix and then maybe a generated id. there is no name because we don't want to force the user to type a name on upload.

```ts
@callable()
onInvoiceUpload(upload: {
  name: string;
  eventTime: string;
  idempotencyKey: string;
  r2ObjectKey: string;
}) {
  const eventTime = Date.parse(upload.eventTime);
  if (!Number.isFinite(eventTime)) throw new Error(`Invalid eventTime: ${upload.eventTime}`);

  void this.sql`
    insert into Invoice (name, createdAt, eventTime, idempotencyKey, r2ObjectKey, status, processedAt)
    values (${upload.name}, ${eventTime}, ${eventTime}, ${upload.idempotencyKey}, ${upload.r2ObjectKey}, 'uploaded', null)
    on conflict(name) do update set
      createdAt = excluded.createdAt,
      eventTime = excluded.eventTime,
      idempotencyKey = excluded.idempotencyKey,
      r2ObjectKey = excluded.r2ObjectKey,
      status = 'uploaded',
      processedAt = null
  `;

  this.broadcast(JSON.stringify({ type: "invoice_uploaded", name: upload.name, idempotencyKey: upload.idempotencyKey }));

  // Future: kick off invoice processing workflow
  // await this.runWorkflow("InvoiceProcessingWorkflow", { ... });
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

Following tca pattern: `{organizationId}/{name}`

For invoices, consider: `{organizationId}/invoices/{name}` to namespace within the bucket and enable prefix-based R2 notifications.

---

## 9. Implementation Steps

1. **wrangler.jsonc** — add `queues` config (producers + consumers)
2. **`pnpm typecheck`** — regenerate `Env` types with `R2_UPLOAD_QUEUE`
3. **`src/organization-agent.ts`** — add Invoice table, `onInvoiceUpload`, `getInvoices`
4. **`src/worker.ts`** — add `queue` handler
5. **`src/routes/app.$organizationId.invoices.tsx`** — route with upload form + invoice list
6. **`src/routes/app.$organizationId.tsx`** — add Invoices sidebar link
7. **Verify** — `pnpm typecheck && pnpm lint`

---

## 10. Open Questions

- **R2 key prefix**: `{orgId}/{name}` vs `{orgId}/invoices/{name}`? Latter allows scoped R2 notifications.

the latter. however, `invoices` vs `invoice`? trades-off, recommendation. there is no name, but I guess there's a generated id? I'm not sure. recommendation? I don't want the user to have to type a name.

- **File naming**: User-provided name or auto-generated (UUID/timestamp)? tca uses user-provided names.

- **Max file size**: 10MB? PDFs can be large.

should be fine, i guess. do you see any complications to support? can forms handle 10MB files? can cloudflare? would we need streaming? hopefully not.

- **Invoice status states**: `uploaded` → `processing` → `processed` → `error`?

should be fine for now.

- **Delete support**: Do we need invoice deletion in v1?

hmmm, does tca reference project support delete?

- **Signed URLs**: For viewing PDFs in-browser, need presigned URLs (tca uses aws4fetch for production, API proxy for local).

yes
