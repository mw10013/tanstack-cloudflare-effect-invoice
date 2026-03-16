# Workers AI JSON Response & AI Gateway Caching Research

## Structured JSON Output

Workers AI supports two approaches for getting JSON responses from text generation models.

### 1. `json_schema` — Structured output with schema constraint

```ts
const result = await env.AI.run(model, {
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: {
        isInvoice: { type: "boolean" },
        total: { type: ["string", "null"] },
      },
      required: ["isInvoice", "total"],
    },
  },
});
```

From `refs/cloudflare-docs/src/content/docs/workers-ai/features/json-mode.mdx`:

> JSON Mode is compatible with OpenAI's implementation; to enable add the `response_format` property to the request object.
> Where `json_schema` must be a valid JSON Schema declaration.

Unlike OpenAI, CF Workers AI `json_schema` takes the raw JSON Schema object directly — no `{ name, schema }` wrapping.

### 2. `json_object` — Unstructured JSON

```ts
const result = await env.AI.run(model, {
  messages: [{ role: "user", content: "..." }],
  response_format: { type: "json_object" },
});
```

Ensures valid JSON output but without schema constraints. You still need to validate the shape yourself.

### Messages vs Prompt

The `prompt` parameter is a simpler single-string interface. The `messages` array (with `role`/`content`) gives more control. Both work with `response_format`. The docs examples primarily use `messages`.

### Model Support

From `json-mode.mdx` supported models list includes `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (the model in use).

> Note that Workers AI can't guarantee that the model responds according to the requested JSON Schema. Depending on the complexity of the task and adequacy of the JSON Schema, the model may not be able to satisfy the request in extreme situations. If that's the case, then an error `JSON Mode couldn't be met` is returned and must be handled.
> JSON Mode currently doesn't support streaming.

### Response Shape

With `messages`, the response is `{ response: <parsed_object> }` — the `response` field contains the already-parsed JSON object matching the schema. With `prompt`, the response is a plain string that needs JSON.parse.

From json-mode.mdx response example:
```json
{
  "response": {
    "name": "India",
    "capital": "New Delhi",
    "languages": ["Hindi", "English", ...]
  }
}
```

## AI Gateway Caching

From `refs/cloudflare-docs/src/content/docs/ai-gateway/configuration/caching.mdx`:

> AI Gateway caching works by saving AI API responses at the edge. When a matching request comes in, the cached result is served instead of making a new API call.

### skipCache + cacheTtl Together

> - `cf-skip-cache`: Skip reading from the cache but still write to it
> - `cf-cache-ttl`: Cache TTL in seconds (default: 0 = no caching)

When `skipCache: true` and `cacheTtl` is set:
- The request **does not** read from cache (always hits the AI model)
- Whether the response is **written** to cache is **not explicitly documented** — the skip cache definition only says "bypassing the cache and fetching the request directly from the original provider, without utilizing any cached copy"
- Needs empirical testing to confirm write-through behavior

From `caching.mdx`: "Skip cache refers to bypassing the cache and fetching the request directly from the original provider, without utilizing any cached copy."

### Gateway Options in Workers AI Binding

```ts
await env.AI.run(model, inputParams, {
  gateway: {
    id: "my-gateway-id",
    skipCache: true,
    cacheTtl: 604800, // 7 days in seconds
  },
});
```

## Recommendation for ai-direct.tsx

- Single transport: gateway with `skipCache: true`, `cacheTtl: 7 days`
- Use `response_format: { type: "json_schema", json_schema: { name, schema } }` for structured extraction
- Use `messages` array format for the prompt
- Parse the `response` field from the result as JSON, then decode with Effect schema
