import { expect, test } from "bun:test";

import {
  agentBrowserRevalidationKey,
  buildAgentBrowserCommand,
  installAgentBrowser,
  runAgentBrowser,
} from "../dist/sandbox/sandbox.js";

test("builds Eve revalidation key from install options", () => {
  expect(agentBrowserRevalidationKey({ installSpec: "agent-browser@1.2.3" })).toBe(
    "agent-browser:bootstrap-4:agent-browser@1.2.3:browser:system-deps",
  );
  expect(agentBrowserRevalidationKey({ installSpec: "agent-browser@1.2.3", installSystemDependencies: false })).toBe(
    "agent-browser:bootstrap-4:agent-browser@1.2.3:browser:no-system-deps",
  );
});

test("builds Eve shell command", () => {
  expect(buildAgentBrowserCommand(["open", "https://example.com"], { session: "s1" })).toBe(
    "agent-browser --session s1 open https://example.com --json",
  );
});

test("installs agent-browser in an Eve sandbox", async () => {
  const commands = [];
  const sandbox = {
    async run({ command }) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await installAgentBrowser(sandbox, { installSpec: "agent-browser@1.2.3" });

  expect(commands.length).toBe(3);
  expect(commands[0]).toMatch(/^if command -v apt-get/);
  expect(commands[0]).toMatch(/libglib2\.0-0t64/);
  expect(commands[0]).toMatch(/libasound2t64/);
  expect(commands[0]).toMatch(/libnss3-tools/);
  expect(commands[0]).toMatch(/sudo ldconfig; elif command -v dnf/);
  expect(commands[0]).toMatch(/sudo ldconfig; else echo/);
  expect(commands[0]).toMatch(/sudo dnf install -y --skip-broken -- glib2 nss nss-tools/);
  expect(commands[1]).toBe("npm install -g agent-browser@1.2.3");
  expect(commands[2]).toBe("agent-browser install");
});

test("skips Eve system dependencies when explicitly disabled", async () => {
  const commands = [];
  const sandbox = {
    async run({ command }) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await installAgentBrowser(sandbox, {
    installSpec: "agent-browser@1.2.3",
    installSystemDependencies: false,
  });

  expect(commands).toStrictEqual(["npm install -g agent-browser@1.2.3", "agent-browser install"]);
});

test("runs agent-browser through ctx.getSandbox", async () => {
  const commands = [];
  const ctx = {
    async getSandbox() {
      return {
        async run({ command }) {
          commands.push(command);
          return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
        },
      };
    },
  };

  const result = await runAgentBrowser(ctx, ["open", "https://example.com"]);

  expect(result.json).toStrictEqual({ ok: true });
  expect(commands[0]).toBe("agent-browser --session eve-default open https://example.com --json");
});

test("accepts Eve promise-like sandbox methods", async () => {
  const thenable = (value) => ({
    then(resolve) {
      resolve(value);
    },
  });
  const ctx = {
    getSandbox() {
      return thenable({
        run() {
          return thenable({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
        },
      });
    },
  };

  const result = await runAgentBrowser(ctx, ["snapshot"]);

  expect(result.json).toStrictEqual({ ok: true });
});

test("throws when Eve sandbox command fails", async () => {
  const ctx = {
    async getSandbox() {
      return {
        async run() {
          return { exitCode: 2, stdout: "", stderr: "no chrome" };
        },
      };
    },
  };

  await expect((() => runAgentBrowser(ctx, ["snapshot"]))()).rejects.toThrow(/no chrome/);
});
