---
description: Run the presubmit and fix every failing check at its source
allowed-tools: Bash(bun *), Read, Edit, Grep, Glob
---
Run `bun PRESUBMIT.ts` (the Bun fork's docs for the docs check: `BUN_DOCS=<fork>/docs` when it is not in `third_party/bun/docs` or `../bun/docs`).
For every FAIL: read the check's detail, fix the cause in the code or the generator that produced it (never the check, never an exclusion without a documented reason), rerun until all pass.
Report the final table. $ARGUMENTS
