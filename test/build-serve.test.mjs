import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPackage } from "@electron/asar";

import { buildWebWrapper } from "../src/build.mjs";
import { startWebServer } from "../src/serve.mjs";

const execFileAsync = promisify(execFile);

async function stageSyntheticRuntime({ candidateRoot, packageJson }) {
  const runtimeRoot = join(candidateRoot, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "electron"), "fixture runtime\n", {
    mode: 0o755,
  });
  return {
    electronPath: join(runtimeRoot, "electron"),
    electronVersion: packageJson.devDependencies.electron,
    platform: "linux",
    arch: "x64",
  };
}

async function createSyntheticDmg(root) {
  const appSource = join(root, "app-source");
  const webviewRoot = join(appSource, "webview");
  const assetsRoot = join(webviewRoot, "assets");
  const buildRoot = join(appSource, ".vite", "build");
  const resourcesRoot = join(
    root,
    "Payload",
    "Codex.app",
    "Contents",
    "Resources",
  );
  await mkdir(webviewRoot, { recursive: true });
  await mkdir(assetsRoot);
  await mkdir(buildRoot, { recursive: true });
  await mkdir(resourcesRoot, { recursive: true });
  await writeFile(
    join(appSource, "package.json"),
    `${JSON.stringify({
      name: "codex",
      productName: "Codex",
      version: "1.2.3-test",
      devDependencies: { electron: "42.3.0" },
    })}\n`,
  );
  await writeFile(
    join(webviewRoot, "index.html"),
    "<!doctype html><html><head><title>Upstream Codex</title></head><body><main>upstream interface</main></body></html>\n",
  );
  await writeFile(join(webviewRoot, "app.js"), "globalThis.codexFixture = true;\n");
  await writeFile(
    join(assetsRoot, "app-initial-fixture.js"),
    "function Lrc(e){let{sources:n,setSources:r}=e;lp(`workspace-root-option-picked`,()=>{});let k=(0,PQ.jsx)(Z,{id:`projectSetup.createLocalProject.sourceFoldersLabel`});return(0,PQ.jsxs)(jP,{className:`gap-2`,children:[k,`fixture`]})}function Rrc(){dp.dispatchMessage(`electron-pick-workspace-root-option`,{allowMultiple:!0})}function Lcc(e){return yp(`remote-workspace-directory-entries`,e)}var Hcc,Ucc,Wcc,qQ,Gcc,Kcc=n((()=>{}));\n",
  );
  await writeFile(
    join(buildRoot, "preload.js"),
    [
      '"use strict";var e=require("electron"),k=e.ipcRenderer.sendSync(`codex_desktop:get-shared-object-snapshot`)??{},B={getSharedObjectSnapshotValue:t=>k[t]};e.contextBridge.exposeInMainWorld(`electronBridge`,B);\n',
      "function vB(e){let n=TB({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath});if(!n)return null;let r={...process.env,LOG_FORMAT:`json`};return{executablePath:n.executablePath,args:n.args,env:r}}\n",
      "function DB(){return[...x,`app-server`,`--analytics-default-enabled`]}\n",
    ].join(""),
  );
  await writeFile(
    join(buildRoot, "main-fixture.js"),
    "let M,s,d,f,l={BrowserWindow:class{}};new l.BrowserWindow({backgroundColor:M,show:s,parent:d,...f===void 0?{}:{focusable:f},webPreferences:{}});\n",
  );
  await createPackage(appSource, join(resourcesRoot, "app.asar"));

  const dmgPath = join(root, "Codex.dmg");
  await execFileAsync("7z", ["a", "-t7z", dmgPath, "Payload"], { cwd: root });
  return dmgPath;
}

async function buildSyntheticWrapper(root, dmgPath) {
  return buildWebWrapper({
    dmgPath,
    root,
    stageRuntime: stageSyntheticRuntime,
  });
}

test("build and serve the patched upstream interface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const dmgPath = await createSyntheticDmg(root);
  const result = await buildSyntheticWrapper(root, dmgPath);

  assert.equal(result.manifest.applicationName, "Codex");
  assert.equal(result.manifest.applicationVersion, "1.2.3-test");
  assert.equal(result.manifest.electronVersion, "42.3.0");
  assert.match(
    await readFile(join(result.outputRoot, "upstream", "webview", "index.html"), "utf8"),
    /__codex_browser_bridge\.js/,
  );
  const preloadSource = await readFile(
    join(result.outputRoot, "upstream", ".vite", "build", "preload.js"),
    "utf8",
  );
  assert.match(preloadSource, /CODEX_WEB_RELAY_URL/);
  assert.match(preloadSource, /codex_desktop:connect-app-host/);
  assert.match(
    await readFile(
      join(result.outputRoot, "upstream", ".vite", "build", "main-fixture.js"),
      "utf8",
    ),
    /CODEX_WEB_HEADLESS/,
  );
  assert.match(preloadSource, /CODEX_WEB_APP_SERVER_PROXY/);
  assert.match(preloadSource, /CODEX_WEB_APP_SERVER_PROXY_PATH/);
  assert.match(preloadSource, /`app-server`,`--analytics-default-enabled`/);
  assert.doesNotMatch(preloadSource, /`app-server`,`proxy`/);
  const rendererSource = await readFile(
    join(
      result.outputRoot,
      "upstream",
      "webview",
      "assets",
      "app-initial-fixture.js",
    ),
    "utf8",
  );
  assert.match(rendererSource, /__codex_local_folder_browser/);
  assert.match(rendererSource, /hostId:`local`/);
  assert.match(rendererSource, /initialDirectoryPath:null/);
  assert.match(rendererSource, /remote-workspace-directory-entries/);
  assert.doesNotMatch(rendererSource, /electron-pick-workspace-root-option/);
  assert.equal(
    await realpath(join(root, "dist", "current")),
    await realpath(result.outputRoot),
  );

  const server = await startWebServer({ appRoot: result.outputRoot });
  context.after(() => server.close());

  const capabilityResponse = await fetch(server.url, { redirect: "manual" });
  assert.equal(capabilityResponse.status, 303);
  assert.equal(capabilityResponse.headers.get("location"), "/");
  const cookie = capabilityResponse.headers.get("set-cookie");
  assert.match(cookie, /^codex_web_cap=/);

  const unauthenticated = await fetch(new URL("/", server.url));
  assert.equal(unauthenticated.status, 403);

  const authenticatedHeaders = { Cookie: cookie.split(";")[0] };
  const unavailableBootstrap = await fetch(
    new URL("/__codex_bootstrap", server.url),
    { headers: authenticatedHeaders },
  );
  assert.equal(unavailableBootstrap.status, 503);

  const bootstrapFixture = {
    appSessionId: "fixture-session",
    sentryInitOptions: { desktopTraceSampleRate: 0 },
    sharedObjectSnapshot: { fixture: ["value"] },
  };
  server.setBootstrap(bootstrapFixture);
  const bootstrap = await fetch(new URL("/__codex_bootstrap", server.url), {
    headers: authenticatedHeaders,
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), bootstrapFixture);

  const page = await fetch(new URL("/", server.url), {
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /upstream interface/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const bridge = await fetch(
    new URL("/__codex_browser_bridge.js", server.url),
    { headers: { Cookie: cookie.split(";")[0] } },
  );
  assert.equal(bridge.status, 200);
  const bridgeSource = await bridge.text();
  assert.match(bridgeSource, /electronBridge/);
  assert.match(bridgeSource, /connect-app-host/);
  assert.match(bridgeSource, /app-host-message/);
  assert.match(bridgeSource, /bootstrap\.sharedObjectSnapshot\[key\]/);
  assert.match(bridgeSource, /__codex_bootstrap/);
  assert.match(bridgeSource, /bootstrap\.sentryInitOptions/);
  assert.doesNotMatch(bridgeSource, /window\.prompt/);
  assert.doesNotMatch(bridgeSource, /workspace-root-option-picked/);

  const missing = await fetch(new URL("/missing", server.url), {
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /upstream interface/);

  const wildcardServer = await startWebServer({
    appRoot: result.outputRoot,
    host: "0.0.0.0",
    port: 0,
    capability: "wildcard-fixture",
  });
  context.after(() => wildcardServer.close());
  const remoteUrl = new URL(wildcardServer.url);
  remoteUrl.hostname = "127.0.0.1";
  const remoteCapability = await fetch(remoteUrl, { redirect: "manual" });
  assert.equal(remoteCapability.status, 303);
  assert.equal(
    wildcardServer.isRequestOriginAllowed({
      headers: {
        host: remoteUrl.host,
        origin: remoteUrl.origin,
      },
    }),
    true,
  );
  assert.equal(
    wildcardServer.isRequestOriginAllowed({
      headers: {
        host: remoteUrl.host,
        origin: "http://attacker.invalid",
      },
    }),
    false,
  );

  const proxiedServer = await startWebServer({
    appRoot: result.outputRoot,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "https://codex.example.test",
    capability: "proxy-fixture",
  });
  context.after(() => proxiedServer.close());
  assert.equal(
    proxiedServer.url,
    "https://codex.example.test/?cap=proxy-fixture",
  );
  assert.match(proxiedServer.internalUrl, /^http:\/\/127\.0\.0\.1:/);

  const proxiedRequestUrl = new URL(proxiedServer.internalUrl);
  const proxiedCapability = await new Promise((resolve, reject) => {
    const request_ = request(
      proxiedRequestUrl,
      { headers: { Host: "codex.example.test" } },
      response => {
        response.resume();
        response.once("end", () => resolve(response));
      },
    );
    request_.once("error", reject);
    request_.end();
  });
  assert.equal(proxiedCapability.statusCode, 303);
  assert.match(proxiedCapability.headers["set-cookie"][0], /; Secure/);
  assert.equal(
    proxiedServer.isRequestOriginAllowed({
      headers: {
        host: "codex.example.test",
        origin: "https://codex.example.test",
      },
    }),
    true,
  );
  assert.equal(
    proxiedServer.isRequestOriginAllowed({
      headers: {
        host: "codex.example.test",
        origin: "http://codex.example.test",
      },
    }),
    false,
  );
});

test("a failed build preserves the current generated application", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const dmgPath = await createSyntheticDmg(root);
  const working = await buildSyntheticWrapper(root, dmgPath);
  const currentBefore = await realpath(join(root, "dist", "current"));

  const invalidRoot = join(root, "invalid");
  await mkdir(invalidRoot);
  await writeFile(join(invalidRoot, "not-an-app.txt"), "invalid\n");
  const invalidDmg = join(root, "invalid.dmg");
  await execFileAsync("7z", ["a", "-t7z", invalidDmg, "invalid"], { cwd: root });

  await assert.rejects(
    buildSyntheticWrapper(root, invalidDmg),
    /Expected one upstream app\.asar/,
  );
  assert.equal(await realpath(join(root, "dist", "current")), currentBefore);
  assert.equal(await realpath(working.outputRoot), currentBefore);
});
