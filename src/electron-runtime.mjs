import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { download } from "@electron/get";
import { rebuild } from "@electron/rebuild";

import { rebuildNativeModules } from "./native-modules.mjs";

function requiredElectronVersion(packageJson) {
  const version =
    packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("Upstream package metadata has no exact Electron version");
  }
  return version;
}

async function run(command, arguments_, options = {}) {
  const output = [];
  const child = spawn(command, arguments_, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => output.push(chunk));
  }

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(
      `${command} failed with exit code ${exitCode}: ${output.join("").trim()}`,
    );
  }
}

async function isExecutableFile(path) {
  try {
    const entry = await stat(path);
    return entry.isFile() && (entry.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function stageElectronRuntime({
  upstreamRoot,
  candidateRoot,
  cacheRoot,
  packageJson,
  arch = process.arch,
  platform = process.platform,
  downloadImpl = download,
  rebuildImpl = rebuild,
  rebuildNativeModulesImpl = rebuildNativeModules,
  extractZip = async (archive, destination) => {
    await run("unzip", ["-q", archive, "-d", destination]);
  },
}) {
  if (platform !== "linux") {
    throw new Error(`codex-web currently supports only Linux hosts, not ${platform}`);
  }

  const electronVersion = requiredElectronVersion(packageJson);
  const runtimeRoot = join(candidateRoot, "runtime");
  await mkdir(runtimeRoot);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });

  const archivePath = await downloadImpl(electronVersion, {
    cacheRoot,
    tempDirectory: cacheRoot,
  });
  await extractZip(archivePath, runtimeRoot);

  const electronPath = join(runtimeRoot, "electron");
  await chmod(electronPath, 0o755);
  if (!(await isExecutableFile(electronPath))) {
    throw new Error("The downloaded Electron runtime has no executable");
  }

  await rebuildNativeModulesImpl({
    buildPath: upstreamRoot,
    electronVersion,
    arch,
    platform,
    rebuildImpl,
  });

  return {
    electronPath,
    electronVersion,
    platform,
    arch,
  };
}

