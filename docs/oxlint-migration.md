# Migrating from ESLint to Oxlint

> Source: https://oxc.rs/docs/guide/usage/linter.html  
> Date: 2026-03-11

## Why

- 50-100x faster than ESLint (Rust-based)
- 696 built-in rules covering ESLint core, typescript-eslint, react, react-hooks, unicorn, import, jsx-a11y, jest, vitest
- Type-aware linting via `tsgolint` (uses TypeScript 7 / tsgo)
- Multi-file analysis (e.g. `import/no-cycle` without perf cliff)
- JS Plugins (experimental) for ESLint plugins not natively supported

## Current ESLint Setup

```js
// eslint.config.js
- @eslint/js (recommended)
- typescript-eslint (strictTypeChecked, stylisticTypeChecked)
- @tanstack/eslint-plugin-router (flat/recommended)
- @tanstack/eslint-plugin-query (flat/recommended)
- eslint-plugin-react (recommended + jsx-runtime)
- eslint-plugin-react-hooks (recommended)
```

Custom rules:
- `no-unused-vars`: off (uses `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: "^_"`)
- `@typescript-eslint/prefer-string-starts-ends-with`: `allowSingleElementEquality: "always"`
- `@typescript-eslint/prefer-regexp-exec`: off

## Oxlint Native Plugin Coverage

| ESLint Plugin | Oxlint Native Plugin | Default On |
|---|---|---|
| `@eslint/js` | `eslint` | ✅ |
| `typescript-eslint` | `typescript` | ✅ |
| `eslint-plugin-react` + `react-hooks` | `react` | ❌ (enable) |
| `eslint-plugin-unicorn` | `unicorn` | ✅ |
| `eslint-plugin-import` | `import` | ❌ |
| `eslint-plugin-jsx-a11y` | `jsx-a11y` | ❌ |
| `@tanstack/eslint-plugin-router` | ❌ (JS Plugin) | — |
| `@tanstack/eslint-plugin-query` | ❌ (JS Plugin) | — |

## Migration Steps

### 1. Install oxlint

```bash
pnpm add -D oxlint
```

### 2. Run the migration tool

```bash
npx @oxlint/migrate --type-aware
```

This reads `eslint.config.js` and generates `.oxlintrc.json` with:
- Converted rules + severities
- File/path-specific overrides
- `globals`/`env` conversions
- Ignore patterns
- TanStack plugins as JS Plugins (via `jsPlugins`)

Flags:
| Flag | Description |
|---|---|
| `--type-aware` | Include type-aware rules, enables `options.typeAware` |
| `--js-plugins` | Migrate unsupported ESLint plugins as JS Plugins (default: true) |
| `--merge` | Merge with existing `.oxlintrc.json` |
| `--details` | List rules that could not be migrated |
| `--replace-eslint-comments` | Replace `// eslint-disable` comments with `// oxlint-disable` |
| `--with-nursery` | Include rules under development |

### 3. Install type-aware linting dependency

```bash
pnpm add -D oxlint-tsgolint@latest
```

Required for type-aware rules like `typescript/no-floating-promises`, `typescript/no-unsafe-assignment`.
Uses `typescript-go` (TypeScript 7) under the hood.

### 4. Enable react plugin

In `.oxlintrc.json`, ensure `react` is in the `plugins` array. Setting `plugins` **overwrites defaults**, so include everything:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "react"],
  "options": {
    "typeAware": true
  },
  "settings": {
    "react": {
      "linkComponents": [{ "name": "Link", "linkAttribute": "to" }]
    }
  }
}
```

The `react` plugin covers both `eslint-plugin-react` and `eslint-plugin-react-hooks` rules natively.

### 5. Update package.json scripts

```json
{
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix"
  }
}
```

Or, if running both during incremental migration:
```json
{
  "scripts": {
    "lint": "oxlint && eslint ."
  }
}
```

Use [`eslint-plugin-oxlint`](https://npmx.dev/package/eslint-plugin-oxlint) to disable overlapping ESLint rules during dual-run.

### 6. Replace eslint inline comments (optional)

```bash
npx @oxlint/migrate --replace-eslint-comments
```

Converts `// eslint-disable-next-line ...` → `// oxlint-disable-next-line ...`

## VSCode Integration

### Extension

Install [oxc.oxc-vscode](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) (130k+ installs).

Features:
- Inline diagnostics (warnings/errors)
- Quick fixes
- JSON schema validation for `.oxlintrc.json`
- Fix-on-save via `source.fixAll.oxc`
- Type-aware linting support
- Multi-root workspace support

### .vscode/extensions.json

```json
{
  "recommendations": ["oxc.oxc-vscode"]
}
```

### .vscode/settings.json

```json
{
  "editor.codeActionsOnSave": {
    "source.fixAll.oxc": "always"
  },
  "oxc.typeAware": true
}
```

Already have `oxc.oxc-vscode` as default formatter (for oxfmt). Linter features activate automatically when oxlint is installed.

### Extension Settings Reference

| Setting | Default | Description |
|---|---|---|
| `oxc.enable` | `null` | Enable/disable extension |
| `oxc.enable.oxlint` | `true` | Enable linter |
| `oxc.configPath` | `null` | Custom config path |
| `oxc.lint.run` | `onType` | `onSave` or `onType` |
| `oxc.typeAware` | `null` | Enable type-aware linting |
| `oxc.fixKind` | `safe_fix` | `safe_fix`, `safe_fix_or_suggestion`, `dangerous_fix`, `all`, `none` |
| `oxc.requireConfig` | `false` | Require config file to lint |
| `oxc.unusedDisableDirectives` | `null` | `allow`, `warn` |
| `oxc.disableNestedConfig` | `false` | Disable nested config lookup |

## Configuration Format

`.oxlintrc.json` (supports comments like jsonc).

### Idiomatic Approach: Categories over Manual Rules

Oxlint groups rules into **categories**. Use categories to bulk-enable rules instead of listing them individually:

| Category | Description | Recommended |
|---|---|---|
| `correctness` | Definitely wrong or useless code | `"error"` |
| `suspicious` | Likely wrong or useless | `"warn"` |
| `pedantic` | Stricter rules, occasional false positives | `"warn"` |
| `style` | Idiomatic and consistent code style | `"warn"` |
| `perf` | Runtime performance | off (opt-in) |
| `restriction` | Bans specific patterns — **must not be bulk-enabled**, case-by-case only | individual rules |
| `nursery` | Under development, may change | off |

Categories apply across **all loaded plugins**. So enabling `"correctness": "error"` activates correctness rules from eslint, typescript, react, jsx-a11y, unicorn, etc.

Only use explicit `rules` entries for:
- Rules with **custom options** (e.g., `no-unused-vars` with ignore patterns)
- **Restriction** category rules (must be individually enabled)
- **Overrides** to turn off noisy/inapplicable rules

### Rules to Turn Off for This Project

These style/pedantic rules conflict with project patterns (Effect v4 generators, TanStack Start async handlers, React JSX patterns):

- `react-in-jsx-scope` — React 17+ JSX transform
- `no-ternary`, `no-nested-ternary` — ternaries are idiomatic in JSX
- `sort-keys`, `sort-imports` — oxfmt handles import sorting
- `func-names` — Effect `function*` generators
- `func-style` — function declarations are used
- `new-cap` — Effect/Schema use PascalCase functions
- `require-await` — TanStack Start needs async handlers without await
- `strict-boolean-expressions` — too strict for typical TS patterns
- `capitalized-comments`, `no-inline-comments` — comment style not enforced
- `max-*` rules — too strict for component files
- Various unicorn rules (`filename-case`, `no-null`, `prefer-global-this`)

### linkComponents Setting

The `settings.react.linkComponents` setting tells rules like `no-unsafe-target-blank` and `jsx-a11y` rules that `<Link>` is a link element (alternative to `<a>`). The schema requires `attribute` (not `linkAttribute` despite misleading docs):

```json
"linkComponents": [{ "name": "Link", "attribute": "to" }]
```

### Import Plugin

The `import` plugin is **not** about import ordering (oxfmt handles that). It provides multi-file analysis rules:
- `import/no-cycle` — circular dependencies
- `import/no-self-import` — file importing itself
- `import/named` — verifies named imports exist
- `import/default` — verifies default imports
- `import/namespace` — validates namespace imports
- `import/no-duplicates` — merges duplicate imports

Not enabled by default because it requires building a module graph (perf cost). The `jsx-a11y` plugin is also not default because it's framework-specific.

## React Rules

The `react` plugin provides native Rust implementations of:
- `eslint-plugin-react` rules (recommended)
- `eslint-plugin-react-hooks` rules (hooks/rules-of-hooks, hooks/exhaustive-deps)

Enable:
```json
{ "plugins": ["react"] }
```

Additional react plugin: `react-perf` (from `eslint-plugin-react-perf`).

## Type-Aware Linting

Supports 59/61 type-aware rules from typescript-eslint. Requires:
1. `oxlint-tsgolint` package installed
2. `options.typeAware: true` in config or `--type-aware` CLI flag

Can also replace `tsc --noEmit` in CI:
```bash
oxlint --type-aware --type-check
```

## Packages to Remove After Full Migration

```bash
pnpm remove @eslint/js eslint eslint-plugin-react eslint-plugin-react-hooks typescript-eslint
```

Keep TanStack plugins if using as JS Plugins.

Delete `eslint.config.js`.

## Caveats

- **JS Plugins are experimental**: most ESLint v9 plugins work, but not 100% API coverage yet. Custom parsers not supported.
- **JS Plugin rules have no categories**: oxlint's category system (`correctness`, `suspicious`, etc.) only applies to native built-in plugins. JS plugin rules (e.g., TanStack router/query) must be individually configured with explicit severity in `rules` — they won't be picked up by `categories`.
- **Type-aware linting**: uses `typescript-go` (TS7). Some legacy tsconfig options may not be supported. See [TS migration guide](https://github.com/microsoft/TypeScript/issues/62508).
- **`plugins` array overwrites defaults**: must list all desired plugins explicitly.
- **`settings` not supported in overrides**: only at root level.
- **`eslint-plugin-oxlint`**: use during incremental migration to disable overlapping rules in ESLint.

## Links

- [Oxlint docs](https://oxc.rs/docs/guide/usage/linter.html)
- [Migration guide](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.html)
- [Config reference](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Rules reference](https://oxc.rs/docs/guide/usage/linter/rules.html)
- [Built-in plugins](https://oxc.rs/docs/guide/usage/linter/plugins.html)
- [JS Plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
- [Type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [Editor setup](https://oxc.rs/docs/guide/usage/linter/editors.html)
- [@oxlint/migrate](https://github.com/oxc-project/oxlint-migrate)
- [VSCode extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode)
- [Rule implementation status](https://github.com/oxc-project/oxc/issues/481)
