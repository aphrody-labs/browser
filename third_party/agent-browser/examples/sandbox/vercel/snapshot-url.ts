#!/usr/bin/env bun

import { runAgentBrowserCommand, withAgentBrowserSandbox } from "@agent-browser/sandbox/vercel";

const url = Bun.argv[2] ?? "https://example.com";

const snapshot = await withAgentBrowserSandbox(async (sandbox) => {
  await runAgentBrowserCommand(sandbox, ["open", url]);
  const result = await runAgentBrowserCommand(sandbox, ["snapshot", "-i", "-c"], {
    json: false,
  });
  await runAgentBrowserCommand(sandbox, ["close"], { json: false });
  return result.stdout;
});

console.log(snapshot);
