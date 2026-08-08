import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startWebRuntime } from "../src/web-runtime.mjs";

test("loads the Electron host through the minimal host page", async context => {
  const appRoot = await mkdtemp(join(tmpdir(), "codex-web-web-runtime-"));
  context.after(() => rm(appRoot, { recursive: true, force: true }));

  const hostPageUrl = "http://127.0.0.1:4310/__codex_host?cap=fixture";
  let hostOptions;
  const hostExit = Promise.withResolvers();
  const runtime = await startWebRuntime({
    appRoot,
    startServer: async () => ({
      url: "https://codex.example.test/?cap=fixture",
      internalUrl: "http://127.0.0.1:4310/?cap=fixture",
      hostPageUrl,
      origin: "http://127.0.0.1:4310",
      capability: "fixture",
      httpServer: {},
      setBootstrap() {},
      isRequestOriginAllowed() {
        return true;
      },
      async close() {},
    }),
    createRelay: () => ({
      hostUrl: "ws://127.0.0.1:4310/__codex_bridge?role=host&cap=fixture",
      waitForHost: async () => {},
      async close() {},
    }),
    startHost: async options => {
      hostOptions = options;
      return {
        exited: hostExit.promise,
        async stop() {
          hostExit.resolve({ code: 0, signal: null, output: "" });
        },
      };
    },
  });

  assert.equal(hostOptions.rendererUrl, hostPageUrl);
  await runtime.close();
  assert.equal(await runtime.failure, null);
});

test("reports an Electron host exit after startup", async context => {
  const appRoot = await mkdtemp(join(tmpdir(), "codex-web-web-runtime-"));
  context.after(() => rm(appRoot, { recursive: true, force: true }));

  const hostExit = Promise.withResolvers();
  let hostStopped = false;
  let relayClosed = false;
  let serverClosed = false;
  const runtime = await startWebRuntime({
    appRoot,
    startServer: async () => ({
      url: "https://codex.example.test/?cap=fixture",
      hostPageUrl: "http://127.0.0.1:4310/__codex_host?cap=fixture",
      origin: "http://127.0.0.1:4310",
      capability: "fixture",
      httpServer: {},
      setBootstrap() {},
      isRequestOriginAllowed() {
        return true;
      },
      async close() {
        serverClosed = true;
      },
    }),
    createRelay: () => ({
      hostUrl: "ws://127.0.0.1:4310/__codex_bridge?role=host&cap=fixture",
      waitForHost: async () => {},
      async close() {
        relayClosed = true;
      },
    }),
    startHost: async () => ({
      exited: hostExit.promise,
      async stop() {
        hostStopped = true;
      },
    }),
  });

  hostExit.resolve({ code: 1, signal: null, output: "host failure" });

  const failure = await runtime.failure;
  assert.match(
    failure.message,
    /application host exited unexpectedly with code 1: host failure/,
  );

  await runtime.close();
  assert.equal(hostStopped, true);
  assert.equal(relayClosed, true);
  assert.equal(serverClosed, true);
});
