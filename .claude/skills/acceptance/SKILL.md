---
name: acceptance
description: Test the browser's engines (Chromium headless_shell, Obscura, the agent-browser and Bun.WebView fronts) against the live Google/Alphabet corpus, benchmark them with hyperfine and JetStream, follow the upstream engines (Chromium, Servo, Blitz, SpiderMonkey, WebKit, Obscura) and publish the live dashboard. Use for any "does the browser work on site X", engine comparison, regression hunt, benchmark or dashboard task.
---

# acceptance

One Bun tool, `testing/acceptance.ts` (modules in `testing/acceptance/`, data in `testing/acceptance.toml`). Nothing is a stored
result: engines, versions, hosts, the corpus and the upstream heads are read live.

| Need | Command |
|---|---|
| Which engines and tools exist here | `bun testing/acceptance.ts engines` |
| Newest upstream baselines (Chrome for Testing canary, Obscura release) | `bun testing/acceptance.ts install` |
| The corpus (seeds + recursive link index from abc.xyz) | `bun testing/acceptance.ts sites` |
| Load the corpus in every engine, judge, store, report | `bun testing/acceptance.ts run [--install] [--site <part>] [--no-discover]` |
| Cold start + memory, hyperfine | `bun testing/acceptance.ts bench [url...]` |
| JetStream in the full engines | `bun testing/acceptance.ts bench --jetstream [--test <workload>]` |
| Upstream heads, releases, channels against our pins | `bun testing/acceptance.ts track` |
| Live dashboard (HTML, `/api/state`, SSE `/api/events`) + cron | `bun testing/acceptance.ts serve --schedule` |
| Worker + tunnel config for the published host | `bun testing/acceptance.ts deploy` |
| Where each engine fell short of the full one (the router's data) | `bun testing/acceptance.ts lessons [--json]` |
| Last report | `bun testing/acceptance.ts report [run] [--json]` |

## Where to run it
Heavy runs and every build go to a build host, never the workstation: copy `testing/` and `tools/` there (`BROWSER_ENGINES` points at extra
engine directories). Which hosts exist, and what is installed on them, is private telemetry: `bun testing/acceptance.ts telemetry`
(hosts from `.local/config.toml`), then `docs` writes `.local/docs/fleet.md`. A front that cannot start the browser on a machine is
reported `SKIP`, not as a page failure.

## Private state
Nothing about a machine, an account or the work in progress is committed or written into docs and agent files. `.local/` (git-ignored)
holds `config.toml` (overlay of `testing/acceptance.toml`: hosts, paths, the published host), the store, telemetry and the generated
documents; `.claude.local.md` is generated from the notes. Add what you learn with `bun testing/acceptance.ts note "<text>" --kind gotcha`.

## Reading a result
- Verdicts: `pass`; `auth`, `consent`, `refused` (a wall or the server's answer, not the engine's fault); `fail` (the engine's).
- Exit 1 when a full-engine page or a front fails, or a page that passed in the previous run of this host fails now.
- `lite is enough for N of M pages` is the router's escalation rule measured: landing host, element and text share.
- A run interrupted by a crash or Ctrl-C resumes (same host, unfinished) unless `--fresh`; the link index resumes too and
  is reused for `ttl_s`, then revalidated with ETag / Last-Modified.
- State: SQLite (`out/acceptance/acceptance.db`), plus Redis/Valkey (`REDIS_URL`/`VALKEY_URL`, default localhost) as hot
  cache and instant wake-up for the dashboard; without a server the tool still works.

## Rules for changing it
- Policy and data go to `testing/acceptance.toml`, never into the code; versions and URLs are never literals.
- Quality gates are native and run together by `bun PRESUBMIT.ts` (`bun check`, `bun lint`, `bun fmt --check`, `bun test`); the edit hook formats TypeScript. Style and proof: `styleguide/bun/README.md`.
- Publishing the hostname needs the zone's DNS: `deploy` only plans (wrangler `--dry-run`) and reports what is missing; do not edit the zone from here.
- Screenshots and reports live in `out/` (ignored); cookies exported by `cookies` are credentials: never commit them.
