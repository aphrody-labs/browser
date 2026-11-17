import { expect, test } from "bun:test";

import { AgentBrowserMcpError, connectAgentBrowserMcp } from "../src/index.ts";
import { startAgentBrowserMcp } from "../src/vercel.ts";

/** An in-memory MCP server; `respond` maps a request to a reply, or `undefined` to never answer. */
function fakeServer(respond = (message) => ({ result: { echo: message.params } })) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const received = [];
  let stdoutController;
  let buffer = "";
  let exit;
  const exited = new Promise((resolve) => {
    exit = resolve;
  });
  const reply = (message) => {
    const response = respond(message);
    if (response === undefined) return;
    // Split each reply across two chunks to exercise line buffering.
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response })}\n`;
    stdoutController.enqueue(encoder.encode(line.slice(0, 5)));
    stdoutController.enqueue(encoder.encode(line.slice(5)));
  };
  return {
    received,
    process: {
      stdin: new WritableStream({
        write(chunk) {
          buffer += decoder.decode(chunk);
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const message = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            received.push(message);
            if (message.method === "initialize") {
              reply({ ...message, initialize: true });
            } else if (message.id !== undefined) {
              reply(message);
            }
          }
        },
        close() {
          stdoutController.close();
          exit({ exitCode: 0 });
        },
      }),
      stdout: new ReadableStream({
        start(controller) {
          stdoutController = controller;
        },
      }),
      wait: () => exited,
    },
    kill() {
      stdoutController.close();
      exit({ exitCode: 137 });
    },
  };
}

function initializeOr(respond) {
  return (message) =>
    message.initialize ? { result: { serverInfo: { name: "agent-browser", version: "test" } } } : respond(message);
}

test("initializes, calls tools, and closes with EOF", async () => {
  const server = fakeServer(initializeOr((message) => ({ result: { content: [], echo: message.params } })));
  const client = await connectAgentBrowserMcp(server.process);

  expect(client.serverInfo.version).toBe("test");
  const [open, url] = await Promise.all([
    client.callTool("agent_browser_open", { url: "https://example.com" }),
    client.callTool("agent_browser_get_url"),
  ]);
  expect(open.echo).toStrictEqual({ arguments: { url: "https://example.com" }, name: "agent_browser_open" });
  expect(url.echo).toStrictEqual({ arguments: {}, name: "agent_browser_get_url" });
  expect(server.received.map((message) => message.method)).toStrictEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
    "tools/call",
  ]);
  expect(await client.close()).toStrictEqual({ exitCode: 0 });
});

test("rejects JSON-RPC errors with the server's code", async () => {
  const server = fakeServer(initializeOr(() => ({ error: { code: -32601, message: "nope" } })));
  const client = await connectAgentBrowserMcp(server.process);

  const error = await client.request("resources/list").catch((caught) => caught);
  expect(error).toBeInstanceOf(AgentBrowserMcpError);
  expect(error.code).toBe(-32601);
  await client.close();
});

test("times out a request the server never answers", async () => {
  const server = fakeServer(initializeOr(() => undefined));
  const client = await connectAgentBrowserMcp(server.process, { timeout: 20 });

  await expect(client.callTool("agent_browser_click")).rejects.toThrow(/tools\/call timed out after 20ms/);
  await client.close();
});

test("aborts a pending request and fails pending requests when the server exits", async () => {
  const server = fakeServer(initializeOr(() => undefined));
  const client = await connectAgentBrowserMcp(server.process);
  const controller = new AbortController();

  const aborted = client.callTool("agent_browser_click", {}, { signal: controller.signal });
  controller.abort(new Error("stop"));
  await expect(aborted).rejects.toThrow(/stop/);

  const orphan = client.callTool("agent_browser_click");
  server.kill();
  await expect(orphan).rejects.toThrow(/closed its output/);
});

test("starts agent-browser mcp over Vercel Sandbox stdin", async () => {
  const server = fakeServer(initializeOr((message) => ({ result: { echo: message.params } })));
  const writer = server.process.stdin.getWriter();
  const calls = [];
  const sandbox = {
    async runCommand(options) {
      calls.push(options);
      return {
        closeStdin: () => writer.close(),
        kill: async () => server.kill(),
        async *logs() {
          yield { data: "starting\n", stream: "stderr" };
          for await (const chunk of server.process.stdout) {
            yield { data: new TextDecoder().decode(chunk), stream: "stdout" };
          }
        },
        wait: () => server.process.wait(),
        writeStdin: (data) => writer.write(data),
      };
    },
  };

  const client = await startAgentBrowserMcp(sandbox, { args: ["--tools", "core"] });
  const result = await client.callTool("agent_browser_snapshot");

  expect(calls).toStrictEqual([
    { args: ["mcp", "--tools", "core"], cmd: "agent-browser", detached: true, stdin: true },
  ]);
  expect(result.echo).toStrictEqual({ arguments: {}, name: "agent_browser_snapshot" });
  expect(await client.close()).toStrictEqual({ exitCode: 0 });
});

test("never sends an already-aborted or unserializable request", async () => {
  const server = fakeServer(initializeOr((message) => ({ result: message.params })));
  const client = await connectAgentBrowserMcp(server.process);
  const controller = new AbortController();
  controller.abort(new Error("stop"));

  await expect(client.callTool("agent_browser_click", {}, { signal: controller.signal })).rejects.toThrow(/stop/);
  await expect(client.callTool("agent_browser_click", { n: 1n })).rejects.toThrow(TypeError);
  expect(server.received.map((message) => message.method)).toStrictEqual(["initialize", "notifications/initialized"]);
  await client.close();
});

test("releases both streams when initialization fails", async () => {
  const server = fakeServer(() => undefined);

  await expect(connectAgentBrowserMcp(server.process, { timeout: 20 })).rejects.toThrow(/initialize timed out/);
  expect(server.process.stdin.locked).toBe(false);
  expect(server.process.stdout.locked).toBe(false);
});

test("rejects a failed initialization even when the first write stalls", async () => {
  const process = {
    stdin: new WritableStream({ write: () => new Promise(() => {}) }),
    stdout: new ReadableStream(),
    wait: () => new Promise(() => {}),
  };

  await expect(connectAgentBrowserMcp(process, { timeout: 20 })).rejects.toThrow(/initialize timed out/);
  expect(process.stdin.locked).toBe(false);
  expect(process.stdout.locked).toBe(false);
});

test("close rejects within the timeout when a write stalls", async () => {
  const encoder = new TextEncoder();
  let stdout;
  let writes = 0;
  const process = {
    stdin: new WritableStream({
      write() {
        if (++writes > 1) return new Promise(() => {});
        stdout.enqueue(encoder.encode(`${JSON.stringify({ id: 1, jsonrpc: "2.0", result: { serverInfo: {} } })}\n`));
      },
    }),
    stdout: new ReadableStream({
      start(controller) {
        stdout = controller;
      },
    }),
    wait: () => new Promise(() => {}),
  };
  const client = await connectAgentBrowserMcp(process, { timeout: 20 });

  await expect(client.close()).rejects.toThrow(/close timed out after 20ms/);
});
