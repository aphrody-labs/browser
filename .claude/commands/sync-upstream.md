---
description: Re-sync one imported upstream (history replayed linearly) and integrate it
argument-hint: <upstream name from tools/upstreams.toml>
allowed-tools: Bash(bun *), Bash(git *), Bash(ssh -o BatchMode=yes *), Read, Edit
---
Sync `$1` on the build host, never on this machine: `python3 tools/import.py . <scratch>/imp $1`, then `uv run --with tomlkit tools/flatten.py . --root-only`,
`bash tools/fixups.sh`, `bun tools/third_party.ts`, `cargo metadata --locked`, and a `cargo check` of the crates of `$1` and of their dependents.
A conflict stops the import: resolve it by hand, never by taking one side. Compare the result with `bun testing/acceptance.ts track`.
Commit by path, `git fetch` and fast-forward, push; the history must stay linear.
