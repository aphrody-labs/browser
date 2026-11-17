---
description: Refresh the private telemetry and regenerate the private docs from what was learned
allowed-tools: Bash(bun *), Read
---
Run `bun testing/acceptance.ts telemetry` then `bun testing/acceptance.ts docs` (both read `.local/config.toml`; the output is git-ignored).
Then add what this session taught that is not yet there, one fact per call: `bun testing/acceptance.ts note "<text>" --kind gotcha|decision|fact`, and run `docs` again.
Never write a host, path, account, measurement or lesson into a tracked file. $ARGUMENTS
