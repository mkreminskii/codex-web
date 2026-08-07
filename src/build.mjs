
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractWebWrapper,
  promoteCandidate,
} from "./extract-build.mjs";
import { stageElectronRuntime } from "./electron-runtime.mjs";
import { runPhase } from "./progress.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function assertManagedTemporaryRoot(workRoot, temporaryRoot) {
  const pathFromWork = relative(workRoot, temporaryRoot);
  if (
    pathFromWork === ".." ||
    pathFromWork.startsWith(`..${sep}`) ||
    pathFromWork === ""
  ) {
    throw new Error("Runtime build temporary directory is outside its owner");
  }
}

export async function buildWebWrapper({
  dmgPath,
  root = projectRoot,
  fetchImpl = fetch,
  stageRuntime = stageElectronRuntime,
  progress,
} = {}) {
  const workRoot = join(root, "work");
  const distRoot = join(root, "dist");
  const temporaryRoot = await runPhase(
    progress,
    "prepare build workspace",
    async () => {
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      await mkdir(distRoot, { recursive: true });
      return mkdtemp(join(workRoot, "runtime-build-"));
    },
  );
  const candidateRoot = join(temporaryRoot, "candidate");

  try {
    const extracted = await extractWebWrapper({
      dmgPath,
      root,
      fetchImpl,
      destination: candidateRoot,
      progress,
    });
    const packageJson = await runPhase(
      progress,
      "read upstream package metadata",
      async () =>
        JSON.parse(
          await readFile(
            join(candidateRoot, "upstream", "package.json"),
            "utf8",
          ),
        ),
    );
    const patches = await runPhase(progress, "apply upstream patches", async () => {
      const { applyUpstreamWebPatches } = await import("./upstream-patches.mjs");
      return applyUpstreamWebPatches(join(candidateRoot, "upstream"));
    });
    const runtime = await runPhase(progress, "stage Electron runtime", () =>
      stageRuntime({
        upstreamRoot: join(candidateRoot, "upstream"),
        candidateRoot,
        cacheRoot: join(workRoot, "electron-cache"),
        packageJson,
        progress,
      }),
    );

    const manifest = {
      ...extracted.manifest,
      electronVersion: runtime.electronVersion,
      runtimePlatform: runtime.platform,
      runtimeArch: runtime.arch,
      patches,
    };
    await runPhase(progress, "write build manifest", () =>
      writeFile(
        join(candidateRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    );

    const buildId = [
      manifest.sourceSha256.slice(0, 16),
      runtime.platform,
      runtime.arch,
      runtime.electronVersion,
      Date.now(),
    ].join("-");
    const outputRoot = await runPhase(progress, "promote build", () =>
      promoteCandidate(candidateRoot, distRoot, buildId),
    );

    return {
      outputRoot,
      manifest,
      warning: extracted.warning,
    };
  } finally {
    await runPhase(progress, "clean build workspace", async () => {
      const resolvedWorkRoot = await realpath(workRoot);
      const resolvedTemporaryRoot = await realpath(temporaryRoot).catch(() => null);
      if (resolvedTemporaryRoot !== null) {
        assertManagedTemporaryRoot(resolvedWorkRoot, resolvedTemporaryRoot);
        await rm(resolvedTemporaryRoot, { recursive: true, force: true });
      }
    });
  }
}
