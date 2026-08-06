#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildWebWrapper } from "./build.mjs";
import { startWebRuntime } from "./web-runtime.mjs";

const usage = `Usage:
  codex-web build [Codex.dmg]
  codex-web serve`;

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function writeError(stderr, error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`codex-web: ${message}\n`);
}

async function waitForShutdown() {
  await new Promise((resolveShutdown) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveShutdown();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function run(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    build = buildWebWrapper,
    startRuntime = startWebRuntime,
  } = {},
) {
  const [command, ...arguments_] = argv;

  try {
    if (command === undefined) {
      stdout.write(`${usage}\n`);
      return 2;
    }

    if (command === "build") {
      if (arguments_.length > 1) {
        stderr.write(`${usage}\n`);
        return 2;
      }
      const result = await build({ dmgPath: arguments_[0], root: projectRoot });
      stdout.write(`Built codex-web at ${result.outputRoot}\n`);
      if (result.warning !== null) {
        stderr.write(`7z warning: ${result.warning}\n`);
      }
      return 0;
    }

    if (command === "serve") {
      if (arguments_.length !== 0) {
        stderr.write(`${usage}\n`);
        return 2;
      }
      const appRoot = await realpath(join(projectRoot, "dist", "current"));
      const runtime = await startRuntime({ appRoot });
      stdout.write(`Open ${runtime.url}\n`);
      await waitForShutdown();
      await runtime.close();
      return 0;
    }

    stderr.write(`Unknown command: ${command}\n${usage}\n`);
    return 2;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = await run(process.argv.slice(2));
}
