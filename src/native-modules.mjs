import { createRequire } from "node:module";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBufferedCommand } from "./process-runner.mjs";
import { runPhase } from "./progress.mjs";

const electronRebuildCli = fileURLToPath(
  new URL("../node_modules/@electron/rebuild/lib/cli.js", import.meta.url),
);

async function readModuleVersion(upstreamRoot, moduleName) {
  const packagePath = join(
    upstreamRoot,
    "node_modules",
    moduleName,
    "package.json",
  );
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (
    typeof packageJson.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)
  ) {
    throw new Error(`Upstream ${moduleName} has no exact package version`);
  }
  return packageJson.version;
}

async function readDeclaredModuleVersion(upstreamRoot, moduleName) {
  const packageJson = JSON.parse(
    await readFile(join(upstreamRoot, "package.json"), "utf8"),
  );
  const version = packageJson.dependencies?.[moduleName];
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(`Upstream ${moduleName} has no exact package version`);
  }
  return version;
}

async function replaceOnce(path, needle, replacement) {
  const source = await readFile(path, "utf8");
  if (source.includes(replacement)) {
    return;
  }
  if (!source.includes(needle)) {
    throw new Error(
      `Could not find the Electron 42 better-sqlite3 patch point in ${path}`,
    );
  }
  await writeFile(path, source.replace(needle, replacement));
}

// Adapted from codex-desktop-linux scripts/lib/native-modules.sh (MIT).
async function patchBetterSqlite3ForElectron42(moduleRoot, electronVersion) {
  const electronMajor = Number.parseInt(electronVersion.split(".")[0], 10);
  if (!Number.isSafeInteger(electronMajor) || electronMajor < 42) {
    return;
  }

  const mainPath = join(moduleRoot, "src", "better_sqlite3.cpp");
  const helpersPath = join(moduleRoot, "src", "util", "helpers.cpp");
  const macrosPath = join(moduleRoot, "src", "util", "macros.cpp");

  await replaceOnce(
    mainPath,
    "v8::Local<v8::External> data = v8::External::New(isolate, addon);",
    "v8::Local<v8::External> data = BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon);",
  );
  await replaceOnce(
    macrosPath,
    `#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())`,
    `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 14
#define BETTER_SQLITE3_EXTERNAL_POINTER_TAG v8::kExternalPointerTypeTagDefault
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), BETTER_SQLITE3_EXTERNAL_POINTER_TAG)
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(BETTER_SQLITE3_EXTERNAL_POINTER_TAG))
#else
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value())
#endif

#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))`,
  );
  await replaceOnce(
    helpersPath,
    `		func,
		0,
		data`,
    `		func,
		nullptr,
		data`,
  );
}

export async function rebuildNativeModules({
  buildPath,
  electronVersion,
  arch,
  platform,
  rebuildImpl,
  runCommand = runBufferedCommand,
  progress,
}) {
  const versions = await runPhase(
    progress,
    "read native module versions",
    async () => ({
      "better-sqlite3": await readModuleVersion(buildPath, "better-sqlite3"),
      "node-pty": await readModuleVersion(buildPath, "node-pty"),
      "@parcel/watcher": await readDeclaredModuleVersion(
        buildPath,
        "@parcel/watcher",
      ),
    }),
  );
  const nativeBuildRoot = await runPhase(
    progress,
    "prepare native module workspace",
    () => mkdtemp(join(dirname(buildPath), ".native-build-")),
  );

  try {
    await writeFile(
      join(nativeBuildRoot, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
    );
    await runPhase(progress, "install native module sources", () =>
      runCommand(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--install-strategy=nested",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          `better-sqlite3@${versions["better-sqlite3"]}`,
          `node-pty@${versions["node-pty"]}`,
          `@parcel/watcher@${versions["@parcel/watcher"]}`,
        ],
        {
          cwd: nativeBuildRoot,
          label: "install native module sources",
          timeoutMs: 600_000,
        },
      ),
    );
    await runPhase(progress, "patch better-sqlite3", () =>
      patchBetterSqlite3ForElectron42(
        join(nativeBuildRoot, "node_modules", "better-sqlite3"),
        electronVersion,
      ),
    );

    const rebuildOptions = {
      buildPath: nativeBuildRoot,
      electronVersion,
      arch,
      platform,
      force: true,
      onlyModules: ["better-sqlite3", "node-pty"],
    };
    await runPhase(progress, "rebuild native modules", () =>
      rebuildImpl === undefined
        ? runBufferedCommand(
            process.execPath,
            [
              electronRebuildCli,
              "--version",
              electronVersion,
              "--module-dir",
              nativeBuildRoot,
              "--arch",
              arch,
              "--platform",
              platform,
              "--force",
              "--only",
              "better-sqlite3,node-pty",
              "--sequential",
            ],
            {
              label: "rebuild native modules",
              timeoutMs: 600_000,
            },
          )
: rebuildImpl(rebuildOptions),
    );

    await runPhase(progress, "install rebuilt native modules", async () => {
      for (const moduleName of Object.keys(versions)) {
        const destination = join(buildPath, "node_modules", moduleName);
        await rm(destination, { recursive: true, force: true });
        await cp(join(nativeBuildRoot, "node_modules", moduleName), destination, {
          recursive: true,
        });
      }
    });
    await runPhase(progress, "validate Parcel watcher", async () => {
      const requireFromBuild = createRequire(join(buildPath, "package.json"));
      requireFromBuild("@parcel/watcher");
    });
  } finally {
    await runPhase(progress, "clean native module workspace", () =>
      rm(nativeBuildRoot, { recursive: true, force: true }),
    );
  }
}
