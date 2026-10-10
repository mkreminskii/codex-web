import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startApplicationHost } from "../src/runtime-host.mjs";

function createChild({ autoClose = false, closeSignals = ["SIGTERM", "SIGKILL"], code = 0, stderr = "", stdout = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.kill = signal => {
    child.signals.push(signal);
    if (closeSignals.includes(signal)) {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, signal);
      });
    }
    return true;
  };
  if (autoClose) {
    queueMicrotask(() => {
      if (stdout !== "") child.stdout.write(stdout);
      if (stderr !== "") child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code, null);
    });
  }
  return child;
}

async function createApplicationRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "codex-web-runtime-host-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "upstream"));
  const electronPath = join(root, "runtime", "electron");
  const codexCliPath = join(root, "codex");
  await writeFile(electronPath, "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(codexCliPath, "#!/bin/sh\n", { mode: 0o755 });
  return { codexCliPath, electronPath, root };
}

test("reuses the app-server daemon through the upstream proxy", async context => {
  const { codexCliPath, electronPath, root } = await createApplicationRoot(context);
  let daemonChild;
  const electronChild = createChild();
  const calls = [];
  const environment = {
    CODEX_CLI_PATH: codexCliPath,
    CODEX_HOME: join(root, "codex home "),
    CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://chatgpt.example",
    CODEX_APP_SERVER_OPENAI_BASE_URL: "https://api.example",
  };

  const host = await startApplicationHost({
    appRoot: root,
    relayUrl: "ws://127.0.0.1/relay",
    rendererUrl: "http://127.0.0.1/renderer",
    environment,
    spawnProcess(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      if (calls.length === 1) {
        daemonChild = createChild({ autoClose: true });
        return daemonChild;
      }
      return electronChild;
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].arguments_, [
    "-c",
    "features.code_mode_host=true",
    "-c",
    "analytics.enabled=false",
    "-c",
    'chatgpt_base_url="https://chatgpt.example"',
    "-c",
    'openai_base_url="https://api.example"',
    "app-server",
    "daemon",
    "start",
  ]);
  assert.equal(calls[0].command, codexCliPath);
  assert.equal(calls[0].options.env.CODEX_HOME, environment.CODEX_HOME);
  assert.equal(calls[1].command, electronPath);
  assert.equal(calls[1].options.env.CODEX_CLI_PATH, codexCliPath);
  assert.match(
    calls[1].options.env.CODEX_WEB_APP_SERVER_PROXY_PATH,
    /src\/app-server-proxy\.mjs$/,
  );
  assert.equal(
    calls[1].options.env.CODEX_WEB_APP_SERVER_SOCKET_PATH,
    join(environment.CODEX_HOME, "app-server-control", "app-server-control.sock"),
  );
  assert.equal(calls[1].arguments_.includes("--disable-gpu"), true);
  assert.equal(calls[1].arguments_.includes("--disable-software-rasterizer"), true);
  assert.equal(
    calls[1].arguments_.includes(
      "--enable-features=PartitionAllocMemoryReclaimer",
    ),
    true,
  );
  assert.equal(calls[1].arguments_.includes("--use-angle=swiftshader"), false);

  await host.stop();
  assert.deepEqual(electronChild.signals, ["SIGTERM"]);
  assert.deepEqual(daemonChild.signals, []);
});

test("rejects a relative CODEX_HOME before starting a process", async context => {
  const { codexCliPath, root } = await createApplicationRoot(context);

  await assert.rejects(
    startApplicationHost({
      appRoot: root,
      relayUrl: "ws://127.0.0.1/relay",
      rendererUrl: "http://127.0.0.1/renderer",
      environment: {
        CODEX_CLI_PATH: codexCliPath,
        CODEX_HOME: "relative/codex-home",
      },
      spawnProcess() {
        throw new Error("a process must not start");
      },
    }),
    /CODEX_HOME must be an absolute path/,
  );
});

test("does not start Electron when the app-server daemon is unavailable", async context => {
  const { codexCliPath, root } = await createApplicationRoot(context);
  const calls = [];

  await assert.rejects(
    startApplicationHost({
      appRoot: root,
      relayUrl: "ws://127.0.0.1/relay",
      rendererUrl: "http://127.0.0.1/renderer",
      environment: { CODEX_CLI_PATH: codexCliPath },
      spawnProcess(command, arguments_, options) {
        calls.push({ command, arguments_, options });
        return createChild({
          autoClose: true,
          code: 1,
          stderr: "daemon fixture failure",
        });
      },
    }),
    /Could not start or reuse the Codex app-server daemon \(code 1\): daemon fixture failure/,
  );

  assert.equal(calls.length, 1);
});

test("bounds daemon startup and terminates an unresponsive startup command", async context => {
  const { codexCliPath, root } = await createApplicationRoot(context);
  const daemonChild = createChild({ closeSignals: [] });
  daemonChild.stderr.write("daemon startup stalled");
  const calls = [];

  await assert.rejects(
    startApplicationHost({
      appRoot: root,
      relayUrl: "ws://127.0.0.1/relay",
      rendererUrl: "http://127.0.0.1/renderer",
      environment: { CODEX_CLI_PATH: codexCliPath },
      daemonStartTimeoutMs: 1,
      daemonTerminationGraceMs: 1,
      spawnProcess(command, arguments_, options) {
        calls.push({ command, arguments_, options });
        return daemonChild;
      },
    }),
    /timed out after 1 ms\): daemon startup stalled/,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(daemonChild.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(daemonChild.unrefCalls, 1);
  assert.equal(daemonChild.stdout.destroyed, true);
  assert.equal(daemonChild.stderr.destroyed, true);
});
