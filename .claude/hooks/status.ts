// Status line: model, branch (+ changed tracked files), last presubmit result (written by PRESUBMIT.ts into .local/presubmit.json).
const input = (await Bun.stdin.json().catch(() => ({}))) as { model?: { display_name?: string }; cwd?: string };
const root = Bun.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const git = async (...args: string[]) => (await Bun.$`git -C ${root} ${args}`.nothrow().quiet().text()).trim();

const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")) || "?";
const changed = (await git("status", "--porcelain", "--untracked-files=no")).split("\n").filter(Boolean).length;
const last = (await Bun.file(`${root}/.local/presubmit.json`)
  .json()
  .catch(() => null)) as { at: string; ok: boolean; failed: string[] } | null;
const minutes = last ? Math.round((Date.now() - new Date(last.at).getTime()) / 60_000) : 0;
const when = minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
const presubmit = last ? `${last.ok ? "ok" : `FAIL ${last.failed.join(",")}`} ${when}` : "not run";
console.log(
  [input.model?.display_name, `${branch}${changed ? ` +${changed}` : ""}`, `presubmit ${presubmit}`]
    .filter(Boolean)
    .join(" · "),
);

export {}; // a module, so top-level await is allowed
