import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { download } from "@electron/get";

import { rebuildNativeModules } from "./native-modules.mjs";
import { runBufferedCommand } from "./process-runner.mjs";
import { runPhase } from "./progress.mjs";

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
  rebuildImpl,
  rebuildNativeModulesImpl = rebuildNativeModules,
  extractZip = (archive, destination) =>
    runBufferedCommand(
      "unzip",
      ["-q", archive, "-d", destination],
      {
        label: "extract Electron runtime",
        timeoutMs: 600_000,
      },
    ),
  progress,
}) {
  if (platform !== "linux") {
    throw new Error(`codex-web currently supports only Linux hosts, not ${platform}`);
  }

  const electronVersion = requiredElectronVersion(packageJson);
  const runtimeRoot = join(candidateRoot, "runtime");
  await runPhase(progress, "prepare Electron runtime workspace", async () => {
    await mkdir(runtimeRoot);
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  });

  const archivePath = await runPhase(
    progress,
    "download or reuse Electron runtime",
    () =>
      downloadImpl(electronVersion, {
        cacheRoot,
        tempDirectory: cacheRoot,
        downloadOptions: {
          signal: AbortSignal.timeout(600_000),
        },
      }),
  );
  await runPhase(progress, "extract Electron runtime", () =>
    extractZip(archivePath, runtimeRoot),
  );

  const electronPath = join(runtimeRoot, "electron");
  await runPhase(progress, "validate Electron runtime", async () => {
    await chmod(electronPath, 0o755);
    if (!(await isExecutableFile(electronPath))) {
      throw new Error("The downloaded Electron runtime has no executable");
    }
  });

  await runPhase(progress, "prepare native modules", () =>
    rebuildNativeModulesImpl({
      buildPath: upstreamRoot,
      electronVersion,
      arch,
      platform,
      rebuildImpl,
      progress,
    }),
  );

  return {
    electronPath,
    electronVersion,
    platform,
    arch,
  };
}
