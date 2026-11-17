import { expect, test } from "bun:test";

import {
  AGENT_BROWSER_SANDBOX_VERSION,
  DEFAULT_AGENT_BROWSER_INSTALL_SPEC,
  buildAgentBrowserArgv,
  buildShellCommand,
  defaultSessionName,
  quoteShellArg,
  resolveAgentBrowserInstallSpec,
} from "../src/index.ts";

test("defaults install spec to the package version", async () => {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const expectedInstallSpec = `agent-browser@${packageJson.version}`;

  expect(AGENT_BROWSER_SANDBOX_VERSION).toBe(packageJson.version);
  expect(DEFAULT_AGENT_BROWSER_INSTALL_SPEC).toBe(expectedInstallSpec);
  expect(resolveAgentBrowserInstallSpec()).toBe(expectedInstallSpec);
  expect(resolveAgentBrowserInstallSpec({ installSpec: "latest" })).toBe("latest");
});

test("builds argv with session and json by default", () => {
  expect(buildAgentBrowserArgv(["open", "https://example.com"], { session: "s1" })).toStrictEqual([
    "--session",
    "s1",
    "open",
    "https://example.com",
    "--json",
  ]);

  expect(buildAgentBrowserArgv(["snapshot", "--json"], { session: "s1" })).toStrictEqual([
    "--session",
    "s1",
    "snapshot",
    "--json",
  ]);
});

test("quotes shell args and builds commands", () => {
  expect(quoteShellArg("simple")).toBe("simple");
  expect(quoteShellArg("hello world")).toBe("'hello world'");
  expect(quoteShellArg("can't")).toBe("'can'\\''t'");

  expect(
    buildShellCommand(["open", "https://example.com/a b"], {
      env: { AGENT_BROWSER_HOME: "/home/agent browser" },
      session: "s1",
    }),
  ).toBe("AGENT_BROWSER_HOME='/home/agent browser' agent-browser --session s1 open 'https://example.com/a b' --json");
});

test("sanitizes default session names", () => {
  expect(defaultSessionName("eve", "sandbox/id 1")).toBe("eve-sandbox-id-1");
});

test("keeps generated default session names short", () => {
  const session = defaultSessionName(
    "eve",
    "eve-sbx-ses-vercel-1d940340bdba4563-wrun_01KVKDK1Z3GC3XEC86DGWRWRMH-__root__",
  );

  expect(session.length <= 48).toBe(true);
  expect(session).toMatch(/^eve-eve-sbx-ses-vercel-.+-[a-f0-9]{8}$/);
});
