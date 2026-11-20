# third_party

Code that is not written in this repository, on the model of Chromium's `//third_party`.

- **Forks with a build of their own** (Bun, kitesurf, browse, mullvad): pinned by commit in `tools/layout.toml` [forks]; no submodule, no checkout here.
- **Upstream pins (`mode = "pin"`)**: All external Rust/C++ upstream dependencies are tracked by live branch/tag SHA in `tools/upstreams.toml` and `tools/upstreams.lock.json` (`crates = {}`) rather than checked in as duplicated vendor trees. `tools/import.py` resolves live revisions without inflating local disk footprint.
- **External Chromium checkout**: Managed on the build host via `CHROMIUM_SRC` and `DEPS` (ignored by git).

First-party code lives in `components/` and is checked by `bun tools/layout.ts` and `bun PRESUBMIT.ts`.
