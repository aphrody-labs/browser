# third_party

Code that is not written in this repository, on the model of Chromium's `//third_party`. No upstream tree is checked in.

- **Forks with a build of their own** (Bun, kitesurf, browse, mullvad): pinned by commit in `tools/layout.toml` [forks]; no submodule, no checkout here.
- **Upstreams** (`tools/upstreams.toml`, all `mode = "pin"`): the pinned head of each is in `tools/upstreams.lock.json` (`crates = {}`) and Cargo fetches it from there.
- **Chromium checkout**: on the build host (`CHROMIUM_SRC`, revision in `DEPS`), ignored by git.

First-party code lives in `components/`; `bun tools/layout.ts` and `bun PRESUBMIT.ts` check the layout.
