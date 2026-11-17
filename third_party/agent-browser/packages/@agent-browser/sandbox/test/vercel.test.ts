import { expect, test } from "bun:test";

import {
  CHROMIUM_SYSTEM_DEPS,
  createAgentBrowserSandbox,
  createAgentBrowserSnapshot,
  getSandboxCredentials,
  installAgentBrowserInVercelSandbox,
  runAgentBrowserCommand,
  withAgentBrowserSandbox,
} from "../src/vercel.ts";

test("default Vercel dependencies include certutil", () => {
  expect(CHROMIUM_SYSTEM_DEPS.includes("nss-tools")).toBeTruthy();
});

function commandResult(stdout = "{}", stderr = "", exitCode = 0) {
  return {
    exitCode,
    async stderr() {
      return stderr;
    },
    async stdout() {
      return stdout;
    },
  };
}

test("imports vercel entry without loading a real @vercel/sandbox module", async () => {
  expect(typeof getSandboxCredentials).toBe("function");
});

test("reads explicit Vercel credentials", () => {
  expect(
    getSandboxCredentials({
      VERCEL_PROJECT_ID: "project",
      VERCEL_TEAM_ID: "team",
      VERCEL_TOKEN: "token",
    }),
  ).toStrictEqual({ projectId: "project", teamId: "team", token: "token" });
  expect(getSandboxCredentials({})).toStrictEqual({});
});

test("runs agent-browser command in a Vercel sandbox", async () => {
  const calls = [];
  const sandbox = {
    async runCommand(command, args) {
      calls.push([command, args]);
      return commandResult('{"ok":true}');
    },
  };

  const result = await runAgentBrowserCommand(sandbox, ["open", "https://example.com"], {
    session: "s1",
  });

  expect(result.json).toStrictEqual({ ok: true });
  expect(calls).toStrictEqual([["agent-browser", ["--session", "s1", "open", "https://example.com", "--json"]]]);
});

test("creates and bootstraps a fresh Vercel sandbox", async () => {
  const calls = [];
  const sandbox = {
    async runCommand(command, args) {
      calls.push([command, args]);
      return commandResult();
    },
    async snapshot() {
      return { snapshotId: "snap" };
    },
    async stop() {},
  };
  const Sandbox = {
    async create(options) {
      calls.push(["create", options]);
      return sandbox;
    },
  };

  await createAgentBrowserSandbox({
    Sandbox,
    env: {},
    install: { installSpec: "agent-browser@1.2.3", systemDependencies: ["nss"] },
  });

  expect(calls[0][0]).toBe("create");
  expect(calls[1]).toStrictEqual([
    "sh",
    ["-c", "sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken -- nss 2>&1 && sudo ldconfig 2>&1"],
  ]);
  expect(calls[2]).toStrictEqual(["npm", ["install", "-g", "agent-browser@1.2.3"]]);
  expect(calls[3]).toStrictEqual(["agent-browser", ["install"]]);
});

test("skips Vercel system dependencies when explicitly disabled", async () => {
  const calls = [];
  const sandbox = {
    async runCommand(command, args) {
      calls.push([command, args]);
      return commandResult();
    },
  };

  await installAgentBrowserInVercelSandbox(sandbox, {
    installSpec: "agent-browser@1.2.3",
    installSystemDependencies: false,
  });

  expect(calls).toStrictEqual([
    ["npm", ["install", "-g", "agent-browser@1.2.3"]],
    ["agent-browser", ["install"]],
  ]);
});

test("rejects invalid Vercel system dependency names", async () => {
  const calls = [];
  const sandbox = {
    async runCommand(command, args) {
      calls.push([command, args]);
      return commandResult();
    },
  };

  await expect(
    (() =>
      installAgentBrowserInVercelSandbox(sandbox, {
        systemDependencies: ["nss; touch /tmp/pwned"],
      }))(),
  ).rejects.toThrow(/Invalid system dependency name/);
  expect(calls).toStrictEqual([]);
});

test("stops a fresh Vercel sandbox when bootstrap fails", async () => {
  let stopped = false;
  const sandbox = {
    async runCommand() {
      return commandResult("", "install failed", 1);
    },
    async snapshot() {
      return { snapshotId: "snap" };
    },
    async stop() {
      stopped = true;
    },
  };

  await expect(
    (() =>
      createAgentBrowserSandbox({
        Sandbox: {
          async create() {
            return sandbox;
          },
        },
        env: {},
        install: { systemDependencies: [] },
      }))(),
  ).rejects.toThrow(/install failed/);
  expect(stopped).toBe(true);
});

test("withAgentBrowserSandbox stops the sandbox", async () => {
  let stopped = false;
  const sandbox = {
    async runCommand() {
      return commandResult();
    },
    async snapshot() {
      return { snapshotId: "snap" };
    },
    async stop() {
      stopped = true;
    },
  };

  const value = await withAgentBrowserSandbox(async () => 42, {
    Sandbox: {
      async create() {
        return sandbox;
      },
    },
    bootstrap: false,
    env: {},
  });

  expect(value).toBe(42);
  expect(stopped).toBe(true);
});

test("withAgentBrowserSandbox preserves callback failure when stop fails", async () => {
  const sandbox = {
    async runCommand() {
      return commandResult();
    },
    async snapshot() {
      return { snapshotId: "snap" };
    },
    async stop() {
      throw new Error("stop failed");
    },
  };

  await expect(
    (() =>
      withAgentBrowserSandbox(
        async () => {
          throw new Error("work failed");
        },
        {
          Sandbox: {
            async create() {
              return sandbox;
            },
          },
          bootstrap: false,
          env: {},
        },
      ))(),
  ).rejects.toThrow(/work failed/);
});

test("withAgentBrowserSandbox surfaces stop failure after success", async () => {
  const sandbox = {
    async runCommand() {
      return commandResult();
    },
    async snapshot() {
      return { snapshotId: "snap" };
    },
    async stop() {
      throw new Error("stop failed");
    },
  };

  await expect(
    (() =>
      withAgentBrowserSandbox(async () => 42, {
        Sandbox: {
          async create() {
            return sandbox;
          },
        },
        bootstrap: false,
        env: {},
      }))(),
  ).rejects.toThrow(/stop failed/);
});

test("creates a Vercel sandbox snapshot", async () => {
  const sandbox = {
    async runCommand() {
      return commandResult();
    },
    async snapshot() {
      return { snapshotId: "snap_123" };
    },
    async stop() {},
  };

  const snapshotId = await createAgentBrowserSnapshot({
    Sandbox: {
      async create() {
        return sandbox;
      },
    },
    env: {},
    install: { systemDependencies: [] },
  });

  expect(snapshotId).toBe("snap_123");
});

test("createAgentBrowserSnapshot preserves snapshot failure when stop fails", async () => {
  const sandbox = {
    async runCommand() {
      return commandResult();
    },
    async snapshot() {
      throw new Error("snapshot failed");
    },
    async stop() {
      throw new Error("stop failed");
    },
  };

  await expect(
    (() =>
      createAgentBrowserSnapshot({
        Sandbox: {
          async create() {
            return sandbox;
          },
        },
        env: {},
        install: { systemDependencies: [] },
      }))(),
  ).rejects.toThrow(/snapshot failed/);
});
