# Login SSR Form Research

Goal: rewrite `login.tsx` as `login1.tsx` using TanStack Form SSR with TanStack Start.

## Current login.tsx Architecture

Client-only form. No SSR form state.

```
useForm (client validation) → onSubmit → useMutation → useServerFn(login) → createServerFn POST
```

- Schema: Effect `Schema.Struct` converted via `Schema.toStandardSchemaV1()`
- Validation runs client-side (`validators.onSubmit`) AND server-side (`inputValidator`)
- Server fn uses Effect for business logic (magic link send)
- Mutation state drives UI (isPending, error, data.success)

## TanStack Form SSR Pattern (TanStack Start)

Source: `refs/tan-form/examples/react/tanstack-start/` and `refs/tan-form/packages/react-form-start/`

### Architecture

```
<form action={handleForm.url} method="post"> → native form submit (FormData)
  ↓
createServerValidate (decodes FormData, runs onServerValidate)
  ↓ fail: sets cookie + 302 redirect back
  ↓ pass: returns decoded data for business logic
  ↓
getFormData (loader reads cookie, deletes it)
  ↓
useTransform + mergeForm (hydrates server errors into client form)
```

### Key Pieces

**1. Shared form options** (`formOptions`)
```ts
import { formOptions } from "@tanstack/react-form-start"

export const formOpts = formOptions({
  defaultValues: { email: "" },
})
```

**2. Server validation** (`createServerValidate`)
```ts
import { createServerValidate, ServerValidateError } from "@tanstack/react-form-start"

const serverValidate = createServerValidate({
  ...formOpts,
  onServerValidate: ({ value }) => {
    // return string = error, undefined = pass
  },
})
```

- Internally creates a `createServerFn({ method: "POST" })` that:
  - Decodes `FormData` via `decode-formdata` library
  - Runs `onServerValidate` (supports Standard Schema validators OR custom fn)
  - On fail: serializes error state to `_tanstack_form_internals` cookie via `devalue`, throws `ServerValidateError` with a 302 Response
  - On pass: returns decoded data

**3. Form handler** (wraps serverValidate in a createServerFn)
```ts
export const handleForm = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("Invalid form data")
    return data
  })
  .handler(async (ctx) => {
    try {
      const validatedData = await serverValidate(ctx.data)
      // ... business logic with validatedData ...
    } catch (e) {
      if (e instanceof ServerValidateError) return e.response
      // handle other errors
    }
  })
```

**4. Get form data from cookie** (server fn called in loader)
```ts
import { getFormData } from "@tanstack/react-form-start"

export const getFormDataFromServer = createServerFn({ method: "GET" }).handler(
  async () => getFormData()
)
```

- Reads `_tanstack_form_internals` cookie, deletes it, returns form state
- Returns `initialFormState` (`{ errorMap: { onServer: undefined }, errors: [] }`) if no cookie

**5. Client component** (merges server state)
```tsx
import { mergeForm, useForm, useTransform } from "@tanstack/react-form-start"
import { useStore } from "@tanstack/react-store"

// In loader:
loader: async () => ({ state: await getFormDataFromServer() })

// In component:
const { state } = Route.useLoaderData()
const form = useForm({
  ...formOpts,
  transform: useTransform((baseForm) => mergeForm(baseForm, state), [state]),
})
const formErrors = useStore(form.store, (formState) => formState.errors)

return (
  <form action={handleForm.url} method="post" encType="multipart/form-data">
    {/* native <form> submit, no JS needed */}
  </form>
)
```

## Differences from Current login.tsx

| Aspect | Current (login.tsx) | SSR Pattern (login1.tsx) |
|---|---|---|
| Submit mechanism | `form.handleSubmit()` → mutation → `useServerFn` | Native `<form action={url} method="post">` |
| Data format | JSON via server fn input | FormData (decoded server-side) |
| Validation flow | Client schema → server `inputValidator` | Client validators + `onServerValidate` via cookie round-trip |
| Error display | `loginMutation.error` | `useStore(form.store, s => s.errors)` + `mergeForm` |
| JS requirement | Required (mutation-driven) | Works without JS (progressive enhancement) |
| Success handling | `loginMutation.data?.success` | Need custom approach (see open questions) |
| Package | `@tanstack/react-form` | `@tanstack/react-form-start` (not yet installed) |

## Challenges / Open Questions

### 1. `@tanstack/react-form-start` not installed
Need to add it. It re-exports everything from `@tanstack/react-form` plus SSR utilities.

### 2. Business Logic After Validation
The SSR pattern's `createServerValidate` only handles validation. Our login needs business logic (send magic link via Effect). Two options:

**Option A**: Put business logic in `handleForm` handler after `serverValidate` succeeds:
```ts
export const handleForm = createServerFn({ method: "POST" })
  .inputValidator(...)
  .handler(async ({ data, context: { runEffect } }) => {
    try {
      const validatedData = await serverValidate(data)
      // Run Effect business logic here
      await runEffect(Effect.gen(function* () {
        // send magic link...
      }))
    } catch (e) {
      if (e instanceof ServerValidateError) return e.response
    }
  })
```

**Option B**: Skip `createServerValidate` entirely, use `onServerValidate` in `formOptions` with Standard Schema, and handle everything in a custom server fn. This loses the cookie round-trip pattern but keeps more control.

### 3. Success State
The SSR pattern is designed for validation error → redirect → show errors. It doesn't have a built-in "success" state mechanism. The current login shows a "check your email" card on success.

Options:
- **Redirect on success**: `handleForm` returns a redirect to `/login?sent=1` or `/check-email` route
- **Cookie-based success**: Set a custom cookie/flash message, read in loader
- **Hybrid**: Use the SSR pattern for validation errors but keep `useMutation` for the success path

### 4. Demo Mode Magic Link
Current login returns `magicLink` URL in demo mode. With native form submit + redirect, we'd need to pass this through a cookie or query param.

### 5. Effect Integration
`createServerValidate` creates its own internal `createServerFn`. Our project wraps all server fns with `runEffect` from context. The internal server fn won't have access to this. Options:
- Use Effect inside the outer `handleForm` handler only (after validation)
- For validation that needs Effect services, use `onServerValidate` as an async fn that manually runs Effect

### 6. Cookie-Based State Transport
The SSR pattern stores form state in a cookie (`_tanstack_form_internals`) using `devalue` serialization, then reads + deletes it in the loader. This works but:
- Cookie size limits (~4KB) could be a concern for large error messages
- Adds a cookie dependency (fine for our use case)

### 7. `decode-formdata` Dependency
`createServerValidate` uses `decode-formdata` to convert FormData to a typed object. For simple forms (just an email string), this is straightforward. For complex nested forms, you'd pass a `FormDataInfo` descriptor.

## Recommended Approach

Given the login form is simple (one email field) and needs business logic + success state:

1. Install `@tanstack/react-form-start`
2. Use `formOptions` for shared config with Effect Schema via `toStandardSchemaV1`
3. Use `createServerValidate` + `handleForm` pattern for validation
4. Put Effect business logic (magic link send) in `handleForm` after validation passes
5. On success: redirect to a success view (query param `?sent=1` or separate state)
6. Demo mode magic link: pass via query param on redirect or flash cookie

### Skeleton

```ts
// formOptions (shared)
const loginFormOpts = formOptions({
  defaultValues: { email: "" },
})

// server validation
const serverValidate = createServerValidate({
  ...loginFormOpts,
  onServerValidate: Schema.toStandardSchemaV1(loginSchema),
})

// form handler
const handleLoginForm = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("Invalid form data")
    return data
  })
  .handler(async ({ data, context: { runEffect } }) => {
    try {
      const validatedData = await serverValidate(data)
      const result = await runEffect(
        Effect.gen(function* () {
          // send magic link...
          return { success: true, magicLink }
        })
      )
      // redirect on success, possibly with query params
    } catch (e) {
      if (e instanceof ServerValidateError) return e.response
      throw e
    }
  })

// loader
const getLoaderData = createServerFn({ method: "GET" }).handler(
  async ({ context: { runEffect } }) => {
    const state = await getFormDataFromServer()
    const { isDemoMode } = await runEffect(...)
    return { state, isDemoMode }
  }
)

// component
function RouteComponent() {
  const { state, isDemoMode } = Route.useLoaderData()
  const form = useForm({
    ...loginFormOpts,
    transform: useTransform((baseForm) => mergeForm(baseForm, state), [state]),
  })
  // native <form action={handleLoginForm.url} method="post">
}
```

## Files to Read for Implementation

- `refs/tan-form/packages/react-form-start/src/createServerValidate.tsx` — internal server fn, FormData decoding, cookie set
- `refs/tan-form/packages/react-form-start/src/getFormData.tsx` — cookie read + delete, initialFormState
- `refs/tan-form/packages/react-form-start/src/utils.ts` — cookie helpers (devalue serialize)
- `refs/tan-form/packages/react-form-start/src/error.ts` — ServerValidateError class
- `refs/tan-form/examples/react/tanstack-start/` — complete working example
