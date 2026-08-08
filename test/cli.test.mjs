import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.mjs";

function capture() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

test("entry point reports its command surface", async () => {
  const stdout = capture();
  const stderr = capture();

  const exitCode = await run([], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 2);
  assert.match(stdout.read(), /codex-web build \[Codex\.dmg\]/);
  assert.match(stdout.read(), /codex-web serve/);
  assert.match(stdout.read(), /codex-web serve \[--host HOST\] \[--port PORT\]/);
  assert.match(stdout.read(), /codex-web deploy \[--host HOST\] \[--port PORT\]/);
  assert.equal(stderr.read(), "");
});

test("build delegates an optional DMG path", async () => {
  const stdout = capture();
  const calls = [];

  const exitCode = await run(["build", "/tmp/Codex.dmg"], {
    stdout: stdout.stream,
    build: async (options) => {
      calls.push(options);
      return {
        outputRoot: "/tmp/output",
        warning: null,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dmgPath, "/tmp/Codex.dmg");
  assert.match(stdout.read(), /Built codex-web at \/tmp\/output/);
});

test("entry point reports command failures", async () => {
  const stderr = capture();

  const exitCode = await run(["build"], {
    stderr: stderr.stream,
    build: async () => {
      throw new Error("upstream layout changed");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr.read(), "codex-web: upstream layout changed\n");
});

test("serve forwards explicit host and port options", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  let closed = false;

  const exitCode = await run(
    [
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      "8080",
      "--public-url",
      "https://codex.example.com",
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      resolveAppRoot: async () => "/tmp/generated-app",
      startRuntime: async options => {
        calls.push(options);
        return {
          url: "https://codex.example.com/?cap=fixture",
          failure: new Promise(() => {}),
          async close() {
            closed = true;
          },
        };
      },
      waitForShutdownImpl: async () => {},
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      appRoot: "/tmp/generated-app",
      host: "0.0.0.0",
      port: 8080,
      publicUrl: "https://codex.example.com",
    },
  ]);
  assert.equal(closed, true);
  assert.ok(stdout.read().includes("Open https://codex.example.com"));
  assert.match(stderr.read(), /non-loopback HTTP/);
});

test("serve exits when the Electron host fails after startup", async () => {
  const stdout = capture();
  const stderr = capture();
  let closed = false;

  const exitCode = await run(["serve"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    resolveAppRoot: async () => "/tmp/generated-app",
    startRuntime: async () => ({
      url: "https://codex.example.test/?cap=fixture",
      failure: Promise.resolve(new Error("Electron host exited")),
      async close() {
        closed = true;
      },
    }),
    waitForShutdownImpl: () => new Promise(() => {}),
  });

  assert.equal(exitCode, 1);
  assert.equal(closed, true);
  assert.equal(stderr.read(), "codex-web: Electron host exited\n");
});

test("serve rejects an invalid port before startup", async () => {
  const stderr = capture();
  let started = false;

  const exitCode = await run(["serve", "--port", "65536"], {
    stderr: stderr.stream,
    startRuntime: async () => {
      started = true;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(started, false);
  assert.equal(stderr.read(), "codex-web: Invalid port: 65536\n");
});

test("deploy builds and installs a user service with network options", async () => {
  const stdout = capture();
  const stderr = capture();
  const buildCalls = [];
  const deployCalls = [];

  const exitCode = await run(
    [
      "deploy",
      "--host=192.0.2.10",
      "--port=8443",
      "--public-url=https://codex.example.com",
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      build: async options => {
        assert.match(stdout.read(), /deploy: start/);
        buildCalls.push(options);
        options.progress({
          status: "started",
          phase: "inspect remote DMG",
        });
        options.progress({
          status: "completed",
          phase: "inspect remote DMG",
          elapsedMs: 1_250,
        });
        return { outputRoot: "/tmp/output", warning: null };
      },
      deploy: async options => {
        deployCalls.push(options);
        options.progress({
          status: "info",
          message: "wait for service URL (attempt 1/30)",
        });
        return {
          servicePath: "/tmp/codex-web.service",
          url: "https://codex.example.com/?cap=fixture",
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].dmgPath, undefined);
  assert.deepEqual(deployCalls, [
    {
      projectRoot: buildCalls[0].root,
      host: "192.0.2.10",
      port: 8443,
      publicUrl: "https://codex.example.com",
      progress: buildCalls[0].progress,
    },
  ]);
  assert.ok(stdout.read().includes("Installed /tmp/codex-web.service"));
  assert.ok(stdout.read().includes("Open https://codex.example.com"));
  assert.match(stderr.read(), /non-loopback HTTP/);
  assert.match(stdout.read(), /deploy: inspect remote DMG\.\.\./);
  assert.match(stdout.read(), /deploy: inspect remote DMG completed \(1\.3s\)/);
  assert.match(stdout.read(), /deploy: wait for service URL \(attempt 1\/30\)/);
  assert.match(stdout.read(), /deploy: complete/);
});
