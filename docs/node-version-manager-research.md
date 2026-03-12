# Node Version Manager Research

## Bottom Line

- Best overall default in 2026: `mise`
- Lowest hassle for Node-only teams: `fnm`
- Best package-manager pinning for a `pnpm` repo: commit `packageManager`, but do not make Corepack the default recommendation
- Do not standardize on `Volta` for a new project: its repo says `Volta is unmaintained.`
- Do not rely on `engines.node` alone: npm documents it as `advisory only` unless `engine-strict` is enabled

The earlier version of this research overstated Corepack. That was wrong.

Based on current Node, Corepack, and pnpm docs, Corepack is usable, but not a low-hassle or bullet-proof default in 2026.

## Updated Recommendation

### If the goal is least hassle

Use:

1. `fnm`
2. exact `.node-version`
3. `package.json#packageManager`
4. pnpm's own package-manager management, not Corepack by default

Why:

- `fnm` is fast, simple, and cross-platform
- exact `.node-version` keeps project-local Node pinning obvious
- `packageManager` pins pnpm version in repo metadata
- pnpm can now manage its own version from `packageManager`

### If the goal is most bullet-proof

Use:

1. `mise`
2. exact pinned Node in `mise.toml`
3. `package.json#packageManager`
4. pnpm's own package-manager management, not Corepack by default

Why:

- `mise` has the strongest current maintenance signal
- it gives real per-directory switching for `node`, not only inside package-manager commands
- it is cross-platform and future-proofs other tool pinning too
- it avoids depending on Corepack's bundling, shim, and update story

### Corepack position now

Use Corepack only if you explicitly want it and are willing to bootstrap and update it yourself.

Good framing:

- optional bridge
- not default standard
- not bullet-proof

## Why Corepack Is Not A Great Default Recommendation

### 1. Node 25 no longer ships it

Node 25 docs say:

> `Corepack will no longer be distributed starting with Node.js v25.`

And:

> `Users currently depending on the bundled corepack executable from Node.js can switch to using the userland-provided corepack module.`

That means `install Node` no longer implies `Corepack is there` on current Node.

This alone breaks the clean `just use what ships with Node` story.

### 2. It is still experimental

Node docs still mark Corepack:

> `Stability: 1 - Experimental`

pnpm docs also describe Corepack as:

> `an experimental feature`

That is hard to square with `bullet-proof default`.

### 3. pnpm docs tell users to update Corepack first

pnpm installation docs say:

> `Due to an issue with outdated signatures in Corepack, Corepack should be updated to its latest version first`

and then instruct:

```sh
npm install --global corepack@latest
```

If the first step to make the recommended tool reliable is `update the tool that was supposed to already work`, that is not low-hassle.

### 4. Recent real-world breakage: signature / key mismatch

Corepack issue `#612` is titled:

> `Newly published versions of package managers distributed from npm cannot be installed due to key id mismatch`

Corepack issue `#627` says current package-manager releases:

> `cannot be installed with the version of Corepack currently distributed with Node.js LTS versions without using workarounds`

This is exactly the kind of breakage a team wants to avoid in onboarding and CI.

### 5. Shims and filesystem caveats add friction

Corepack's README says `corepack enable` creates shims, and warns:

> `If the file system where the corepack binary is located is read-only, this command will fail`

The documented workaround is to use shell aliases or other manual setup.

Again: workable, not hassle-free.

### 6. Global install conflicts are part of the official story

Corepack's README says:

> `First uninstall your global Yarn and pnpm binaries`

It also notes Windows `.msi` cases may require extra removal steps.

And the README explicitly says:

> `We do acknowledge the irony and overhead of using npm to install Corepack`

That is a strong signal that the bootstrap path is not elegant.

### 7. Offline and CI workflows are possible, but not simple

Corepack supports offline/cache workflows, but the official flow involves extra commands like `corepack pack` and `corepack install -g --cache-only`.

That is useful for controlled environments, but not what most people mean by `less hassle`.

### 8. pnpm reduced Corepack's unique value

pnpm now documents this setting:

> `managePackageManagerVersions`

and says:

> `When enabled, pnpm will automatically download and run the version of pnpm specified in the packageManager field of package.json. This is the same field used by Corepack.`

So for a pnpm repo, Corepack is no longer the only practical way to make `packageManager` do real work.

pnpm also documents `useNodeVersion`:

> `pnpm will automatically install the specified version of Node.js and use it for running pnpm run commands or the pnpm node command.`

And `devEngines.runtime`:

> `Scripts use the local runtime, ensuring consistency across environments.`

This does not replace a true shell-level Node version manager like `mise` or `fnm`, but it does reduce Corepack's value in pnpm-centric repos.

## What To Use Instead

### For actual per-directory Node switching

Use a real Node version manager:

- `mise`
- `fnm`
- `asdf` if your team already uses it

These tools solve the real problem: when you `cd` into a project, `node` is the right version.

### For pnpm version pinning

Use:

```json
{
  "packageManager": "pnpm@10.0.0"
}
```

Then prefer pnpm's own package-manager handling over Corepack as the default policy for pnpm repos.

### For pnpm-managed runtime consistency

Useful in CI or script-driven environments:

`pnpm-workspace.yaml`

```yaml
useNodeVersion: 24.11.0
```

This is good for `pnpm run` and `pnpm node`, but it is not the same as making plain shell `node` switch automatically when entering a directory.

## Ranked Options

| Rank | Tool | Verdict | Why |
| --- | --- | --- | --- |
| 1 | `mise` | Best overall | active, cross-platform, exact project pinning, auto-switch, multi-tool future-proof |
| 2 | `fnm` | Best low-friction Node-only choice | fast, simple, cross-platform, low team friction |
| 3 | `asdf` | Solid if already adopted | mature, credible, multi-runtime, but more plugin/shim friction |
| 4 | `nvm` | Common, but weaker standardization choice | POSIX-first, more shell hassle, weak native Windows story |
| 5 | `Volta` | Not for new adoption | repo now says unmaintained |
| - | `Corepack` | Optional bridge, not default | experimental, no longer bundled in Node 25+, recent signature/update friction |

## Evidence By Tool

### `mise`

Official docs describe it as:

> `Like asdf (or nvm or pyenv) but for any language`

And:

> `mise can automatically switch between different versions of tools based on the directory you're in.`

And:

> `It's also compatible with asdf .tool-versions files as well as idiomatic version files like .node-version`

Why this matters:

- first-class project-local config
- real directory-based switching
- exact pinning is straightforward
- broad future-proofing beyond Node

Maintenance signal:

- active docs and releases
- even Volta now recommends migrating to `mise`

### `fnm`

The repo describes `fnm` as:

> `Fast and simple Node.js version manager, built in Rust`

And lists:

> `Cross-platform support (macOS, Windows, Linux)`

And:

> `Works with .node-version and .nvmrc files`

Shell integration is direct:

```sh
eval "$(fnm env --use-on-cd --shell zsh)"
```

Why this matters:

- tiny learning curve
- easy mixed-OS adoption
- exact `.node-version` is enough for reliable project-local Node pinning

Main caveat:

- still shell-hook based, so slightly less complete and extensible than `mise`

### `asdf`

`asdf` remains credible because `.tool-versions` is stable and well-known, and version lookup is automatic at execution time.

Main caveats:

- more plugin and shim moving parts than `mise`
- rougher Node ergonomics than `fnm`
- more operational friction for teams that only care about Node

### `nvm`

The official repo says:

> `nvm works on any POSIX-compliant shell`

And for Windows:

> `Otherwise, for Windows, a few alternatives exist, which are neither supported nor developed by us`

Auto-switching with `.nvmrc` is documented mostly through contributed shell recipes.

Why it falls behind:

- not a real native Windows standard
- function-based shell setup is more fragile
- more shell/profile edge cases than newer Rust-based tools

### `Volta`

Volta's repo banner says:

> `Volta is unmaintained.`

And:

> `We recommend migrating to mise.`

So even though Volta's UX was historically excellent, it is no longer a good new standard.

## What Does Not Solve This Alone

### `.nvmrc`

Useful file format. Not a manager.

Use it with something like `fnm`, `nvm`, or `mise` compatibility.

For reliability, pin exact versions:

```txt
24.11.0
```

Avoid drifting specs like:

```txt
24
lts/*
node
```

### `engines.node`

npm docs say:

> `this field is advisory only`

unless `engine-strict` is enabled.

So `engines.node` is a guardrail, not a switcher.

### `packageManager`

Important, but it pins the package manager version, not Node.

Keep it, but do not confuse it with project-local Node switching.

## Best Standard For This Repo

This repo is a `pnpm` repo and currently has no `packageManager` field in `package.json`.

### Option A: simplest standard

Use `fnm` + exact `.node-version` + `packageManager`.

`.node-version`

```txt
24.11.0
```

`package.json`

```json
{
  "packageManager": "pnpm@10.0.0"
}
```

Why:

- easiest onboarding
- least ceremony
- cross-platform enough for most teams

### Option B: strongest long-term standard

Use `mise` + exact `mise.toml` + `packageManager`.

`mise.toml`

```toml
[tools]
node = "24.11.0"
```

`package.json`

```json
{
  "packageManager": "pnpm@10.0.0"
}
```

Why:

- strongest long-term maintenance story
- better if this repo later pins more than Node
- avoids dependence on Corepack as a bootstrap layer

### Optional pnpm runtime layer

If wanted for scripts and CI, add to `pnpm-workspace.yaml`:

```yaml
useNodeVersion: 24.11.0
```

That improves runtime consistency for pnpm commands, but it does not replace `mise` or `fnm` for normal shell usage.

## Final Call

If optimizing for less hassle only, pick `fnm`.

If optimizing for well-maintained and bullet-proof, pick `mise`.

If forced to choose one team standard in 2026, choose `mise`.

For this repo, the best default package-manager policy is:

- pin `packageManager`
- do not make Corepack mandatory
- let pnpm manage pnpm, and let `mise` or `fnm` manage Node

## Sources

- Node Corepack docs: <https://nodejs.org/docs/latest-v25.x/api/corepack.html>
- Corepack README: <https://github.com/nodejs/corepack/blob/main/README.md>
- Corepack releases: <https://github.com/nodejs/corepack/releases>
- Corepack issue `#612`: <https://github.com/nodejs/corepack/issues/612>
- Corepack issue `#627`: <https://github.com/nodejs/corepack/issues/627>
- Node unbundling discussion: <https://github.com/nodejs/node/pull/57617>
- pnpm installation docs: <https://pnpm.io/installation>
- pnpm settings docs: <https://pnpm.io/settings>
- pnpm package.json docs: <https://pnpm.io/package_json>
- pnpm self-update docs: <https://pnpm.io/cli/self-update>
- pnpm env docs: <https://pnpm.io/cli/env>
- npm `package.json` docs: <https://docs.npmjs.com/cli/v11/configuring-npm/package-json>
- npm `engine-strict`: <https://docs.npmjs.com/cli/v11/using-npm/config#engine-strict>
- `mise` docs: <https://mise.jdx.dev/dev-tools/>
- `mise use`: <https://mise.jdx.dev/cli/use.html>
- `mise` repo: <https://github.com/jdx/mise>
- `fnm` repo/docs: <https://github.com/Schniz/fnm>
- `fnm` site: <https://fnm.vercel.app>
- `asdf` docs: <https://asdf-vm.com/guide/getting-started.html>
- `asdf` node plugin: <https://github.com/asdf-vm/asdf-nodejs>
- `nvm` repo/docs: <https://github.com/nvm-sh/nvm>
- Volta docs: <https://docs.volta.sh/guide/understanding>
- Volta repo status: <https://github.com/volta-cli/volta>
