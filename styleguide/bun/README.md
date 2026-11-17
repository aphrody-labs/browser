# JavaScript and TypeScript: native Bun

Every JavaScript and TypeScript file of this repository that is ours (`tools/`, `testing/`, `.claude/`, the root
`package.json`, and our fork `third_party/agent-browser`; the list is `[javascript] first_party` in
[tools/layout.toml](../../tools/layout.toml)) runs on the Aphrody Bun runtime and uses its own APIs. Vendored trees
(`third_party/*`, including the `third_party/bun` submodule) keep their bytes.

**The rule:** a Bun API before a Node.js module, a built-in before an npm package. A `node:` module is used only where Bun has
no API of its own: `node:path` (path strings), `node:util` (`parseArgs`), `node:os` (`hostname`, `tmpdir`, `loadavg`).
Bun implements these natively; they are the ones the fork's own migration registry recommends (`minimist` -> `util.parseArgs`,
`packages.toml#minimist`) or has no replacement for.

**Proof.** Each row names the pages of the Bun fork's documentation (`docs/` of aphrody-labs/bun) that define the API, and what
enforces it here. `bun PRESUBMIT.ts` checks that every cited page exists in the fork (`BUN_DOCS=<fork>/docs`).

| Concern                | Use                                                  | Not                                    | Fork documentation                                                                    | Enforced by                                                     |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Files                  | `Bun.file(p).text()/.json()/.stat()`, `Bun.write`    | `node:fs`                              | `docs/runtime/file-io.mdx`                                                            | `import/no-nodejs-modules`                                      |
| Directories            | `Bun.$\`mkdir -p\``, `Bun.$\`rm -rf\``, `Bun.Glob`   | `fs.mkdir`, `fs.rm`, `fs.readdir`      | `docs/runtime/shell.mdx`, `docs/runtime/glob.mdx`                                     | `import/no-nodejs-modules`                                      |
| Processes              | `Bun.spawn`, `Bun.$`, always `windowsHide: true`     | `child_process`, `execa`               | `docs/runtime/child-process.mdx`, `docs/runtime/shell.mdx`                            | `bun/no-console-window-flash`                                   |
| Environment            | `Bun.env`                                            | `process.env`, `dotenv`                | `docs/runtime/environment-variables.mdx`                                              | `eslint/no-process-env`                                         |
| Files next to a module | `new URL("./x", import.meta.url)`, `import.meta.dir` | `__dirname`, `process.cwd()` joins     | `docs/runtime/module-resolution.mdx`                                                  | `bun/prefer-url-for-sibling-files`, `bun/no-cwd-dependent-path` |
| Waiting                | `Bun.sleep`, `AbortSignal.timeout`                   | `new Promise(setTimeout)`              | `docs/runtime/utils.mdx`                                                              | `bun/prefer-builtin-sleep`, `bun/prefer-timeout-signal`         |
| Temporary files        | `os.tmpdir()`                                        | `"/tmp"` literals                      | `docs/lint/rules/bun/no-literal-temp-dir.mdx`                                         | `bun/no-literal-temp-dir`                                       |
| Arguments              | `util.parseArgs` over `Bun.argv`                     | `minimist`, `yargs`, hand parsers      | `docs/guides/process/argv.mdx`                                                        | review                                                          |
| SQL, cache             | `bun:sqlite`, `RedisClient`                          | `better-sqlite3`, `ioredis`            | `docs/runtime/sqlite.mdx`, `docs/runtime/redis.mdx`                                   | `import/no-nodejs-modules`                                      |
| HTTP, SSE              | `Bun.serve({ routes })`                              | `express`, `ws`                        | `docs/runtime/http/server.mdx`                                                        | review                                                          |
| TLS peer               | `Bun.connect({ tls })`, `getPeerCertificate()`       | `node:tls`                             | `docs/runtime/networking`                                                             | `import/no-nodejs-modules`                                      |
| Parsing                | `Bun.TOML`, `HTMLRewriter`, `Bun.inflateSync`        | `toml`, `cheerio`, `zlib`              | `docs/runtime/toml.mdx`, `docs/runtime/html-rewriter.mdx`, `docs/runtime/hashing.mdx` | `import/no-nodejs-modules`                                      |
| Scheduling             | `Bun.cron`                                           | `node-cron`                            | `docs/runtime/cron.mdx`                                                               | review                                                          |
| Embedded browser       | `Bun.WebView`                                        | `puppeteer`, `playwright`              | `docs/runtime/webview.mdx`                                                            | review                                                          |
| Tests                  | `bun:test`, hermetic, no network                     | `jest`, `vitest`, `mocha`              | `docs/test/index.mdx`                                                                 | `bun test`                                                      |
| Types, lint, format    | `bun check`, `bun lint`, `bun fmt`                   | `tsc`, `eslint`, `prettier`            | `docs/runtime/check.mdx`, `docs/lint/index.mdx`, `docs/format/index.mdx`              | `bun PRESUBMIT.ts`                                              |
| Packages               | `bun install`, `workspaces`, catalogs, `bun.lock`    | `npm`, `pnpm`, `yarn`, their lockfiles | `docs/pm/workspaces.mdx`, `docs/pm/catalogs.mdx`, `docs/pm/lockfile.mdx`              | `bun PRESUBMIT.ts` (bun-native)                                 |
| Rule configuration     | `[lint.rules]`, `[fmt]` in `bunfig.toml`             | `.eslintrc`, `.prettierrc`             | `docs/runtime/bunfig.mdx`, `docs/lint/index.mdx`                                      | `bun lint`                                                      |

The linter rules are enabled in [bunfig.toml](../../bunfig.toml); every rule has a page under `docs/lint/rules/` of the fork.
`import/no-nodejs-modules` also counts `bun` and `bun:*` as built-ins, so they are in its `allow` list.

## Review rules we hold ourselves to

From the fork's `REVIEW.md` (Bun's own code review rules, `rule/contributing/*` of the n2b registry):

- Never swallow a failure: no `catch {}`, no catch-and-return-default (`eslint/no-empty`); an error is printed and the exit status is nonzero.
- Await the real condition and wire every failure to reject; never sleep and hope.
- Subprocesses drain their pipes concurrently: `Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])`.
- Tests are hermetic and leave nothing behind: no external hosts (the live ones are opt-in through an environment variable and skipped
  otherwise), temporary directories removed, every assertion able to fail.
- One source of truth, dead code deleted in the change that kills it, comments only for what the code cannot say.

## Not migrated

`bun n2b` (the fork's rewrite engine) is not in the installed runtime, so the same rules run as the native linter and the presubmit.
Next.js applications in `third_party/agent-browser/packages` run on the Bun runtime (`bun --bun next`); their source is
application code, not tooling.
