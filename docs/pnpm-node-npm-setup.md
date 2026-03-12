# pnpm, Node Versions, and npm Prefix Setup

## Overview

This document explains how pnpm manages Node versions, how Node ships with npm, and how to properly configure npm's prefix for global installations that don't break when switching Node versions.

## How Node Ships with npm

- **Node includes npm**: Every Node.js installation includes npm by default
- **No standalone npm installation**: npm is bundled with Node - you don't install npm separately

When you install Node (via pnpm env, nvm, or directly), you get:
- The Node runtime (`node`)
- npm CLI (`npm`)

## pnpm as a Version Manager

### Installing pnpm

**Important**: Do not rely on corepack for pnpm installation. Corepack will be removed from Node.js starting with v25 (see [Node.js corepack removal](https://github.com/nodejs/node/issues/51931)). Instead, install pnpm standalone using the official installer script:

```bash
# Standalone script - installs to ~/.local/share/pnpm
curl -f https://get.pnpm.io | sh -
```

This is the recommended approach because it doesn't depend on npm/Node and works regardless of your current setup.

### Using pnpm env to Manage Node Versions

pnpm has built-in Node version management via `pnpm env`:

```bash
# Install and use a specific Node version
pnpm env use --global 20
pnpm env use --global lts
pnpm env use --global latest
pnpm env use --global 22.10.0

# List installed Node versions
pnpm env list --global

# List available remote versions
pnpm env list --remote

# Remove a Node version
pnpm env remove --global 18.20.0
```

When you run `pnpm env use --global <version>`:
1. pnpm downloads and installs the requested Node version
2. It creates a symlink at `$PNPM_HOME/node` pointing to the new version
3. The Node version is stored in `~/Library/pnpm/nodejs/<version>/`

## packageManager Field in package.json

You can pin the pnpm version in your project's `package.json` using the `packageManager` field:

```json
{
  "packageManager": "pnpm@9.3.0"
}
```

When someone runs `pnpm install`, pnpm will auto-download and use that version.

**Note**: The format must match:
```
(npm|pnpm|yarn)@\d+\.\d+\.\d+(-.+)?
```

For example:
- `"pnpm@9.3.0"` ✓
- `"pnpm@9"` ✗ (must be full semver)
- `"pnpm@^9.3.0"` ✗

### pnpm Settings Related to packageManager

These settings control how pnpm handles the `packageManager` field. Set in `pnpm-workspace.yaml` or via `pnpm config`:

| Setting | Default | Description |
|---------|---------|-------------|
| `managePackageManagerVersions` | `true` | Auto-download pnpm version from `packageManager` field |
| `packageManagerStrict` | `true` | Fail if a different package manager is specified in `packageManager` |
| `packageManagerStrictVersion` | `false` | Require exact version match (not just package name) |

If you disable `managePackageManagerVersions`, pnpm won't automatically download the version specified in `packageManager`.

**Warning**: corepack (which also reads `packageManager`) is being removed from Node.js v25. However, pnpm has its own implementation of `packageManager` handling via `managePackageManagerVersions`, so this field still works as long as you have pnpm installed via the standalone script.

## The npm Prefix Problem

### The Issue

When using pnpm to manage Node versions, each Node version has its own npm installation. By default:

- npm's `prefix` defaults to wherever Node is installed
- When you switch Node versions with `pnpm env use`, the Node location changes
- This means global packages installed with `npm -g` go to different directories

Example:
- Node 20: `npm -g install codex` → `/Users/mw/Library/pnpm/nodejs/20.x.x/bin/codex`
- Node 22: `npm -g install codex` → `/Users/mw/Library/pnpm/nodejs/22.x.x/bin/codex`

### The Solution: Set npm prefix Once

Set `prefix` in npm's config to a fixed location that doesn't change when Node versions change:

```bash
npm config set prefix ~/.local
```

This writes to `~/.npmrc` and persists across Node version changes.

**What prefix controls** (from npm docs):
- Global packages: `{prefix}/lib/node_modules`
- Binaries: `{prefix}/bin`
- Man pages: `{prefix}/share/man`

**Recommended value**: `~/.local`
- Already in most shells' PATH
- Version-agnostic - stays the same regardless of which Node version is active
- Used by many tools (Claude Code, Amp, etc.)

### Verifying the Setting

```bash
# Check current prefix
npm config get prefix

# Check where global binaries will go
npm bin -g
```

## Configuration Files

### npm Configuration

- **User config**: `~/.npmrc` - where `npm config set prefix ~/.local` writes to
- **Project config**: `./.npmrc`
- **Global config**: `$PREFIX/etc/npmrc`

### pnpm Configuration

- **Global config** (macOS): `~/Library/Preferences/pnpm/rc`
- **Project config**: `pnpm-workspace.yaml`
- **pnpm-specific setting for bins**: `global-bin-dir`

To set pnpm's global bin directory:
```bash
pnpm config set --global global-bin-dir ~/.local/bin
```

### Key Environment Variables

- `PNPM_HOME`: pnpm's home directory (default: `~/Library/pnpm` on macOS)
- Controls where pnpm stores Node versions and global packages
- When using `pnpm env use`, Node versions go here

## Summary: One-Time Setup

```bash
# 1. Set npm prefix (persists across Node version changes)
npm config set prefix ~/.local

# 2. Optional: Set pnpm's global-bin-dir to match
pnpm config set --global global-bin-dir ~/.local/bin

# 3. Add to PATH if not already there
# ~/.local/bin should already be in PATH on most systems

# 4. Now install global tools
npm i -g @openai/codex
# Binary will be at ~/.local/bin/codex - works regardless of which Node version is active
```

## References

- npm config: https://docs.npmjs.com/cli/v11/using-npm/config
- npm folders: https://docs.npmjs.com/cli/v11/configuring-npm/folders
- pnpm config: https://pnpm.io/cli/config
- pnpm env: https://pnpm.io/cli/env
- pnpm settings: https://pnpm.io/settings
