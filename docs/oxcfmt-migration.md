# Oxfmt Migration: Prettier → Oxfmt

## What is Oxfmt?

Oxfmt (`/oʊ-ɛks-fɔːr-mæt/`) — Rust-powered, Prettier-compatible formatter from the [Oxc project](https://oxc.rs/docs/guide/usage/formatter.html). Beta as of 2026-02-24.

- **~30x faster** than Prettier, ~2-3x faster than Biome ([benchmarks](https://github.com/oxc-project/bench-formatter))
- 100% Prettier JS/TS conformance tests passing
- Package: `oxfmt` on npm

## Supported Languages

JS, JSX, TS, TSX, JSON, JSONC, JSON5, YAML, TOML, HTML, Angular, Vue, CSS, SCSS, Less, Markdown, MDX, GraphQL, Ember, Handlebars.

**Not supported:** SQL formatting (we forgo `prettier-plugin-sql`).

## Built-in Features (No Plugins Needed)

| Feature                | Prettier                              | Oxfmt                                      |
| ---------------------- | ------------------------------------- | ------------------------------------------ |
| Import sorting         | `@ianvs/prettier-plugin-sort-imports` | Built-in `sortImports`                     |
| Tailwind class sorting | `prettier-plugin-tailwindcss`         | Built-in `sortTailwindcss`                 |
| package.json sorting   | `prettier-plugin-sort-packagejson`    | Built-in `sortPackageJson` (on by default) |
| Embedded formatting    | N/A                                   | Built-in (CSS-in-JS, GraphQL)              |
| SQL formatting         | `prettier-plugin-sql`                 | ❌ Not supported                           |

## Key Config Differences

| Option            | Prettier default | Oxfmt default       |
| ----------------- | ---------------- | ------------------- |
| `printWidth`      | 80               | **100**             |
| `trailingComma`   | `"all"`          | `"all"`             |
| `sortImports`     | N/A (plugin)     | Disabled by default |
| `sortTailwindcss` | N/A (plugin)     | Disabled by default |
| `sortPackageJson` | N/A              | Enabled by default  |

## Config File

Oxfmt uses `.oxfmtrc.json` or `.oxfmtrc.jsonc`. Supports `$schema` for editor autocomplete.

### Migration Command

```bash
pnpm oxfmt --migrate prettier
```

Reads existing prettier config and generates `.oxfmtrc.json`.

### Ignore Files

Oxfmt reads `.gitignore` and `.prettierignore` by default. Can also use `ignorePatterns` in config. Our `.prettierignore` continues to work.

### Import Sorting Config

Uses [eslint-plugin-perfectionist/sort-imports](https://perfectionist.dev/rules/sort-imports) algorithm. Groups use selectors like `type-builtin`, `value-external`, `value-internal`, etc.

Key options:

- `groups`: Array of group names (combinable in sub-arrays)
- `customGroups`: Define custom groups with `groupName` + `elementNamePattern` (glob)
- `internalPattern`: Default `["~/", "@/"]` — matches our `@/*` path aliases
- `newlinesBetween`: Insert blank lines between groups (default: true)

### Tailwind CSS Sorting Config

Uses same algorithm as `prettier-plugin-tailwindcss`. Options:

- `stylesheet`: Path to Tailwind v4 stylesheet (default: installed `theme.css`)
- `functions`: Custom function names to sort (e.g., `["clsx", "cn", "cva", "tw"]`)
- `attributes`: Additional attributes beyond `class`/`className`

## Our Config (`.oxfmtrc.json`)

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 80,
  "sortImports": {
    "groups": [
      "type-builtin",
      "type-external",
      "type-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-builtin", "value-external"],
      "value-internal",
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
    "customGroups": [
      {
        "groupName": "react-libs",
        "elementNamePattern": ["react", "react-**"],
      },
    ],
  },
  "sortTailwindcss": {
    "stylesheet": "./src/styles.css",
    "functions": ["tw", "twMerge", "twJoin", "cva", "cn"],
  },
  "overrides": [
    {
      "files": ["*.jsonc"],
      "options": {
        "trailingComma": "none",
      },
    },
  ],
}
```

## Migration Steps

1. `pnpm add -D oxfmt`
2. `pnpm oxfmt --migrate prettier` → generates `.oxfmtrc.json`
3. Manually add `sortImports` and `sortTailwindcss` to config
4. Update `package.json` scripts: `format` → `oxfmt`, `format:check` → `oxfmt --check`
5. Run `pnpm format` to reformat everything
6. Remove prettier deps: `prettier`, `@ianvs/prettier-plugin-sort-imports`, `prettier-plugin-sql`, `prettier-plugin-tailwindcss`
7. Delete `prettier.config.js`
8. Update `.vscode/settings.json` for oxfmt editor extension
9. Add reformat commit SHA to `.git-blame-ignore-revs`

## Editor Setup (VS Code / Cursor)

Extension: [oxc.oxc-vscode](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode)

```json
{
  "oxc.fmt.configPath": ".oxfmtrc.json",
  "editor.defaultFormatter": "oxc.oxc-vscode",
  "editor.formatOnSave": true
}
```

## CLI Reference

```bash
oxfmt                      # Format cwd (equivalent to prettier --write .)
oxfmt --check              # Check formatting (exit 1 if unformatted)
oxfmt --list-different     # List files that would change
oxfmt --init               # Generate default .oxfmtrc.json
oxfmt --migrate prettier   # Migrate from prettier config
oxfmt -c path/to/config    # Use specific config
oxfmt --lsp                # Start LSP server (for editors)
```

## Links

- [Oxfmt docs](https://oxc.rs/docs/guide/usage/formatter.html)
- [Quickstart](https://oxc.rs/docs/guide/usage/formatter/quickstart.html)
- [Configuration](https://oxc.rs/docs/guide/usage/formatter/config.html)
- [Sorting (imports, tailwind, package.json)](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
- [Config file reference](https://oxc.rs/docs/guide/usage/formatter/config-file-reference)
- [Migrate from Prettier](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier)
- [CLI reference](https://oxc.rs/docs/guide/usage/formatter/cli.html)
- [Beta announcement](https://oxc.rs/blog/2026-02-24-oxfmt-beta)
- [Benchmarks](https://github.com/oxc-project/bench-formatter)
