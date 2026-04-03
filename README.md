# sloppydisk

`sloppydisk` is a small contract-preserving reset patcher for `@openai/codex`.

It replaces summary-style compaction with a reset path that preserves the latest user steer, writes exact recent user directives plus raw history snapshots to disk, and avoids reinjecting synthetic summaries back into the live context window.

## What It Does

- auto-compaction resets live history instead of summarizing it
- `/compact` follows the same reset flow
- continuity is written under `~/.codex/sloppydisk/threads/<thread-id>`
- recent hard user directives are kept verbatim in a lightweight `contract.md`
- raw reset segments are exported as JSON snapshots for deeper recovery
- install applies a binary delta against the stock Codex vendor binary with no config mutation
- uninstall restores the original binary from backup when available, or repairs Codex from the official npm package if it is not

## Install

Codex must already be installed:

```bash
npm install -g @openai/codex
npm install -g sloppydisk
```

Package install patches Codex automatically. Global npm uninstall does not reliably fire package uninstall hooks on modern npm, so sloppydisk also installs a tiny Codex entrypoint guard that restores stock Codex the next time `codex` is invoked after sloppydisk has been removed. The explicit helper commands are still available for repatching, restoring stock behavior, and inspection:

```bash
sloppydisk patch
sloppydisk stock
sloppydisk status
```

Normal installs do not build Codex from source. They only do this:

1. find a matching patch bundle
2. back up the current Codex binary once
3. reconstruct the patched binary from the stock binary plus the bundled delta
4. record install state for clean restore

On Linux, this build currently assumes system `bwrap` is present and refuses to patch if it is missing.

Patch bundles are resolved in this order:

1. bundled artifact in the package
2. cached artifact under `~/.sloppydisk/artifacts`

## Maintainers

Release artifact builds are kept out of the shipped runtime. If you are working in the repo itself, use:

```bash
npm run build-release-artifact
npm run smoke-packaged-install
```

The release build script applies the patch to a clean Codex checkout, builds the patched musl binary, generates a `zstd --patch-from` delta against the stock Codex vendor binary, and writes the patch bundle into both the repo `artifacts/` tree and the local cache so the packaged install path can be smoke-tested without any runtime source build.
