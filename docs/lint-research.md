# Lint Research

## Scope

This doc reflects your annotations:

- exclude shadcn/ui lint noise via Oxlint config
- keep researching before changing form-related lint
- keep straightforward fixes documented for later implementation
- no app code changes yet

---

## 1. Exclude External UI Components

These current lint failures come from shadcn/ui-style external components, not app logic:

- `src/components/ui/breadcrumb.tsx`
- `src/components/ui/label.tsx`
- `src/components/ui/pagination.tsx`
- `src/components/ui/input-group.tsx`

Current `.oxlintrc.json` already ignores several external UI files:

```json
"ignorePatterns": [
  "build/",
  "dist/",
  ".wrangler/",
  "worker-configuration.d.ts",
  "refs/",
  "playwright-report/",
  "test-results/",
  "src/components/ui/carousel.tsx",
  "src/components/ui/chart.tsx",
  "src/components/ui/field.tsx",
  "src/components/ui/form.tsx",
  "src/components/ui/input-otp.tsx",
  "src/components/ui/progress.tsx",
  "src/components/ui/sidebar.tsx",
  "src/components/ui/toggle-group.tsx"
]
```

Oxlint config supports `ignorePatterns` at the config root:

> `ignorePatterns`: Ignore additional files from the config file.

Source: Oxc config docs.

### Recommended config change

Add these four files to `ignorePatterns` in `.oxlintrc.json`:

```json
"src/components/ui/breadcrumb.tsx",
"src/components/ui/input-group.tsx",
"src/components/ui/label.tsx",
"src/components/ui/pagination.tsx"
```

This is better than disabling broad a11y rules globally.

---

## 2. Form Library `children` Prop

### What the lint rule is trying to protect

`react/no-children-prop` exists because standard React style prefers actual nested JSX children over passing `children` as a normal prop.

From `eslint-plugin-react`:

> Children should always be actual children, not passed in as a prop.

Examples marked incorrect by the rule:

```tsx
<div children="Children" />
<MyComponent children={<AnotherComponent />} />
```

Examples marked correct by the rule:

```tsx
<div>Children</div>
<MyComponent>Children</MyComponent>
```

So the rule is mainly about preserving canonical React structure and avoiding weird/less-readable JSX.

### Why TanStack Form conflicts with it

TanStack Form explicitly documents the `children` render-prop API.

From `refs/tan-form/docs/framework/react/guides/basic-concepts.md:62`:

> The component accepts a `name` prop... It also accepts a `children` prop, which is a render prop function that takes a `field` object as its argument.

Documented example:

```tsx
<form.Field
  name="firstName"
  children={(field) => (
    <>
      <input
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      <FieldInfo field={field} />
    </>
  )}
/>
```

TanStack docs also call out this exact lint conflict.

From `refs/tan-form/docs/framework/react/guides/basic-concepts.md:82`:

> If you run into issues handling `children` as props, make sure to check your linting rules.

And they provide this ESLint config:

```json
"react/no-children-prop": [
  true,
  {
    "allowFunctions": true
  }
]
```

That matters. TanStack is not saying "disable the rule entirely". It is saying "keep the rule, but allow function-valued render props".

### Current app examples

From `src/routes/login.tsx:155`:

```tsx
<form.Field
  name="email"
  children={(field) => {
    const isInvalid = field.state.meta.errors.length > 0;
    return (
      <Field data-invalid={isInvalid}>
        <FieldLabel htmlFor={field.name}>Email</FieldLabel>
        <Input
          id={field.name}
          name={field.name}
          type="email"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => {
            field.handleChange(e.target.value);
          }}
        />
      </Field>
    );
  }}
/>
```

From `src/routes/app.$organizationId.invitations.tsx:304`:

```tsx
<form.Subscribe
  selector={(state) => state.canSubmit}
  children={(canSubmit) => (
    <Button type="submit" disabled={!canSubmit || !isHydrated || inviteMutation.isPending}>
      Invite
    </Button>
  )}
/>
```

TanStack also documents `form.Subscribe` with `children` render props.

From `refs/tan-form/docs/framework/react/guides/reactivity.md:31`:

> The `form.Subscribe` component is best suited when you need to react to something within the UI of your component.

Documented example:

```tsx
<form.Subscribe
  selector={(state) => state.values.firstName}
  children={(firstName) => (
    <form.Field>
      {(field) => (
        <input ... />
      )}
    </form.Field>
  )}
/>
```

### Decision options

#### Option A: Configure the rule, not disable it

Recommended.

```json
"react/no-children-prop": ["error", { "allowFunctions": true }]
```

Why:

- matches TanStack Form docs exactly
- still catches bad non-function usages like `<div children="x" />`
- allows render-prop APIs like `form.Field` and `form.Subscribe`

#### Option B: Rewrite all call sites to JSX children form

Example:

```tsx
<form.Field name="email">
  {(field) => (
    <Field>...</Field>
  )}
</form.Field>
```

This may also satisfy lint, but it is a broader refactor and not necessary if we adopt TanStack's documented config.

### Recommendation

Do not disable `react/no-children-prop` globally.

Instead, change it to:

```json
"react/no-children-prop": ["error", { "allowFunctions": true }]
```

That preserves the intent of the rule while aligning with TanStack Form.

---

## 3. `anchor-has-content` in App Code

This is separate from the external `pagination.tsx` issue.

### Current app examples

From `src/routes/_mkt.index.tsx:35`:

```tsx
<Button
  variant="default"
  className="h-11 rounded-full! px-6 text-base! font-medium"
  render={
    <a href={sessionUser.role === "admin" ? "/admin" : "/app"} />
  }
>
  Go to Dashboard
</Button>
```

From `src/routes/_mkt.tsx:103`:

```tsx
<Button
  variant="ghost"
  className={className}
  aria-label="GitHub repo"
  render={
    <a
      href="https://github.com/mw10013/tanstack-cloudflare-effect-invoice"
      target="_blank"
      rel="noopener noreferrer"
    />
  }
>
```

The lint is correct here: the actual `<a>` element is self-closing and has no content.

### Base UI guidance matters here

From Base UI Button docs:

> The Button component enforces button semantics... It should not be used for links.

And more specifically:

> Links (`<a>`) have their own semantics and should not be rendered as buttons through the `render` prop.

> If a link needs to look like a button visually, style the `<a>` element directly with CSS rather than using the Button component.

Source: Base UI Button docs.

### Implication

The problem is not only missing accessible content on `<a>`.

The deeper issue: current code uses Base UI `Button` to render links through `render={<a ... />}` even though Base UI says not to do that.

### Fix direction

Later, fix these by replacing patterns like:

```tsx
<Button render={<a href="..." />}>Label</Button>
```

with either:

- styled `<a>` / TanStack `Link` directly
- shared button class helper applied to `<a>` / `Link`

This is likely the right fix for app code. For external `src/components/ui/pagination.tsx`, keep excluding via `ignorePatterns`.

---

## 4. `unicorn/no-array-method-this-argument` on `Option.map`

### Current app examples

From `src/lib/Auth.ts:166`:

```tsx
activeOrganizationId: Option.map(
  activeOrganization,
  (organization) => organization.id,
).pipe(Option.getOrUndefined),
```

From `src/routes/_mkt.tsx:22`:

```tsx
sessionUser: Option.map(session, (value) => value.user).pipe(
  Option.getOrUndefined,
),
```

### Why this looks wrong

Unicorn's rule docs say it only targets array APIs that accept `thisArg`:

> The rule disallows using the `thisArg` argument in array methods

and then lists only:

- `Array.from()`
- `Array#map()`
- `Array#filter()`
- `Array#find()`
- related array methods

But our code is calling `Option.map(...)` from Effect, not `array.map(...)` and not `Array.from(..., mapFn, thisArg)`.

That strongly suggests an Oxlint false positive or incomplete rule matching.

### Likely conclusions

- app code is fine as written
- rule intent does not apply to `Option.map`
- this is probably tooling noise, not a real code smell

### Possible responses later

1. keep code, disable/suppress this rule if these are the only hits
2. rewrite to pipe style and see if it avoids the false positive
3. check newer Oxlint / file upstream bug if it persists

For now, this does not look like a real app bug.

---

## 5. `unicorn/prefer-string-replace-all`

My earlier note was wrong. `replaceAll()` does support regex, as long as the regex is global.

From MDN:

> The `pattern` can be a string or a `RegExp`

> If `pattern` is a regex, then it must have the global (`g`) flag set

MDN example:

```js
const regex = /dog/gi;
paragraph.replaceAll(regex, "ferret");
```

Unicorn also documents the preferred form explicitly:

```js
// bad
string.replace(/RegExp with global flag/igu, '');

// good
string.replaceAll(/RegExp with global flag/igu, '');
```

### Current app code

From `src/lib/Auth.ts:132`:

```tsx
slug: user.email.replace(/[^a-z0-9]/g, "-").toLowerCase(),
```

### Valid fix

```tsx
slug: user.email.replaceAll(/[^a-z0-9]/g, "-").toLowerCase(),
```

This one is a real, safe fix.

---

## 6. `unicorn/relative-url-style`

### Current code

From `vite.config.ts:16`:

```ts
"@": fileURLToPath(new URL("./src", import.meta.url)),
```

Unicorn docs:

> When using a relative URL in `new URL()`, the URL should either never or always use the `./` prefix consistently.

Default option:

> `'never'` (default) - Never use a `./` prefix.

### Behavioral check

I tested:

```js
new URL('./src', 'file:///tmp/project/vite.config.ts')
new URL('src', 'file:///tmp/project/vite.config.ts')
```

Both resolve to:

```txt
file:///tmp/project/src
```

### Conclusion

This looks safe to change later:

```ts
"@": fileURLToPath(new URL("src", import.meta.url)),
```

---

## 7. Straightforward Fixes We Should Make Later

These still look good after review.

### 7.1 Nested ternary

From `src/routes/admin.users.tsx:352`:

```tsx
setBanDialog((prev) =>
  prev.isOpen === isOpen
    ? prev
    : isOpen
      ? { ...prev, isOpen }
      : { isOpen: false, userId: undefined },
);
```

Fix direction: expand to block form with `if` returns.

### 7.2 Self-closing script

From `src/routes/__root.tsx:91`:

```tsx
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon={JSON.stringify({ token: analyticsToken })}
></script>
```

Fix direction:

```tsx
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon={JSON.stringify({ token: analyticsToken })}
/>
```

### 7.3 Numeric separators

From `src/lib/Domain.ts:153`:

```ts
monthlyPriceInCents: 10000,
annualPriceInCents: Math.round(10000 * 12 * 0.8),
```

Fix direction:

```ts
monthlyPriceInCents: 10_000,
annualPriceInCents: Math.round(10_000 * 12 * 0.8),
```

### 7.4 Switch case braces

From `src/worker.ts:185`:

```ts
switch (scheduledEvent.cron) {
  case "0 0 * * *":
    await runEffect(...)
```

Fix direction: wrap each case body in braces.

### 7.5 Catch error name

From `scripts/d1-reset.ts:61`:

```ts
} catch (p) {
  console.error(`Ignoring execption: ${String(p)}`);
}
```

Fix direction:

```ts
} catch (error) {
  console.error(`Ignoring execption: ${String(error)}`);
}
```

### 7.6 Array reverse

From `e2e/stripe.spec.ts:79`:

```ts
[planData, [...planData].reverse()]
```

Fix direction:

```ts
[planData, [...planData].toReversed()]
```

---

## 8. `no-autofocus`

Current code from `src/routes/admin.users.tsx:470`:

```tsx
<Input
  id={field.name}
  name={field.name}
  value={field.state.value}
  onBlur={field.handleBlur}
  onChange={(e) => {
    field.handleChange(e.target.value);
  }}
  autoFocus
  aria-invalid={isInvalid}
/>
```

This rule is usually right from an accessibility standpoint: automatic focus can unexpectedly move the user's cursor and screen-reader context.

Likely better fix direction later:

- rely on dialog focus management
- or use explicit controlled focus after open if truly necessary

This one looks worth fixing, not disabling.

---

## Recommended Next Pass

If we implement later, current recommended order:

1. update `.oxlintrc.json`
   - ignore the four external ui files
   - change `react/no-children-prop` to allow function children
2. fix real app-code issues
   - nested ternary
   - self-closing script
   - numeric separators
   - switch braces
   - catch param name
   - `toReversed()`
   - `replaceAll()`
   - remove `autoFocus`
3. handle semantic link/button issues in marketing routes
4. decide whether to suppress `unicorn/no-array-method-this-argument` as a false positive

---

## Current Decisions

- fix later: nested ternary
- fix later: self-closing script
- fix later: numeric separators
- fix later: switch case braces
- fix later: catch param rename
- fix later: `toReversed()`
- fix later: `replaceAll()`
- fix later: `no-autofocus`
- config later: ignore external shadcn/ui files
- config later: `react/no-children-prop` should use `allowFunctions: true`
- more judgment needed: Base UI link-via-Button patterns in app code
- likely false positive: `unicorn/no-array-method-this-argument` on `Option.map`
