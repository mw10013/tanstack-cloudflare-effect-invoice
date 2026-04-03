# Vitest Browser Mode with Playwright Research

## Installation

### Automated

```bash
pnpm vitest init browser
```

This installs dependencies and creates browser config.

### Manual

```bash
pnpm add -D vitest @vitest/browser-playwright
```

## Configuration

```ts
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    browser: {
      provider: playwright(),
      enabled: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})
```

## Recommended Settings

- Use `playwright` provider (not `preview`) for real browser events via CDP
- Prefer `headless: true` for CI:

```ts
browser: {
  provider: playwright(),
  enabled: true,
  headless: true,
}
```

## Framework Plugins Required

For TanStack Start / React, include the framework plugin:

```ts
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
```

## Running Tests

```bash
pnpm vitest --browser=chromium
```

Or with headless:

```bash
pnpm vitest --browser.headless
```

## Key API

```ts
import { page, userEvent } from 'vitest/browser'

test('fills form', async () => {
  await page.getByLabel(/email/i).fill('u@u.com')
  await page.getByRole('button', { name: /submit/i }).click()
})
```

## Integration with Cloudflare Worker

Browser Mode runs tests in Vitest's iframe at port 63315. To route server-fn calls through a Cloudflare Worker fetch handler, the fetch override approach from `login-integration-test-research.md` applies:

```ts
const workerFetch: CustomFetch = (url, init) =>
  exports.default.fetch(new Request(new URL(url, 'http://example.com'), init))

await login({ data: { email: 'u@u.com' }, fetch: workerFetch })
```

This requires the test to import the client-compiled server fn (Browser Mode is more likely to provide this than Node-based tests).
