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

