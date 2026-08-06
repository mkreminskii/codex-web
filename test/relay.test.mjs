import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import { createRendererRelay } from "../src/relay.mjs";

function once(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", data => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise(resolveClose => {
    server.close(() => resolveClose());
  });
}

test("relays opaque bridge and app-host messages through authenticated roles", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const origin = await listen(server);
  const capability = "test-capability";
  const bootstrapUpdates = [];
  const relay = createRendererRelay({
    httpServer: server,
    origin,
    capability,
    hostReadyTimeoutMs: 1_000,
    onBootstrap: value => bootstrapUpdates.push(value),
  });
  let host;
  let browser;
  context.after(async () => {
    browser?.terminate();
    host?.terminate();
    await relay.close();
    await closeServer(server);
  });

  host = new WebSocket(relay.hostUrl);
  await once(host, "open");

  browser = new WebSocket(
    `${origin.replace(/^http/, "ws")}/__codex_bridge?role=browser`,
    {
      origin,
      headers: {
        Cookie: `codex_web_cap=${capability}`,
      },
    },
  );
  await once(browser, "open");

  const bootstrap = {
    sentryInitOptions: { desktopTraceSampleRate: 0 },
    sharedObjectSnapshot: { fixture: ["value"] },
  };
  host.send(JSON.stringify({ type: "bootstrap", value: bootstrap }));
  host.send(JSON.stringify({ type: "ready" }));
  await relay.waitForHost();
  assert.deepEqual(bootstrapUpdates.at(-1), bootstrap);

  const hostMessage = nextJson(host);
  browser.send(
    JSON.stringify({
      type: "invoke",
      id: "1",
      method: "sendMessageFromView",
      args: [{ type: "fixture" }],
    }),
  );
  assert.deepEqual(await hostMessage, {
    type: "invoke",
    id: "1",
    method: "sendMessageFromView",
    args: [{ type: "fixture" }],
  });

  const browserMessage = nextJson(browser);
  host.send(
    JSON.stringify({
      type: "result",
      id: "1",
      ok: true,
      value: { accepted: true },
    }),
  );
  assert.deepEqual(await browserMessage, {
    type: "result",
    id: "1",
    ok: true,
    value: { accepted: true },
  });

  const connectMessage = nextJson(host);
  browser.send(JSON.stringify({ type: "connect-app-host" }));
  assert.deepEqual(await connectMessage, { type: "connect-app-host" });

  const browserAppHostMessage = nextJson(host);
  browser.send(
    JSON.stringify({
      type: "app-host-message",
      message: "from-browser",
    }),
  );
  assert.deepEqual(await browserAppHostMessage, {
    type: "app-host-message",
    message: "from-browser",
  });

  const hostAppHostMessage = nextJson(browser);
  host.send(
    JSON.stringify({
      type: "app-host-message",
      message: "from-host",
    }),
  );
  assert.deepEqual(await hostAppHostMessage, {
    type: "app-host-message",
    message: "from-host",
  });

  const browserDisconnected = nextJson(host);
  const browserClosed = once(browser, "close");
  browser.close();
  await browserClosed;
  browser = null;
  assert.deepEqual(await browserDisconnected, {
    type: "browser-disconnected",
  });
});

test("rejects an unauthenticated application host", async (context) => {
  const server = createServer();
  const origin = await listen(server);
  const relay = createRendererRelay({
    httpServer: server,
    origin,
    capability: "correct",
  });
  context.after(async () => {
    await relay.close();
    await closeServer(server);
  });

  const host = new WebSocket(
    `${origin.replace(/^http/, "ws")}/__codex_bridge?role=host&cap=wrong`,
  );
  const error = await new Promise(resolveError => {
    host.once("error", resolveError);
  });
  assert.match(error.message, /403/);
});
