import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildNativeModules } from "../src/native-modules.mjs";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("stages the exact upstream Parcel watcher with its Linux binding", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-native-modules-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const buildPath = join(root, "upstream");
  await mkdir(join(buildPath, "node_modules", "better-sqlite3"), {
    recursive: true,
  });
  await mkdir(join(buildPath, "node_modules", "node-pty"), {
    recursive: true,
  });
  await writeJson(join(buildPath, "package.json"), {
    dependencies: {
      "@parcel/watcher": "2.5.6",
    },
  });
  await writeJson(
    join(buildPath, "node_modules", "better-sqlite3", "package.json"),
    { version: "12.9.0" },
  );
  await writeJson(join(buildPath, "node_modules", "node-pty", "package.json"), {
    version: "1.1.0",
  });

  const commands = [];
  let rebuildOptions;
  await rebuildNativeModules({
    buildPath,
    electronVersion: "41.0.0",
    arch: "x64",
    platform: "linux",
    runCommand: async (command, args, options) => {
      commands.push({ command, args, options });
      const installedRoot = join(options.cwd, "node_modules");
      await mkdir(join(installedRoot, "better-sqlite3"), { recursive: true });
      await mkdir(join(installedRoot, "node-pty"), { recursive: true });

      const watcherRoot = join(installedRoot, "@parcel", "watcher");
      const bindingRoot = join(
        watcherRoot,
        "node_modules",
        "@parcel",
        "watcher-linux-x64-glibc",
      );
      await mkdir(bindingRoot, { recursive: true });
      await writeJson(join(watcherRoot, "package.json"), {
        main: "index.js",
        version: "2.5.6",
      });
      await writeFile(
        join(watcherRoot, "index.js"),
        'module.exports = require("@parcel/watcher-linux-x64-glibc");\n',
      );
      await writeJson(join(bindingRoot, "package.json"), {
        main: "index.js",
        version: "2.5.6",
      });
      await writeFile(
        join(bindingRoot, "index.js"),
        'module.exports = { platform: "linux-x64-glibc" };\n',
      );
    },
    rebuildImpl: async (options) => {
      rebuildOptions = options;
    },
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "npm");
  assert.ok(commands[0].args.includes("--install-strategy=nested"));
  assert.ok(commands[0].args.includes("@parcel/watcher@2.5.6"));
  assert.deepEqual(rebuildOptions.onlyModules, ["better-sqlite3", "node-pty"]);

  const requireFromWorker = createRequire(
    join(buildPath, ".vite", "build", "worker.js"),
  );
  assert.deepEqual(requireFromWorker("@parcel/watcher"), {
    platform: "linux-x64-glibc",
  });
});

