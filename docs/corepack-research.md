# Package Manager Version Locking Research

## What Is It

Corepack is a zero-runtime-dependency Node.js script that acts as a bridge between Node.js projects and the package managers (yarn, pnpm, npm) they use. It ships with Node.js 14.19 through 24.x as an **experimental** feature. In practical terms, it lets you use yarn, pnpm, and npm without installing them globally — Corepack intercepts calls to these binaries, downloads the correct version, caches it, and runs it transparently.

## Problem It Solves

Package manager version drift across developers, CI, and environments:

- "Works on my machine" bugs caused by different pnpm/yarn versions
- Lockfile format mismatches when different versions resolve dependencies differently
- New contributors needing to manually install the exact right package manager version
- No enforcement mechanism to prevent using the wrong package manager entirely

Corepack ensures **everyone uses the exact same package manager version**, automatically.

## Per-Project Versioning (Directory-Specific)

Yes — Corepack pins a specific package manager + version **per project** via the `packageManager` field in `package.json`:

```json
{
  "packageManager": "pnpm@9.15.4"
}
```

### How it works

1. Run `corepack enable` to activate shims
2. Set the `packageManager` field in your project's `package.json`
3. When you run `pnpm install` (or `yarn`), Corepack intercepts the call
4. It reads the nearest `package.json` with a `packageManager` field (walks up the directory tree)
5. Downloads + caches the exact version if needed, then runs it

### Key behaviors

- **Correct manager + version configured**: silently downloads/caches and uses it
- **Wrong manager** (e.g., running `yarn` in a pnpm project): **errors out**, preventing lockfile corruption
- **No `packageManager` field**: falls back to "Known Good Releases" (bundled defaults)

### Monorepos

Only the root `package.json` needs the `packageManager` field. Corepack walks up the directory tree to find it.

### Alternative: `devEngines.packageManager`

```json
{
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "9.15.4",
      "onFail": "error"
    }
  }
}
```

### Useful commands

```bash
corepack enable              # activate shims
corepack use pnpm@9.15.4    # set packageManager in package.json + install
corepack up                  # update to latest patch/minor on current major
corepack install             # download the configured version for offline use
```

## npm Support

Corepack supports npm in the `packageManager` field, but **npm shims are not installed by default** (since npm already ships with Node.js). You must explicitly request npm shims via `corepack enable npm`.

## Who Maintains It

- Lives under the **nodejs** GitHub org: [github.com/nodejs/corepack](https://github.com/nodejs/corepack)
- Originally developed primarily by **Maël Nison** (arcanis), the Yarn maintainer
- 51 contributors, 3.5k stars, 245 forks
- MIT licensed
- Latest release: **v0.34.6** (Jan 23, 2026), 54 total releases

## Maintenance Status & Future

### Active but being removed from Node.js

- **Node.js TSC voted (March 2025) to stop distributing Corepack** with Node.js 25+
- Remains bundled in Node.js 24 LTS and earlier
- **Not deprecated** — will continue to be maintained at least through Node.js 24.x EOL
- After Node.js 25+, install separately: `npm install -g corepack`

### Reasons for removal from Node.js distribution

1. **Low adoption**: many devs unaware of it or bypassed it
2. **Distribution concerns**: bundling a package-manager-manager in the runtime seen as unnecessary
3. **Independence**: package managers should evolve independently of Node.js releases
4. **Political tension**: debate around npm's bundled status vs. other package managers

### Community sentiment: mixed

- **Supporters**: "Forcing people to use npm to install the package manager they actually want is a step backwards"
- **Detractors**: package managers can manage their own versioning (pnpm added self-management in v9.7.0)

## Verdict: Not Viable Long-Term

- Being removed from Node.js 25+ (never left experimental)
- Requires `corepack enable` on every machine/CI — easy to forget
- Uncertain maintenance future after Node.js 24 EOL
- The ecosystem is moving away from it

---

# Volta

## Status: Archived / Unmaintained

As of Nov 2025, Volta is **unmaintained**. The maintainers [officially recommend migrating to `mise`](https://github.com/volta-cli/volta/issues/2080). Key issues:

- No active development
- pnpm support was always experimental with outstanding bugs
- Conflicts with Corepack

## Verdict: Not Viable

Archived. Do not adopt.

---

# mise (mise-en-place)

[mise.jdx.dev](https://mise.jdx.dev/) — a polyglot toolchain manager (Rust-based rewrite of asdf). Manages Node.js, pnpm, Bun, Deno, Ruby, Python, and hundreds more via plugins.

## How it works

- Config via `.mise.toml` or `.tool-versions` per project
- Manages Node.js versions + can use Corepack for pnpm/yarn
- Also has a native pnpm plugin (asdf-pnpm)
- No shims — activates tools via shell hook (`mise activate`)
- ~4ms shell startup overhead

## Assessment

| Aspect | Status |
|---|---|
| Manages pnpm versions | ✅ Via Corepack or native plugin |
| Per-project pinning | ✅ `.mise.toml` |
| Active development | ✅ Very active |
| Complexity | ⚠️ Heavy for pnpm-only use case |
| Manages Node.js too | ✅ Replaces nvm/fnm |

## Verdict: Viable but Heavy

If you only use pnpm and already have a Node.js version manager, mise is overkill. Better suited if you manage multiple runtimes/tools.

---

# pnpm Self-Management (Recommended)

## What Is It

Since **pnpm v9.0.0**, pnpm natively reads the `packageManager` field from `package.json` — the same field Corepack uses — and enforces it **without Corepack**. Since **pnpm v10**, the `managePackageManagerVersions` setting is **on by default**, meaning pnpm will **automatically download and run the correct version** specified in `packageManager` — no manual version switching needed.

## How It Works

### 1. Set `packageManager` in `package.json`

```json
{
  "packageManager": "pnpm@10.6.5"
}
```

### 2. pnpm auto-switches versions (pnpm 10+)

Three settings control behavior (in `pnpm-workspace.yaml`):

| Setting | Default (v10) | Behavior |
|---|---|---|
| `managePackageManagerVersions` | **`true`** | **Auto-downloads and runs the version in `packageManager`**. This is the killer feature — you just need *any* pnpm 10+ installed, and it delegates to the correct version automatically. |
| `packageManagerStrict` | `true` | Errors if a **different package manager** (e.g., npm, yarn) is used. Only checks name, not version (since v9.2.0). |
| `packageManagerStrictVersion` | `false` | When `true`, errors if pnpm version doesn't exactly match (redundant if `managePackageManagerVersions` is on). |

### 3. Multi-project scenario (different pnpm versions)

With `managePackageManagerVersions: true` (default in v10), **switching between projects with different pnpm versions just works**:

```
~/project-a/  →  "packageManager": "pnpm@9.15.4"
~/project-b/  →  "packageManager": "pnpm@10.6.5"
```

You have pnpm 10.x installed globally. When you `cd project-a && pnpm install`, pnpm 10 reads `packageManager`, downloads pnpm 9.15.4, and runs it. When you `cd project-b && pnpm install`, it uses 10.6.5. **No manual switching, no external tools.**

> **Note**: This requires the globally installed pnpm to be v10+ (when `managePackageManagerVersions` became default true). For pnpm v9, you'd need to set `manage-package-manager-versions=true` in `~/.npmrc`.

### 4. Update pnpm itself

```bash
pnpm self-update          # update to latest
pnpm self-update 10       # update to latest v10.x
pnpm self-update 10.6.5   # update to exact version
```

Then update `packageManager` in `package.json` to match.

## Workflow

```bash
# Initial setup: pin pnpm version in package.json
# "packageManager": "pnpm@10.6.5"

# That's it. managePackageManagerVersions is true by default in pnpm 10.
# Any developer with pnpm 10+ installed globally will auto-use the right version.

# To upgrade pnpm across the project:
pnpm self-update 10.7.0
# Update package.json: "packageManager": "pnpm@10.7.0"
# Commit
```

## CI Integration

The `pnpm/action-setup` action can **automatically read `packageManager` from `package.json`** — just omit the `version` field:

```yaml
- uses: pnpm/action-setup@v4
  # reads version from package.json packageManager field automatically
```

## Node.js Version Management (Bonus)

pnpm can also manage Node.js versions per-project via `useNodeVersion` in `pnpm-workspace.yaml`:

```yaml
useNodeVersion: 22.0.0
```

This replaces `.nvmrc` / nvm for projects using pnpm.

## Effectiveness Assessment

| Aspect | Status |
|---|---|
| Locks pnpm version per project | ✅ Via `packageManager` field |
| Auto-switches between projects | ✅ Via `managePackageManagerVersions` (default true in v10) |
| Prevents wrong package manager | ✅ Via `packageManagerStrict` (default true) |
| No external tools needed | ✅ Built into pnpm itself |
| Works without Corepack | ✅ Since pnpm v9.0.0 |
| Self-update mechanism | ✅ `pnpm self-update` |
| CI support | ✅ `pnpm/action-setup` reads `packageManager` |
| Node.js version management | ✅ Via `useNodeVersion` setting |
| Long-term viability | ✅ Core pnpm feature, actively maintained |
| Complexity | ✅ Minimal — just `packageManager` in `package.json` |

## Verdict: Best Option for pnpm-Only Projects

pnpm self-management is the simplest, most reliable approach:

1. Zero external dependencies (no Corepack, no mise, no volta)
2. **Auto-downloads the correct pnpm version per project** — seamless multi-project support
3. Uses the standard `packageManager` field (compatible with Corepack if anyone else uses it)
4. Built-in to pnpm — won't be removed or deprecated
5. Also handles Node.js versioning via `useNodeVersion`
6. CI-friendly via `pnpm/action-setup`

---

# proto (moonrepo)

[moonrepo.dev/proto](https://moonrepo.dev/proto) — a Rust-based pluggable multi-language version manager. Lighter than mise, focused specifically on toolchain management.

## How it works

- Config via `.prototools` per project
- Supports Node.js, pnpm, npm, yarn, Bun, Deno, Go, Python, Rust, and 800+ via plugins
- Contextual version detection from language ecosystems (reads `packageManager` from `package.json`)
- Checksum verification on downloads
- Cross-platform (Linux, macOS, WSL, Windows)

```
# .prototools
node = "22.0.0"
pnpm = "10.6.5"
```

```bash
proto use          # install all pinned tools
proto install pnpm # install pinned pnpm
```

## Assessment

| Aspect | Status |
|---|---|
| Manages pnpm versions | ✅ Native support |
| Per-project pinning | ✅ `.prototools` |
| Active development | ✅ 226 releases, actively maintained |
| Complexity | ⚠️ Additional tool, but lighter than mise |
| Also manages Node.js | ✅ |
| Stars | 1.2k (smaller community than mise) |

## Verdict: Viable Alternative

Lighter than mise, more focused. Good option if you want a dedicated toolchain manager that handles both Node.js and pnpm. But pnpm's built-in `managePackageManagerVersions` makes this unnecessary for pnpm-only use cases.

---

# Summary

| Tool | Status | Viable? |
|---|---|---|
| **Corepack** | Removed from Node.js 25+, uncertain future | ❌ |
| **Volta** | Archived, unmaintained | ❌ |
| **mise** | Active, but heavy for pnpm-only | ⚠️ Overkill |
| **pnpm self-management** | Built-in, actively maintained | ✅ Recommended |

**Recommendation**: Use `packageManager` field in `package.json` + `packageManagerStrictVersion: true` in `pnpm-workspace.yaml`. No external tooling needed.
