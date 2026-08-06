import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const appServerProxyPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "app-server-proxy.mjs",
);

function resolveCodexHome(environment) {
  const configured = environment.CODEX_HOME;
  if (configured === undefined || configured === "") {
    return join(homedir(), ".codex");
  }
  if (!isAbsolute(configured)) {
    throw new Error("CODEX_HOME must be an absolute path");
  }
  return configured;
}

function appServerSocketPath(codexHome) {
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

async function isExecutable(path) {
  const entry = await stat(path).catch(() => null);
  return entry !== null && entry.isFile() && (entry.mode & 0o111) !== 0;
}

async function requireExecutable(path) {
  if (!(await isExecutable(path))) {
    throw new Error(`Executable is missing or invalid: ${path}`);
  }
}

async function resolveCodexCli(environment) {
  const explicitPath = environment.CODEX_CLI_PATH?.trim();
  if (explicitPath) {
    await requireExecutable(explicitPath);
    return explicitPath;
  }

  for (const directory of environment.PATH?.split(":") ?? []) {
    if (directory === "") {
      continue;
    }
    const candidate = join(directory, "codex");
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Unable to locate the Codex CLI binary. Set CODEX_CLI_PATH or add codex to PATH.",
  );
}

const appServerUrlOverrides = [
  ["CODEX_APP_SERVER_CHATGPT_BASE_URL", "chatgpt_base_url"],
  ["CODEX_APP_SERVER_OPENAI_BASE_URL", "openai_base_url"],
];

function collectOutput(child) {
  const output = [];
  let outputLength = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      outputLength += chunk.length;
      while (outputLength > 128 * 1024) {
        outputLength -= output.shift().length;
      }
    });
  }
  return () => output.join("").trim();
}

export function appServerDaemonArguments(environment) {
  const arguments_ = ["-c", "features.code_mode_host=true"];
  for (const [environmentName, configKey] of appServerUrlOverrides) {
    const value = environment[environmentName]?.trim();
    if (value) {
      arguments_.push("-c", `${configKey}=${JSON.stringify(value)}`);
    }
  }
  arguments_.push("app-server", "daemon", "start");
  return arguments_;
}

async function ensureAppServerDaemon({
  codexCliPath,
  environment,
  spawnProcess,
  timeoutMs,
  terminationGraceMs,
}) {
  const arguments_ = appServerDaemonArguments(environment);
  const child = spawnProcess(codexCliPath, arguments_, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  let timedOut = false;
  let finalDeadlineExpired = false;
  let timeout;
  let terminationTimeout;
  let finalDeadline;
  const result = await new Promise((resolve, reject) => {
    child.once("error", error => {
      if (!finalDeadlineExpired) {
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!finalDeadlineExpired) {
        resolve({ code, signal });
      }
    });
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      terminationTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        finalDeadline = setTimeout(() => {
          finalDeadlineExpired = true;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref?.();
          resolve({ code: null, signal: "SIGKILL" });
        }, terminationGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);
  }).finally(() => {
    clearTimeout(timeout);
    clearTimeout(terminationTimeout);
    clearTimeout(finalDeadline);
  });
  const detail = output();
  if (timedOut) {
    throw new Error(
      `Could not start or reuse the Codex app-server daemon (timed out after ${timeoutMs} ms)${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  if (result.code !== 0) {
    const status =
      result.code === null ? `signal ${result.signal}` : `code ${result.code}`;
    throw new Error(
      `Could not start or reuse the Codex app-server daemon (${status})${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

export async function startApplicationHost({
  appRoot,
  relayUrl,
  rendererUrl,
  environment = process.env,
  spawnProcess = spawn,
  daemonStartTimeoutMs = 10_000,
  daemonTerminationGraceMs = 1_000,
}) {
  const electronPath = join(appRoot, "runtime", "electron");
  const upstreamRoot = join(appRoot, "upstream");
  await requireExecutable(electronPath);
  await requireExecutable(appServerProxyPath);
  const codexHome = resolveCodexHome(environment);
  const hostEnvironment = { ...environment, CODEX_HOME: codexHome };
  const codexCliPath = await resolveCodexCli(hostEnvironment);
  await ensureAppServerDaemon({
    codexCliPath,
    environment: hostEnvironment,
    spawnProcess,
    timeoutMs: daemonStartTimeoutMs,
    terminationGraceMs: daemonTerminationGraceMs,
  });

  const child = spawnProcess(
    electronPath,
    [
      "--no-sandbox",
      "--headless",
      "--use-angle=swiftshader",
      "--ozone-platform=headless",
      upstreamRoot,
    ],
    {
      env: {
        ...hostEnvironment,
        CODEX_CLI_PATH: codexCliPath,
        CODEX_WEB_APP_SERVER_PROXY_PATH: appServerProxyPath,
        CODEX_WEB_APP_SERVER_SOCKET_PATH: appServerSocketPath(codexHome),
        CODEX_WEB_HEADLESS: "1",
        CODEX_WEB_RELAY_URL: relayUrl,
        ELECTRON_RENDERER_URL: rendererUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectOutput(child);

  let settled = false;
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      settled = true;
      rejectExit(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      resolveExit({
        code,
        signal,
        output: output(),
      });
    });
  });

  return {
    exited,
    output,
    async stop() {
      if (settled) {
        await exited;
        return;
      }
      child.kill("SIGTERM");
      let stopTimeout;
      await Promise.race([
        exited,
        new Promise(resolveTimeout => {
          stopTimeout = setTimeout(resolveTimeout, 5_000);
        }),
      ]);
      clearTimeout(stopTimeout);
      if (!settled) {
        child.kill("SIGKILL");
      }
      await exited;
    },
  };
}
