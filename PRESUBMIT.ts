#!/usr/bin/env bun
// Presubmit, as in Chromium's PRESUBMIT.py: what must hold before a change is pushed. Native Bun tooling only.
//   bun PRESUBMIT.ts            run every check, print one line each, exit 1 if one failed
// The docs check needs the Bun fork's docs (BUN_DOCS=<fork>/docs, else the sibling ../bun/docs checkout of the fork) and says so when skipped.
import { join } from "node:path";

type Result = { name: string; ok: boolean; detail: string };
const layout = Bun.TOML.parse(await Bun.file(new URL("./tools/layout.toml", import.meta.url)).text()) as {
  javascript: { first_party: string[]; forbidden_files: string[]; forbidden_script_words: string[] };
  third_party: { dir: string };
};
const run = async (argv: string[]) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
};
const tracked = async (...paths: string[]) =>
  (await run(["git", "ls-files", "-z", "--", ...paths])).out.split("\0").filter(Boolean);
const last = (text: string) => text.trim().split("\n").at(-1) ?? "";

const checks: [string, () => Promise<Omit<Result, "name">>][] = [
  [
    "types",
    async () => {
      const { out, err, code } = await run(["bun", "check"]);
      return { ok: code === 0, detail: last(out + err) };
    },
  ],
  [
    "lint",
    async () => {
      const { out, err, code } = await run(["bun", "lint", "tools", "testing"]);
      return { ok: code === 0, detail: last(out + err) };
    },
  ],
  [
    "format",
    async () => {
      const files = (await tracked("*.ts")).filter((f) => !f.startsWith("third_party/"));
      const { out, err, code } = await run(["bun", "fmt", "--check", ...files]);
      return { ok: code === 0, detail: last(out + err) };
    },
  ],
  [
    "tests",
    async () => {
      const { out, err, code } = await run(["bun", "test", "testing", "tools"]);
      return {
        ok: code === 0,
        detail: (out + err)
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)/.test(l))
          .map((l) => l.trim())
          .join(", "),
      };
    },
  ],
  [
    "layout",
    async () => {
      const { out, code } = await run(["bun", "tools/layout.ts", "."]);
      return { ok: code === 0, detail: out.trim().split("\n").join("; ") };
    },
  ],
  [
    "third_party",
    async () => {
      await run(["bun", "tools/third_party.ts", "."]);
      const { out } = await run(["git", "diff", "--name-only", "--", `${layout.third_party.dir}/*/README.chromium`]);
      const stale = out.split("\n").filter(Boolean);
      return {
        ok: stale.length === 0,
        detail: stale.length ? `stale: ${stale.join(", ")}` : "README.chromium up to date",
      };
    },
  ],
  [
    "bun-native",
    async () => {
      const { first_party, forbidden_files, forbidden_script_words } = layout.javascript;
      const problems: string[] = [];
      for (const file of await tracked(...first_party)) {
        const name = file.split("/").at(-1)!;
        if (forbidden_files.includes(name)) problems.push(`${file}: ${name} is not a Bun file`);
        if (name === "package.json") {
          const scripts = ((await Bun.file(file).json()) as { scripts?: Record<string, string> }).scripts ?? {};
          for (const [key, cmd] of Object.entries(scripts)) {
            const word = forbidden_script_words.find((w) => new RegExp(`(^|[;&|(]\\s*)${w}(\\s|$)`).test(cmd)); // a command, not an argument such as `--target node`
            if (word) problems.push(`${file}: script "${key}" runs ${word}`);
          }
        }
      }
      return {
        ok: problems.length === 0,
        detail: problems.length ? problems.slice(0, 5).join("; ") : "no Node.js package manager, runtime or tool left",
      };
    },
  ],
  [
    "readme-chromium",
    async () => {
      // Chromium's own metadata validator (depot_tools/metadata) on every README.chromium: no errors. Where depot_tools is:
      // DEPOT_TOOLS, else paths.depot_tools of the private .local/config.toml; absent, the check says so and passes.
      const config = (await Bun.file(".local/config.toml").exists())
        ? (Bun.TOML.parse(await Bun.file(".local/config.toml").text()) as Record<string, any>)
        : {};
      const tools: string | undefined = Bun.env.DEPOT_TOOLS ?? config.paths?.depot_tools;
      const python = Bun.which("python3") ?? Bun.which("python");
      if (!tools || !python)
        return { ok: true, detail: `skipped: ${!tools ? "no depot_tools (DEPOT_TOOLS)" : "no python"}` };
      const code = `import sys, glob\nsys.path.insert(0, sys.argv[1])\nfrom metadata import validate\nbad = 0\nfor f in sorted(glob.glob("third_party/*/README.chromium")):\n    e, w = validate.check_file(f, ".")\n    for x in e:\n        bad += 1\n        print(f + ": " + x.split(chr(10))[0])\nprint(bad, "errors")`;
      const proc = Bun.spawn([python, "-c", code, tools], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return {
        ok: /^0 errors/m.test(out),
        detail: out.trim().split("\n").slice(-3).join("; ") || err.trim().split("\n").at(-1) || "no output",
      };
    },
  ],
  [
    "private-data",
    async () => {
      // Nothing about a machine, an account or a private host is tracked: those facts live in .local/ and .claude.local.md (generated).
      const generic = [
        /\/srv\//,
        /\/home\/[a-z0-9_.-]+/i,
        /\/c\/src\//,
        /[A-Za-z]:[\\/]+(Users|src)[\\/]/,
        /@users\.noreply\.github\.com/,
        /\b(ssh|scp)\s+(-\S+\s+)*(fr\d|prd|vps\w*)\b/i,
      ];
      const config = (await Bun.file(".local/config.toml").exists())
        ? (Bun.TOML.parse(await Bun.file(".local/config.toml").text()) as Record<string, any>)
        : {};
      const literal = [
        ...Object.values((config.hosts ?? {}) as Record<string, { ssh: string }>).map((h) => h.ssh),
        config.serve?.host,
        config.serve?.origin,
        config.paths?.chromium_src,
        config.paths?.scratch,
      ].filter((x): x is string => typeof x === "string" && x.length > 2);
      const files = (await tracked("."))
        .filter(
          (f) =>
            !/^(third_party|node_modules)\//.test(f) &&
            !/(\.lock|\.lockb|\.png|\.ico|LICENSE)$/.test(f) &&
            f !== "PRESUBMIT.ts" &&
            !f.startsWith("tools/upstreams.lock"),
        )
        .filter((f) => !f.endsWith("track.test.ts") || true);
      const hits: string[] = [];
      for (const file of files) {
        const text = await Bun.file(file)
          .text()
          .catch(() => "");
        if (text.includes("\0")) continue;
        for (const [n, line] of text.split("\n").entries()) {
          const bad = generic.find((re) => re.test(line)) ?? literal.find((l) => line.includes(l));
          if (bad) hits.push(`${file}:${n + 1}`);
        }
      }
      return {
        ok: hits.length === 0,
        detail: hits.length
          ? `${hits.length} line(s): ${hits.slice(0, 6).join(", ")}`
          : "no host, path, account or private host in tracked files",
      };
    },
  ],
  [
    "docs",
    async () => {
      const docs = Bun.env.BUN_DOCS ?? join(import.meta.dir, "..", "bun", "docs");
      if (!(await Bun.file(join(docs, "index.mdx")).exists()))
        return {
          ok: !Bun.env.BUN_DOCS, // an explicit BUN_DOCS that points nowhere is an error, a missing fork checkout only a skip
          detail: `no fork docs at ${docs}${Bun.env.BUN_DOCS ? "" : " (skipped; set BUN_DOCS)"}`,
        };
      const guide = await Bun.file("styleguide/bun/README.md").text();
      const cited = [...new Set([...guide.matchAll(/`docs\/([^`]+\.mdx)`/g)].map((m) => m[1]))];
      const missing: string[] = [];
      for (const page of cited) if (!(await Bun.file(join(docs, page)).exists())) missing.push(page);
      return {
        ok: missing.length === 0,
        detail: missing.length
          ? `missing in the fork: ${missing.join(", ")}`
          : `${cited.length} cited pages exist in the fork`,
      };
    },
  ],
];

const results: Result[] = await Promise.all(
  checks.map(async ([name, check]) => ({
    name,
    ...(await check().catch((error: Error) => ({ ok: false, detail: error.message }))),
  })),
);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(12)} ${r.detail}`);
// The status line and the session start read this: private, git-ignored.
await Bun.write(
  ".local/presubmit.json",
  JSON.stringify({
    at: new Date().toISOString(),
    ok: results.every((r) => r.ok),
    failed: results.filter((r) => !r.ok).map((r) => r.name),
  }) + "\n",
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
