# Research: Move `uploadInvoice` into OrganizationAgent via WebSocket RPC

## Current Upload Flow

```
UI (FormData) → server fn (uploadInvoice) → R2.put() → Queue.send() [local only]
                                                            ↓
                                              Queue handler → R2.head() → stub.onInvoiceUpload()
                                                                            ↓
                                                              OrganizationAgent → upsert DB + runWorkflow
```

Key steps in `uploadInvoice` server fn (`app.$organizationId.invoices.tsx` L142-189):
1. Auth: validate session, extract `organizationId`
2. Generate `invoiceId` + `idempotencyKey`
3. `R2.put` with file blob + custom metadata (organizationId, invoiceId, idempotencyKey, fileName, contentType)
4. Local env only: manually send queue message to `INVOICE_INGEST_Q` (R2 notifications don't work locally)

The R2 notification flow (`worker.ts` L170-196) then picks up the put event, reads metadata via `R2.head`, and calls `stub.onInvoiceUpload()` which upserts the DB record + starts the extraction workflow + broadcasts activity.

## Target Flow

```
UI (File) → base64 encode → stub.uploadInvoice() via WebSocket RPC → OrganizationAgent
                                                                        ↓
                                                              R2.put() (with custom metadata)
                                                                        ↓
                                                              [prod] R2 notification → onInvoiceUpload
                                                              [local] Queue.send() → onInvoiceUpload
```

The agent's `@callable() uploadInvoice` only puts to R2. It does NOT call `onInvoiceUpload` directly or broadcast — that remains the job of the R2 notification flow.

## Why Base64 over WebSocket RPC Works

The agents SDK RPC layer (`@callable()`) uses JSON-only serialization:
- `serializable.ts` — `ArrayBuffer`, `Uint8Array`, `Blob` are `NonSerializable` (L8-32)
- `react.tsx` L619 — `agent.send(JSON.stringify(request))`
- `index.ts` L1162 — `JSON.parse(message)` server side

Base64-encoding the file as a string fits the JSON RPC protocol. Current file limit is 10MB → ~13.3MB base64 → well within Cloudflare's 32MB WebSocket text frame limit. This follows the exact `stub.xxx()` pattern used by `createInvoice` and `softDeleteInvoice`.

## Implementation Plan

### 1. Add CloudflareEnv + R2 to agent's `makeRunEffect`

`makeRunEffect` (`organization-agent.ts` L17-27) currently provides `OrganizationRepository` + logger. Need to add `CloudflareEnv` and `R2` so the `@callable()` method can use the R2 service.

```ts
const makeRunEffect = (ctx: DurableObjectState, env: Env) => {
  const sqliteLayer = SqliteClient.layer({ db: ctx.storage.sql });
  const repoLayer = Layer.provideMerge(OrganizationRepository.layer, sqliteLayer);
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );
  const r2Layer = Layer.provideMerge(R2.layer, envLayer);
  const layer = Layer.mergeAll(repoLayer, r2Layer, makeLoggerLayer(env));
  return <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ) => Effect.runPromise(Effect.provide(effect, layer));
};
```

This mirrors `makeEnvLayer` in `worker.ts` L32-39 and the R2 layer composition in `worker.ts` L283-284.

### 2. Agent `@callable() uploadInvoice`

```ts
@callable()
uploadInvoice(input: { fileName: string; contentType: string; base64: string }) {
  return this.runEffect(
    Effect.gen({ self: this }, function* () {
      yield* getConnectionIdentity();
      const invoiceId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();
      const key = `${self.name}/invoices/${invoiceId}`;
      const bytes = Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0));
      const r2 = yield* R2;
      yield* r2.put(key, bytes, {
        httpMetadata: { contentType: input.contentType },
        customMetadata: {
          organizationId: self.name,
          invoiceId,
          idempotencyKey,
          fileName: input.fileName,
          contentType: input.contentType,
        },
      });
      const environment = yield* Config.nonEmptyString("ENVIRONMENT");
      if (environment === "local") {
        const env = yield* CloudflareEnv;
        const queue = yield* Effect.fromNullishOr(env.INVOICE_INGEST_Q);
        yield* Effect.tryPromise(() =>
          queue.send({
            account: "local",
            action: "PutObject",
            bucket: "tcei-r2-local",
            object: { key, size: bytes.byteLength, eTag: "local" },
            eventTime: new Date().toISOString(),
          }),
        );
      }
      return { invoiceId };
    }),
  );
}
```

Key points:
- Validates connection identity (auth via WebSocket handshake)
- Uses `R2` service (not raw binding) per project conventions
- Local env: sends queue message manually (same pattern as current server fn L174-184)
- Prod: R2 notification fires automatically, triggers `onInvoiceUpload` via the existing queue flow
- No broadcast — `onInvoiceUpload` handles that
- Validates file on agent side (see section 4 below)

### 3. Client-side mutation

```ts
const { stub } = useOrganizationAgent();
const uploadMutation = useMutation({
  mutationFn: async (file: File) => {
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return stub.uploadInvoice({
      fileName: file.name,
      contentType: file.type,
      base64,
    });
  },
  onSuccess: (result) => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSelectedInvoiceId(result.invoiceId);
    void queryClient.invalidateQueries({
      queryKey: invoicesQueryKey(organizationId),
    });
  },
});
```

The `<input>` change handler calls `uploadMutation.mutate(file)` directly with the `File` object instead of wrapping in `FormData`.

### 4. Validation

Agent-side validation (defense in depth — WebSocket is authenticated but validate anyway):

```ts
const invoiceMimeTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const MAX_FILE_SIZE = 10_000_000;
const MAX_BASE64_SIZE = Math.ceil(MAX_FILE_SIZE * 4 / 3) + 4;

// Inside uploadInvoice, before decoding:
if (input.base64.length > MAX_BASE64_SIZE)
  return yield* new OrganizationAgentError({ message: "File too large" });
if (!invoiceMimeTypes.includes(input.contentType as any))
  return yield* new OrganizationAgentError({ message: "Invalid file type" });
```

Client-side validation stays on the `<input accept>` attribute and can also check in the mutation function before encoding.

### 5. What gets removed from `app.$organizationId.invoices.tsx`

| Line(s) | What | Notes |
|---------|------|-------|
| L51-61 | `invoiceFileSchema`, `uploadFormSchema` | Validation moves to agent |
| L142-189 | `uploadInvoice` server fn | Replaced by agent `@callable()` |
| L264 | `useServerFn(uploadInvoice)` | No longer needed |
| L265-271 | `uploadMutation` (FormData-based) | Replaced with base64-based mutation |

### 6. What gets added

| File | What |
|------|------|
| `organization-agent.ts` | `@callable() uploadInvoice(...)` method |
| `organization-agent.ts` | `R2`, `CloudflareEnv`, `ConfigProvider` imports + layer changes in `makeRunEffect` |
| `app.$organizationId.invoices.tsx` | New `uploadMutation` using `stub.uploadInvoice()` with base64 |

### 7. Imports cleanup

The route file can drop these imports after the change:
- `createServerFn`, `useServerFn` from `@tanstack/react-start` (if no other server fns remain — check `getInvoices`, `getInvoiceItems`)
- `Config`, `Redacted` from `effect` (if only used by upload)
- `Auth`, `CloudflareEnv`, `R2`, `Request` (if only used by upload server fn — check other server fns)
- `Schema` from `effect/Schema` (if only used by upload validation)

Note: `getInvoices` and `getInvoiceItems` are still server fns, so most imports stay. Only `uploadFormSchema`/`invoiceFileSchema` and the upload-specific code go away.
