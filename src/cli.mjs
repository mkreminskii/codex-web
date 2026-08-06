#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildWebWrapper } from "./build.mjs";
import { installUserService } from "./deploy.mjs";
import {
  isLoopbackHost,
  normalizeHost,
  normalizePort,
} from "./network-options.mjs";
import { startWebRuntime } from "./web-runtime.mjs";

const usage = `Usage:
  codex-web build [Codex.dmg]
  codex-web serve [--host HOST] [--port PORT]
  codex-web deploy [--host HOST] [--port PORT]`;

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function writeError(stderr, error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`codex-web: ${message}\n`);
}

function parseNetworkArguments(arguments_) {
  let host = "127.0.0.1";
  let port = 0;
  let hostSeen = false;
  let portSeen = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    let name;
    let value;
    if (argument === "--host" || argument === "--port") {
      name = argument;
      value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
    } else if (argument.startsWith("--host=")) {
      name = "--host";
      value = argument.slice("--host=".length);
    } else if (argument.startsWith("--port=")) {
      name = "--port";
      value = argument.slice("--port=".length);
    } else {
      throw new Error(`Unknown serve option: ${argument}`);
    }

    if (name === "--host") {
      if (hostSeen) {
        throw new Error("--host can be supplied only once");
      }
      hostSeen = true;
      host = normalizeHost(value);
    } else {
      if (portSeen) {
        throw new Error("--port can be supplied only once");
      }
      portSeen = true;
      port = normalizePort(value);
    }
  }

  return { host, port };
}

function writeNetworkWarning(stderr, host) {
  if (!isLoopbackHost(host)) {
    stderr.write(
      "codex-web: warning: non-loopback HTTP exposes the browser capability and Codex traffic without encryption\n",
    );
  }
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
    deploy = installUserService,
    resolveAppRoot = () => realpath(join(projectRoot, "dist", "current")),
    startRuntime = startWebRuntime,
    waitForShutdownImpl = waitForShutdown,
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
      const { host, port } = parseNetworkArguments(arguments_);
      writeNetworkWarning(stderr, host);
      const appRoot = await resolveAppRoot();
      const runtime = await startRuntime({ appRoot, host, port });
      stdout.write(`Open ${runtime.url}\n`);
      await waitForShutdownImpl();
      await runtime.close();
      return 0;
    }

    if (command === "deploy") {
      const { host, port } = parseNetworkArguments(arguments_);
      writeNetworkWarning(stderr, host);
      const buildResult = await build({ root: projectRoot });
      stdout.write(`Built codex-web at ${buildResult.outputRoot}\n`);
      if (buildResult.warning !== null) {
        stderr.write(`7z warning: ${buildResult.warning}\n`);
      }
      const deployed = await deploy({ projectRoot, host, port });
      stdout.write(`Installed ${deployed.servicePath}\n`);
      stdout.write(`Open ${deployed.url}\n`);
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
