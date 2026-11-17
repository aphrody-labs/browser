// SessionStart: one line of context about this checkout's private state (.local, git-ignored): is there a private config, how old is
// the telemetry, what has been learned, did the last presubmit pass. Cheap and read-only; it never starts a probe (that is `/learn`).
import { Database } from "bun:sqlite";

const root = Bun.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const local = `${root}/.local`;
const age = (at: string | number) => {
  const hours = (Date.now() - new Date(at).getTime()) / 3_600_000;
  return hours < 1 ? "under 1 h" : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
};

const config = await Bun.file(`${local}/config.toml`).exists();
const probe = Bun.file(`${local}/telemetry/local.json`);
const telemetry = (await probe.exists()) ? `probed ${age(probe.lastModified)} ago` : "never probed";
let learned = "no store yet";
const store = Bun.file(`${local}/acceptance.db`);
if (await store.exists()) {
  const db = new Database(store.name!, { readonly: true });
  try {
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    learned = `${count("notes")} notes, ${count("lessons")} lessons`;
  } catch (error) {
    learned = `store unreadable: ${(error as Error).message}`; // an older schema: the next command migrates it
  } finally {
    db.close();
  }
}
const last = (await Bun.file(`${local}/presubmit.json`)
  .json()
  .catch(() => null)) as { at: string; ok: boolean; failed: string[] } | null;
const presubmit = last ? `${last.ok ? "ok" : `FAIL ${last.failed.join(", ")}`} ${age(last.at)} ago` : "not run";
console.log(
  `Private state (.local, git-ignored): config ${config ? "present" : "absent (hosts, paths, published host)"}; telemetry ${telemetry}; ${learned}; last presubmit: ${presubmit}. ` +
    "Machine and work facts are in .claude.local.md and .local/docs/, never in tracked files; /learn refreshes them.",
);
