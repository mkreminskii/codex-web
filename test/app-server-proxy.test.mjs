import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocketServer } from "ws";

const maximumQueuedBytes = 64 * 1024 * 1024;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const proxyPath = join(projectRoot, "src", "app-server-proxy.mjs");

async function startProxy(context) {
  const root = await mkdtemp(join(tmpdir(), "codex-web-app-server-proxy-"));
  const socketPath = join(root, "app-server.sock");
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    perMessageDeflate: false,
  });
  context.after(async () => {
    webSocketServer.close();
    await new Promise(resolve => httpServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  httpServer.listen(socketPath);
  await once(httpServer, "listening");
  const connection = once(webSocketServer, "connection");
  const child = spawn(proxyPath, [], {
    env: {
      ...process.env,
      CODEX_WEB_APP_SERVER_SOCKET_PATH: socketPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  context.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  const [socket] = await connection;
  return { child, socket, stderr: () => stderr };
}

test("proxies fragmented JSONL and ordered daemon messages", async context => {
  const { child, socket, stderr } = await startProxy(context);
  const request = {
    id: "__codex_initialize__",
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-web-test",
        title: "codex-web-test",
        version: "0",
      },
    },
  };
  const requestReceived = once(socket, "message");
  const requestText = JSON.stringify(request);
  const split = Math.floor(requestText.length / 2);
  child.stdin.write(requestText.slice(0, split));
  child.stdin.write(`${requestText.slice(split)}\r`);
  child.stdin.write("\n");
  const [requestData, isBinary] = await requestReceived;
  assert.equal(isBinary, false);
  assert.deepEqual(JSON.parse(requestData.toString()), request);

  const response = {
    id: "__codex_initialize__",
    result: {
      userAgent: "codex-web-test",
      payload: "x".repeat(32 * 1024),
    },
  };
  const notification = {
    method: "thread/started",
    params: { thread: { id: "thread-1" } },
  };
  const output = createInterface({ input: child.stdout });
  const lines = [];
  const responsesReceived = new Promise(resolve => {
    output.on("line", line => {
      lines.push(JSON.parse(line));
      if (lines.length === 2) {
        resolve();
      }
    });
  });
  socket.send(JSON.stringify(response));
  socket.send(JSON.stringify(notification));
  await responsesReceived;
  assert.deepEqual(lines, [response, notification]);

  child.stdin.end();
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr(), "");
});

test(
  "resumes daemon output after stdout backpressure",
  { timeout: 10_000 },
  async context => {
    const { child, socket, stderr } = await startProxy(context);
    const messageCount = 128;
    const payload = "x".repeat(32 * 1024);
    for (let index = 0; index < messageCount; index += 1) {
      socket.send(JSON.stringify({ id: index, result: { payload } }));
    }

    await delay(100);
    const output = createInterface({ input: child.stdout });
    const ids = [];
    await new Promise(resolve => {
      output.on("line", line => {
        ids.push(JSON.parse(line).id);
        if (ids.length === messageCount) {
          resolve();
        }
      });
    });
    assert.deepEqual(
      ids,
      Array.from({ length: messageCount }, (_, index) => index),
    );

    child.stdin.end();
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stderr(), "");
  },
);

test(
  "rejects an unterminated input record larger than 64 MiB",
  { timeout: 10_000 },
  async context => {
    const { child, stderr } = await startProxy(context);
    const childClosed = once(child, "close");
    const block = Buffer.alloc(1024 * 1024, 0x78);
    child.stdin.on("error", () => {});

    for (let index = 0; index <= maximumQueuedBytes / block.length; index += 1) {
      if (!child.stdin.write(block)) {
        const outcome = await Promise.race([
          new Promise(resolve => {
            child.stdin.once("drain", () => resolve("drain"));
          }),
          childClosed.then(() => "closed"),
        ]);
        if (outcome === "closed") {
          break;
        }
      }
    }
    if (child.exitCode === null) {
      child.stdin.end();
    }

    const [code] = await childClosed;
    assert.notEqual(code, 0);
    assert.match(stderr(), /input record exceeded 64 MiB/);
  },
);
