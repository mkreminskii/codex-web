import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll, listPackage } from "@electron/asar";
import { runBufferedCommand } from "./process-runner.mjs";
import { reportProgress, runPhase } from "./progress.mjs";

export const OFFICIAL_DMG_URL =
  "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function assertWithin(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  ) {
    return;
  }
  throw new Error(`${label} escaped its managed directory`);
}

async function pathIsFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const file = await import("node:fs").then(({ createReadStream }) =>
    createReadStream(path),
  );
  for await (const chunk of file) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function responseLastModified(response, action) {
  const lastModified = response.headers.get("last-modified");
  if (lastModified === null || lastModified.trim() === "") {
    throw new Error(`The official DMG ${action} has no Last-Modified header`);
  }
  return lastModified;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function inspectCurrentDmg(fetchImpl) {
  const response = await fetchImpl(OFFICIAL_DMG_URL, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.url.startsWith("https://")) {
    throw new Error(`Could not inspect the official DMG: HTTP ${response.status}`);
  }
  return { lastModified: responseLastModified(response, "response") };
}

async function readCachedDmg(cacheRoot, freshness) {
  const dmgPath = join(cacheRoot, "ChatGPT.dmg");
  const metadataPath = join(cacheRoot, "ChatGPT.dmg.json");
  if (!(await pathIsFile(dmgPath))) {
    return null;
  }

  try {
    const metadata = await readJson(metadataPath);
    if (
      metadata.schemaVersion !== 1 ||
      metadata.lastModified !== freshness.lastModified ||
      typeof metadata.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sourceSha256)
    ) {
      return null;
    }
    if ((await hashFile(dmgPath)) !== metadata.sourceSha256) {
      return null;
    }
    return {
      dmgPath,
      lastModified: metadata.lastModified,
      sourceSha256: metadata.sourceSha256,
    };
  } catch {
    return null;
  }
}

async function downloadCurrentDmg(cacheRoot, fetchImpl, freshness) {
  const dmgPath = join(cacheRoot, "ChatGPT.dmg");
  const metadataPath = join(cacheRoot, "ChatGPT.dmg.json");
  const partPath = `${dmgPath}.part-${randomUUID()}`;

  try {
    const response = await fetchImpl(OFFICIAL_DMG_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || response.body === null || !response.url.startsWith("https://")) {
      throw new Error(`Could not download the official DMG: HTTP ${response.status}`);
    }
    const downloadedLastModified = responseLastModified(response, "download");
    if (downloadedLastModified !== freshness.lastModified) {
      throw new Error("The official DMG changed during download");
    }

    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partPath, { flags: "wx", mode: 0o600 }),
    );
    if (!(await pathIsFile(partPath)) || (await stat(partPath)).size === 0) {
      throw new Error("The official DMG download was empty");
    }

    const sourceSha256 = await hashFile(partPath);
    await rename(partPath, dmgPath);
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          lastModified: freshness.lastModified,
          sourceSha256,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return {
      dmgPath,
      lastModified: freshness.lastModified,
      sourceSha256,
    };
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }
}

async function readExtractedCache(cacheRoot, source) {
  const extractedRoot = join(cacheRoot, "extracted");
  try {
    const metadata = await readJson(join(extractedRoot, "metadata.json"));
    if (
      metadata.schemaVersion !== 1 ||
      metadata.lastModified !== source.lastModified ||
      metadata.sourceSha256 !== source.sourceSha256 ||
      (metadata.warning !== null && typeof metadata.warning !== "string")
    ) {
      return null;
    }

    const upstreamRoot = join(extractedRoot, "upstream");
    const application = await validateExtractedApp(upstreamRoot);
    return { upstreamRoot, application, warning: metadata.warning };
  } catch {
    return null;
  }
}

async function writeExtractedCache(cacheRoot, upstreamRoot, source, warning) {
  const extractedRoot = join(cacheRoot, "extracted");
  const partRoot = join(cacheRoot, `.extracted-part-${randomUUID()}`);

  try {
    await mkdir(partRoot, { mode: 0o700 });
    await cp(upstreamRoot, join(partRoot, "upstream"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(partRoot, "metadata.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          lastModified: source.lastModified,
          sourceSha256: source.sourceSha256,
          warning,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rm(extractedRoot, { recursive: true, force: true });
    await rename(partRoot, extractedRoot);
  } catch (error) {
    await rm(partRoot, { recursive: true, force: true });
    throw error;
  }
}

async function resolveLocalDmg(inputPath) {
  const dmgPath = resolve(inputPath);
  if (!(await pathIsFile(dmgPath))) {
    throw new Error(`DMG is missing or unreadable: ${dmgPath}`);
  }
  return {
    dmgPath,
    lastModified: null,
    sourceSha256: await hashFile(dmgPath),
  };
}

async function runSevenZip(dmgPath, extractRoot) {
  const result = await runBufferedCommand(
    "7z",
    ["x", "-y", "-snl", dmgPath, `-o${extractRoot}`],
    {
      allowNonZero: true,
      label: "extract DMG",
      timeoutMs: 600_000,
    },
  );
  return { exitCode: result.code, output: result.output };
}

async function findAppBundles(root, depth = 0) {
  if (depth > 4) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.name.endsWith(".app")) {
      results.push(path);
      continue;
    }
    results.push(...(await findAppBundles(path, depth + 1)));
  }
  return results;
}

async function findUpstreamAsar(extractRoot) {
  const appBundles = await findAppBundles(extractRoot);
  const candidates = [];
  for (const appBundle of appBundles) {
    const asarPath = join(appBundle, "Contents", "Resources", "app.asar");
    if (await pathIsFile(asarPath)) {
      candidates.push(asarPath);
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      `Expected one upstream app.asar in the DMG, found ${candidates.length}`,
    );
  }
  return candidates[0];
}

async function validateExtractedApp(upstreamRoot) {
  const webviewIndex = join(upstreamRoot, "webview", "index.html");
  const packagePath = join(upstreamRoot, "package.json");

  if (!(await pathIsFile(webviewIndex))) {
    throw new Error("Upstream ASAR layout changed: webview/index.html is missing");
  }
  if (!(await pathIsFile(packagePath))) {
    throw new Error("Upstream ASAR layout changed: package.json is missing");
  }

  const packageJson = await readJson(packagePath);
  return {
    applicationName: packageJson.productName ?? packageJson.name ?? null,
    applicationVersion: packageJson.version ?? null,
  };
}

async function extractDmgToUpstream(
  sourceDmg,
  extractRoot,
  upstreamRoot,
  progress,
) {
  await runPhase(progress, "prepare extraction workspace", async () => {
    await mkdir(extractRoot);
    await mkdir(upstreamRoot, { recursive: true });
  });

  const sevenZip = await runPhase(progress, "extract DMG", async () => {
    const result = await runSevenZip(sourceDmg, extractRoot);
    if (
      result.exitCode !== 0 &&
      !result.output.includes("Dangerous link path was ignored")
    ) {
      throw new Error(
        `7z failed with exit code ${result.exitCode}: ${result.output.trim()}`,
      );
    }
    return result;
  });
  const asarPath = await runPhase(
    progress,
    "locate upstream app.asar",
    () => findUpstreamAsar(extractRoot),
  );
  const application = await runPhase(
    progress,
    "extract upstream app.asar",
    async () => {
      const archiveFiles = listPackage(asarPath, { isPack: false });
      if (!archiveFiles.includes("/webview/index.html")) {
        throw new Error(
          "Upstream ASAR layout changed: webview/index.html is absent",
        );
      }

      extractAll(asarPath, upstreamRoot);
      const unpackedRoot = `${asarPath}.unpacked`;
      const unpackedEntry = await lstat(unpackedRoot).catch(() => null);
      if (unpackedEntry?.isDirectory()) {
        await cp(unpackedRoot, upstreamRoot, {
          recursive: true,
          force: true,
        });
      }
      return validateExtractedApp(upstreamRoot);
    },
  );

  return {
    application,
    warning: sevenZip.exitCode === 0 ? null : sevenZip.output.trim(),
  };
}

export async function promoteCandidate(candidateRoot, distRoot, buildId) {
  const buildsRoot = join(distRoot, "builds");
  const finalRoot = join(buildsRoot, buildId);
  await mkdir(buildsRoot, { recursive: true });
  await rename(candidateRoot, finalRoot);

  const temporaryLink = join(distRoot, `.current-${randomUUID()}`);
  await symlink(join("builds", buildId), temporaryLink, "dir");
  await rename(temporaryLink, join(distRoot, "current"));
  return finalRoot;
}

export async function extractWebWrapper({
  dmgPath,
  root = projectRoot,
  fetchImpl = fetch,
  destination,
  progress,
} = {}) {
  const workRoot = join(root, "work");
  const distRoot = join(root, "dist");
  const temporaryRoot = await runPhase(
    progress,
    "prepare upstream workspace",
    async () => {
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      await mkdir(distRoot, { recursive: true });
      return mkdtemp(join(workRoot, "build-"));
    },
  );
  const extractRoot = join(temporaryRoot, "dmg");
  const candidateRoot = join(temporaryRoot, "candidate");
  const upstreamRoot = join(candidateRoot, "upstream");

  try {
    await mkdir(candidateRoot, { recursive: true });

    let source;
    let extraction;
    if (dmgPath === undefined) {
      const cacheRoot = join(workRoot, "upstream");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });

      const freshness = await runPhase(
        progress,
        "inspect remote DMG",
        () => inspectCurrentDmg(fetchImpl),
      );
      const cachedSource = await runPhase(
        progress,
        "verify DMG cache",
        () => readCachedDmg(cacheRoot, freshness),
      );
      reportProgress(
        progress,
        cachedSource === null
          ? "DMG cache is stale or incomplete"
          : "DMG cache is current",
      );
      const cachedExtraction =
        cachedSource === null
          ? null
          : await runPhase(
              progress,
              "verify extracted application cache",
              () => readExtractedCache(cacheRoot, cachedSource),
            );
      reportProgress(
        progress,
        cachedExtraction === null
          ? "extracted application cache is stale or incomplete"
          : "extracted application cache is current",
      );

      if (cachedSource !== null && cachedExtraction !== null) {
        await runPhase(progress, "reuse extracted application", () =>
          cp(cachedExtraction.upstreamRoot, upstreamRoot, {
            recursive: true,
            force: true,
          }),
        );
        source = cachedSource;
        extraction = cachedExtraction;
      } else {
        source = await runPhase(
          progress,
          "download current DMG",
          () => downloadCurrentDmg(cacheRoot, fetchImpl, freshness),
        );
        extraction = await extractDmgToUpstream(
          source.dmgPath,
          extractRoot,
          upstreamRoot,
          progress,
        );
        await runPhase(progress, "write extracted application cache", () =>
          writeExtractedCache(
            cacheRoot,
            upstreamRoot,
            source,
            extraction.warning,
          ),
        );
      }
    } else {
      source = await runPhase(
        progress,
        "verify local DMG",
        () => resolveLocalDmg(dmgPath),
      );
      extraction = await extractDmgToUpstream(
        source.dmgPath,
        extractRoot,
        upstreamRoot,
        progress,
      );
    }

    const manifest = {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      sourceSha256: source.sourceSha256,
      ...(source.lastModified === null
        ? {}
        : { sourceLastModified: source.lastModified }),
      ...extraction.application,
    };
    await runPhase(progress, "write upstream manifest", () =>
      writeFile(
        join(candidateRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    );

    const buildId = `${source.sourceSha256.slice(0, 16)}-${Date.now()}`;
    const outputRoot = await runPhase(
      progress,
      "stage extracted application",
      () =>
        destination === undefined
          ? promoteCandidate(candidateRoot, distRoot, buildId)
          : rename(candidateRoot, destination).then(() => destination),
    );
    return {
      outputRoot,
      manifest,
      warning: extraction.warning,
    };
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await runPhase(progress, "clean upstream workspace", async () => {
      if (await lstat(temporaryRoot).catch(() => null)) {
        const resolvedTemporaryRoot = await realpath(temporaryRoot);
        const resolvedWorkRoot = await realpath(workRoot);
        assertWithin(
          resolvedWorkRoot,
          resolvedTemporaryRoot,
          "Temporary build",
        );
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
}
