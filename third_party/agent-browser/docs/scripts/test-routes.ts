#!/usr/bin/env bun

import { join } from "node:path";
import { assert, assertEqual, assertMatch } from "./assert.ts";

const cwd = join(import.meta.dir, "..");
const preview = Bun.argv.includes("--preview");
assert(
  Bun.argv.slice(2).every((arg) => arg === "--preview"),
  "Usage: bun scripts/test-routes.ts [--preview]",
);
if (!(await Bun.file(join(cwd, ".next", "BUILD_ID")).exists())) {
  throw new Error("Missing production docs build. Run bun run build in docs first; this runner never starts next dev.");
}

// An ephemeral loopback port: bind port 0, read the port the kernel chose, release it.
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);

const env = {
  ...Bun.env,
  NODE_ENV: "production",
  PORT: String(port),
  VERCEL_ENV: preview ? "preview" : "production",
  DOCS_EXPECT_NOINDEX: preview ? "1" : "0",
  DOCS_TEST_URL: `http://127.0.0.1:${port}`,
};

function launch(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdio: ["inherit", "inherit", "inherit"],
    windowsHide: true,
  });
  const owned = { child, done: false, exited: child.exited };
  void child.exited.then(() => {
    owned.done = true;
  });
  return owned;
}

const server = launch([
  "--bun",
  Bun.fileURLToPath(import.meta.resolve("next/dist/bin/next")),
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
]);
let tests: ReturnType<typeof launch> | undefined;
let shutdown: Promise<unknown> | undefined;
let stopping = false;

function stop() {
  stopping = true;
  shutdown ??= Promise.all(
    [tests, server].map(async (owned) => {
      if (!owned || owned.done) return;
      owned.child.kill("SIGTERM");
      const deadline = setTimeout(() => owned.child.kill("SIGKILL"), 5000);
      try {
        await owned.exited;
      } finally {
        clearTimeout(deadline);
      }
    }),
  );
  return shutdown;
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(code));
  });
}

try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !stopping) {
    if (server.done) throw new Error(`Production docs server exited with ${await server.exited}`);
    try {
      const response = await fetch(`${env.DOCS_TEST_URL}/robots.txt`, {
        signal: AbortSignal.timeout(1000),
        redirect: "manual",
      });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server is not accepting connections yet; the next iteration probes again.
    }
    await Bun.sleep(100);
  }
  if (!ready && !stopping) throw new Error("Production docs server did not become ready within 60 seconds");
  if (!stopping) {
    console.log(`Testing owned production server ${env.DOCS_TEST_URL}; VERCEL_ENV=${env.VERCEL_ENV}`);
    const asset = await fetch(`${env.DOCS_TEST_URL}/api/mcp?webmcp-script`);
    assertEqual(asset.status, 200);
    assertMatch(asset.headers.get("content-type"), /javascript/);
    assertMatch(await asset.text(), /search_docs/);
    async function mcp(method: string, params = {}) {
      const response = await fetch(`${env.DOCS_TEST_URL}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      assertEqual(response.status, 200, method);
      const body = await response.text();
      const message = JSON.parse(
        response.headers.get("content-type")?.includes("text/event-stream")
          ? (body
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6) ?? "")
          : body,
      );
      assertEqual(message.error, undefined, method);
      assertEqual(message.id, 1);
      return message.result;
    }
    const { tools } = await mcp("tools/list");
    assertEqual(
      tools.map((tool: { name: string }) => tool.name),
      ["search_docs"],
    );
    const result = await mcp("tools/call", {
      name: "search_docs",
      arguments: { query: "webmcp", locale: "en" },
    });
    assert(result.isError !== true);
    const matches = JSON.parse(result.content.find((item: { type: string }) => item.type === "text").text);
    assert(matches.some((match: { url: string }) => match.url === "/webmcp"));
    console.log("MCP checks passed: JavaScript asset, tools/list, tools/call with real search results");
    tests = launch([
      "test",
      "tests/baseline-oracle.test.ts",
      "tests/docs-baseline.test.ts",
      "tests/docs-routes.test.ts",
    ]);
    const outcome = await Promise.race([
      tests.exited.then((code) => ({ source: "tests", code })),
      server.exited.then((code) => ({ source: "server", code })),
    ]);
    if (outcome.source === "server") throw new Error(`Production server exited during tests with ${outcome.code}`);
    process.exitCode = outcome.code;
  }
} finally {
  await stop();
}
