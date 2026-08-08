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
        exited: new Promise(() => {}),
        async stop() {},
      };
    },
  });

  assert.equal(hostOptions.rendererUrl, hostPageUrl);
  await runtime.close();
});

