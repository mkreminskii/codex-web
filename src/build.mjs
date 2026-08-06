
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
} = {}) {
  const workRoot = join(root, "work");
  const distRoot = join(root, "dist");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await mkdir(distRoot, { recursive: true });

  const temporaryRoot = await mkdtemp(join(workRoot, "runtime-build-"));
  const candidateRoot = join(temporaryRoot, "candidate");

  try {
    const extracted = await extractWebWrapper({
      dmgPath,
      root,
      fetchImpl,
      destination: candidateRoot,
    });
    const packageJson = JSON.parse(
      await readFile(join(candidateRoot, "upstream", "package.json"), "utf8"),
    );
    const { applyUpstreamWebPatches } = await import("./upstream-patches.mjs");
    const patches = await applyUpstreamWebPatches(join(candidateRoot, "upstream"));
    const runtime = await stageRuntime({
      upstreamRoot: join(candidateRoot, "upstream"),
      candidateRoot,
      cacheRoot: join(workRoot, "electron-cache"),
      packageJson,
    });

    const manifest = {
      ...extracted.manifest,
      electronVersion: runtime.electronVersion,
      runtimePlatform: runtime.platform,
      runtimeArch: runtime.arch,
      patches,
    };
    await writeFile(
      join(candidateRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const buildId = [
      manifest.sourceSha256.slice(0, 16),
      runtime.platform,
      runtime.arch,
      runtime.electronVersion,
      Date.now(),
    ].join("-");
    const outputRoot = await promoteCandidate(candidateRoot, distRoot, buildId);

    return {
      outputRoot,
      manifest,
      warning: extracted.warning,
    };
  } finally {
    const resolvedWorkRoot = await realpath(workRoot);
    const resolvedTemporaryRoot = await realpath(temporaryRoot).catch(() => null);
    if (resolvedTemporaryRoot !== null) {
      assertManagedTemporaryRoot(resolvedWorkRoot, resolvedTemporaryRoot);
      await rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}
