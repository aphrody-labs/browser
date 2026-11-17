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
Linux builds and heavy runs go to the build hosts, never the workstation: copy `tools/` and run there (`BROWSER_ENGINES`
points at extra engine directories). The PC is fine for `engines`, `sites`, a few pages, `serve` and `deploy`.
`Bun.WebView` cannot start Chrome or Edge on the Windows workstation (`Chrome process closed the pipe`): the front is
reported `SKIP` there and `ok` on Linux.

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
