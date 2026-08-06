import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";

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

export async function startApplicationHost({
  appRoot,
  relayUrl,
  rendererUrl,
  environment = process.env,
}) {
  const electronPath = join(appRoot, "runtime", "electron");
  const upstreamRoot = join(appRoot, "upstream");
  await requireExecutable(electronPath);
  const codexCliPath = await resolveCodexCli(environment);

  const output = [];
  const child = spawn(
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
        ...environment,
        CODEX_CLI_PATH: codexCliPath,
        CODEX_WEB_HEADLESS: "1",
        CODEX_WEB_RELAY_URL: relayUrl,
        ELECTRON_RENDERER_URL: rendererUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      while (output.join("").length > 128 * 1024) {
        output.shift();
      }
    });
  }

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
        output: output.join("").trim(),
      });
    });
  });

  return {
    exited,
    output: () => output.join("").trim(),
    async stop() {
      if (settled) {
        await exited;
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
      ]);
      if (!settled) {
        child.kill("SIGKILL");
      }
      await exited;
    },
  };
}

