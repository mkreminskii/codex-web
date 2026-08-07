import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageElectronRuntime } from "../src/electron-runtime.mjs";

test("stages the exact upstream Electron runtime and rebuild target", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-runtime-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const upstreamRoot = join(root, "upstream");
  const candidateRoot = join(root, "candidate");
  const cacheRoot = join(root, "cache");
  await mkdir(upstreamRoot);
  await mkdir(candidateRoot);
  await mkdir(cacheRoot);

  const calls = [];
  const progressEvents = [];
  const result = await stageElectronRuntime({
    upstreamRoot,
    candidateRoot,
    cacheRoot,
    packageJson: {
      devDependencies: { electron: "42.3.0" },
    },
    arch: "x64",
    platform: "linux",
    downloadImpl: async (version, options) => {
      calls.push({ kind: "download", version, options });
      return join(root, "electron.zip");
    },
    extractZip: async (_archive, destination) => {
      await writeFile(join(destination, "electron"), "fixture\n", {
        mode: 0o755,
      });
    },
    rebuildNativeModulesImpl: async (options) => {
      calls.push({ kind: "rebuild", options });
    },
    progress: event => progressEvents.push(event),
  });

  assert.equal(result.electronVersion, "42.3.0");
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["download", "rebuild"],
  );
  assert.equal(calls[0].version, "42.3.0");
  assert.equal(calls[1].options.buildPath, upstreamRoot);
  assert.equal(calls[1].options.platform, "linux");
  assert.equal(calls[1].options.arch, "x64");
  assert.ok(calls[0].options.downloadOptions.signal instanceof AbortSignal);
  assert.deepEqual(
    progressEvents
      .filter(event => event.status === "started")
      .map(event => event.phase),
    [
      "prepare Electron runtime workspace",
      "download or reuse Electron runtime",
      "extract Electron runtime",
      "validate Electron runtime",
      "prepare native modules",
    ],
  );
});

test("rejects a non-exact upstream Electron dependency", async () => {
  await assert.rejects(
    stageElectronRuntime({
      upstreamRoot: "/unused",
      candidateRoot: "/unused",
      cacheRoot: "/unused",
      packageJson: {
        devDependencies: { electron: "^42.3.0" },
      },
    }),
    /no exact Electron version/,
  );
});
