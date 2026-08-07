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
    "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><link rel=\"manifest\" href=\"/manifest.json\" /><title>Upstream Codex</title></head><body><main>upstream interface</main></body></html>\n",
  );
  await writeFile(join(webviewRoot, "app.js"), "globalThis.codexFixture = true;\n");
  await writeFile(
    join(assetsRoot, "app-fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    join(assetsRoot, "app-initial-fixture.js"),
    [
      "function Lrc(e){let{sources:n,setSources:r}=e;lp(`workspace-root-option-picked`,()=>{});let k=(0,PQ.jsx)(Z,{id:`projectSetup.createLocalProject.sourceFoldersLabel`});return(0,PQ.jsxs)(jP,{className:`gap-2`,children:[k,`fixture`]})}function Rrc(){dp.dispatchMessage(`electron-pick-workspace-root-option`,{allowMultiple:!0})}function Lcc(e){return yp(`remote-workspace-directory-entries`,e)}var Hcc,Ucc,Wcc,qQ,Gcc,Kcc=n((()=>{}));function P(e){let t=(0,C.c)(32),{isPetVisible:s,onTogglePet:p}=e;let x;t[11]!==s||t[12]!==p?(x=p==null?null:(0,J.jsx)(AR,{children:s?(0,J.jsx)(Z,{id:`codex.profileFooter.hidePet`,defaultMessage:`Hide pet`}):(0,J.jsx)(Z,{id:`codex.profileFooter.showPet`,defaultMessage:`Show pet`})}),t[11]=s,t[12]=p,t[13]=x):x=t[13];let S;t[14]===x?S=t[15]:(S=(0,J.jsx)(J.Fragment,{children:x}),t[14]=x,t[15]=S);let w=(0,J.jsx)(Z,{id:`settings`});return(0,J.jsxs)(`div`,{children:[h,S,w]})}\n",
      "let activity={projectGroup:e(p$,t)};function cAc(e){let t=(0,D8.c)(18),{chatGptConversationId:n,chatGptProjectId:r,itemKind:i,localConversationId:a,projectGroup:o,sidebarMode:s}=e,c=Po(fg,`2031251742`);return(0,O8.jsx)(mAc,{itemKind:i,sidebarMode:s})}function mAc(e){return(0,O8.jsx)(Z,{id:`sidebarElectron.priorityThreads.details.codex`,defaultMessage:`Codex`,description:`Source label for a standalone Codex task in the Priority filter`})}\n",
      "function LGc(e){let E=Fo(Q),m=`codex`;let he=(e,t)=>{let n=a.get(e);if(n?.source===`codex`)return(0,V5.jsx)(DRc,{canPin:!0,floatStatusIconsEnd:!0,hideTimestamp:!0,isGrouped:!1,locationId:C??`unified-sidebar`,onArchiveError:()=>t.onArchiveError(e),onArchiveStart:()=>t.onArchiveStart(e),onArchiveSuccess:()=>t.onArchiveSuccess(e),shortcutLabel:j?.get(n.threadKey),showPinActionOnHover:!0,threadKey:n.threadKey})};return he}\n",
      "let O9c=`https://ab.chatgpt.com/v1`,l5c=`https://chatgpt.com/ces/v1/rgstr`,k9c=`https://ab.chatgpt.com/v1/sdk_exception`,a9c=()=>{},N9c={networkConfig:{api:O9c,logEventUrl:l5c,sdkExceptionUrl:k9c,networkOverrideFunc:a9c}},P9c={...N9c,disableStorage:!0,loggingEnabled:`disabled`};\n",
      "var rendererFileOrigin=`app://fs`,rendererFilePrefix=`/@fs`;\n",
      "let analyticsProvider={submitCodexAnalyticsEvent:r===`chatgpt`?w5c:null};\n",
    ].join(""),
  );
  await writeFile(
    join(assetsRoot, "thread-app-shell-chrome-fixture.js"),
    "let z=[...I?[{deferSelectionUntilDropdownClose:!0,id:`browser`,Icon:te,keyboardShortcut:A,onSelect:pe,title:(0,J.jsx)(V,{id:`thread.sidePanel.openBrowserTab`,defaultMessage:`Browser`,description:`Action label for opening the browser tab from the task side panel`})}]:[],...N?[{id:`review`}]:[],...t===`right`?d.map(e=>e):[]];\n",
  );
  await writeFile(
    join(assetsRoot, "thread-app-shell-chrome-unused.js"),
    "export const unrelatedSidePanelChunk = true;\n",
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
    "let M,s,d,f,q=360,j=320,U={items:[]},l={BrowserWindow:class{},Menu:{setApplicationMenu(){}}},p0=async()=>null,O=async()=>{let e=l.BrowserWindow.getFocusedWindow();return e&&!e.isDestroyed()?e:p0()},v={sendMessageToWindow(){}},z=async e=>{let t=await O();t&&v.sendMessageToWindow(t,{type:`command-menu`,query:e})},C=[{id:`copy`,electron:{isOverridableByBrowserWebpage:!0}}],A=new Set(C.filter(e=>`electron`in e&&e.electron!=null&&`isOverridableByBrowserWebpage`in e.electron&&e.electron.isOverridableByBrowserWebpage===!0).map(({id:e})=>e.id)),Q=new Set;for(let e of C)if(!A.has(e.id))Q.add(e.id);new l.BrowserWindow({backgroundColor:M,show:s,parent:d,...f===void 0?{}:{focusable:f},webPreferences:{}});async function A0({buildFlavor:e,parent:t}){if(false)return;let i=`Codex`,u=`Build`,y=`Version`,p={htmlIconDataUrl:null},x=false,h=`OK`,m=`About Codex`,S=new l.BrowserWindow({width:q,height:j,useContentSize:!0,title:m,show:!1,resizable:!1,minimizable:!1,maximizable:!1,fullscreenable:!1,autoHideMenuBar:!0,webPreferences:{}});await S.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(H({appDisplayName:i,buildInfoLabel:u,buildInfoText:y,iconDataUrl:p.htmlIconDataUrl,isDark:x,okLabel:h,title:m}))}`)}l.Menu.setApplicationMenu(U);function H(){return`<button id=\"ok\">OK</button>`}function W(){return[`app-server`,`--analytics-default-enabled`,`wsl`]}var mainFileOrigin=`app://fs`,mainFilePrefix=`/@fs`;\n",
  );
  await writeFile(
    join(buildRoot, "worker.js"),
    "var workerFileOrigin=`app://fs`,workerFilePrefix=`/@fs`;\n",
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

async function createRemoteDmgFixture(dmgPath) {
  const dmgBytes = await readFile(dmgPath);
  const state = {
    calls: [],
    lastModified: "Thu, 06 Aug 2026 12:00:00 GMT",
    revision: 1,
  };

  return {
    state,
    fetchImpl: async (_url, options = {}) => {
      const method = options.method ?? "GET";
      state.calls.push(method);
      const response = new Response(method === "HEAD" ? null : dmgBytes, {
        status: 200,
        headers: {
          "content-length": String(dmgBytes.length),
          etag: `"fixture-${state.revision}"`,
          "last-modified": state.lastModified,
        },
      });
      Object.defineProperty(response, "url", {
        value: `https://downloads.example.test/ChatGPT-${state.revision}.dmg`,
      });
      return response;
    },
  };
}

test("build and serve the patched upstream interface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const dmgPath = await createSyntheticDmg(root);
  const result = await buildSyntheticWrapper(root, dmgPath);

  assert.equal(result.manifest.applicationName, "Codex");
  assert.equal(result.manifest.applicationVersion, "1.2.3-test");
  assert.equal(result.manifest.electronVersion, "42.3.0");
  const patchedIndex = await readFile(
    join(result.outputRoot, "upstream", "webview", "index.html"),
    "utf8",
  );
  assert.match(patchedIndex, /__codex_browser_bridge\.js/);
  assert.match(patchedIndex, /rel="manifest" href="\/manifest\.json" crossorigin="use-credentials"/);
  assert.match(patchedIndex, /default-src 'none'; manifest-src 'self'/);
  const webManifest = JSON.parse(
    await readFile(join(result.outputRoot, "upstream", "webview", "manifest.json"), "utf8"),
  );
  assert.equal(webManifest.start_url, "/");
  assert.equal(webManifest.display, "standalone");
  assert.deepEqual(
    webManifest.icons.map(({ src, sizes }) => ({ src, sizes })),
    [
      { src: "/icon-192.svg", sizes: "192x192" },
      { src: "/icon-512.svg", sizes: "512x512" },
    ],
  );
  assert.match(
    await readFile(join(result.outputRoot, "upstream", "webview", "icon-512.svg"), "utf8"),
    /width="512" height="512"/,
  );
  const preloadSource = await readFile(
    join(result.outputRoot, "upstream", ".vite", "build", "preload.js"),
    "utf8",
  );
  assert.match(preloadSource, /CODEX_WEB_RELAY_URL/);
  assert.match(preloadSource, /codex_desktop:connect-app-host/);
  const mainSource = await readFile(
    join(result.outputRoot, "upstream", ".vite", "build", "main-fixture.js"),
    "utf8",
  );
  assert.match(mainSource, /CODEX_WEB_HEADLESS/);
  assert.match(
    mainSource,
    /if\(process\.env\.CODEX_WEB_HEADLESS===`1`\)\{[\s\S]*webContents\.executeJavaScript[\s\S]*;return\}let S=new l\.BrowserWindow/,
  );
  assert.match(mainSource, /__codex_web_about/);
  assert.match(mainSource, /html:H\(\{appDisplayName:i/);
  assert.match(mainSource, /__codex_web_keyboard_shortcut/);
  assert.match(mainSource, /ipcMain\.handle/);
  assert.match(mainSource, /triggeredByAccelerator: true/);
  assert.match(mainSource, /codex_desktop:message-for-view/);
  assert.match(mainSource, /originalSendMessageToWindow/);
  assert.match(mainSource, /sendMessageToWindow = \(_window, message\)/);
  assert.match(mainSource, /Q\.has\(normalize\(item\.accelerator\)\)/);
  assert.match(mainSource, /isOverridableByBrowserWebpage/);
  assert.match(mainSource, /CODEX_WEB_HEADLESS[\s\S]*BrowserWindow\.getAllWindows\(\)\.find/);
  assert.match(preloadSource, /dispatchKeyboardShortcut/);
  assert.match(mainSource, /__codex_browser_file_urls/);
  assert.doesNotMatch(mainSource, /app:\/\/fs/);
  const workerSource = await readFile(
    join(result.outputRoot, "upstream", ".vite", "build", "worker.js"),
    "utf8",
  );
  assert.match(workerSource, /__codex_browser_file_urls/);
  assert.doesNotMatch(workerSource, /app:\/\/fs/);
  assert.match(preloadSource, /getKeyboardShortcuts/);
  assert.match(mainSource, /`-c`,`analytics\.enabled=false`/);
  assert.doesNotMatch(mainSource, /--analytics-default-enabled/);
  assert.match(preloadSource, /CODEX_WEB_APP_SERVER_PROXY/);
  assert.match(preloadSource, /CODEX_WEB_APP_SERVER_PROXY_PATH/);
  assert.match(preloadSource, /`app-server`,`-c`,`analytics\.enabled=false`/);

  assert.doesNotMatch(preloadSource, /--analytics-default-enabled/);
  assert.doesNotMatch(preloadSource, /`app-server`,`proxy`/);
  assert.doesNotMatch(preloadSource, /showContextMenu/);
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
  assert.match(rendererSource, /__codex_hide_profile_pet_action/);
  assert.doesNotMatch(rendererSource, /children:\[h,S,w\]/);
  assert.match(rendererSource, /__codex_disable_remote_telemetry/);
  assert.match(rendererSource, /loggingEnabled:`disabled`/);
  assert.match(rendererSource, /submitCodexAnalyticsEvent:null/);
  assert.doesNotMatch(rendererSource, /submitCodexAnalyticsEvent:r===/);
  assert.match(rendererSource, /__codex_browser_file_urls/);
  assert.doesNotMatch(rendererSource, /app:\/\/fs/);
  assert.match(rendererSource, /__codex_default_sidebar_rows/);
  assert.match(rendererSource, /hideRemoteHostEnvIcon:!0/);
  assert.match(
    rendererSource,
    /secondaryContent:\(0,V5\.jsx\)\(__codexDefaultWorkspaceDetails,\{threadKey:n\.threadKey\}\)/,
  );
  assert.match(rendererSource, /threadKey:n\.threadKey,wrapSecondaryContent:!0/);
  assert.match(rendererSource, /defaultMessage:`No workspace`/);
  assert.doesNotMatch(
    rendererSource,
    /id:`sidebarElectron\.priorityThreads\.details\.codex`/,
  );
  const sidePanelSource = await readFile(
    join(
      result.outputRoot,
      "upstream",
      "webview",
      "assets",
      "thread-app-shell-chrome-fixture.js",
    ),
    "utf8",
  );
  assert.match(sidePanelSource, /__codex_hide_browser_side_panel_action/);
  assert.match(sidePanelSource, /\.\.\.I&&t!==`right`\?/);
  assert.match(sidePanelSource, /id:`review`/);
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
  assert.equal(unauthenticated.status, 200);
  assert.equal(
    unauthenticated.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  const landingPage = await unauthenticated.text();
  assert.match(landingPage, /Connect this app/);
  assert.match(landingPage, /Capability URL/);
  assert.match(landingPage, /Open Codex/);
  assert.equal(landingPage.includes(server.capability), false);

  const invalidCapability = await fetch(new URL("/?cap=invalid", server.url));
  assert.equal(invalidCapability.status, 200);
  assert.match(
    await invalidCapability.text(),
    /That capability URL is not valid for this codex-web service/,
  );

  const protectedAsset = await fetch(new URL("/manifest.json", server.url));
  assert.equal(protectedAsset.status, 403);

  const authenticatedHeaders = { Cookie: cookie.split(";")[0] };

  const localImagePath = join(root, "local media #?.png");
  const localImageBytes = Buffer.from("local image fixture");
  await writeFile(localImagePath, localImageBytes);
  const localImageUrl = new URL(
    `/@fs${encodeURI(localImagePath).replaceAll("#", "%23").replaceAll("?", "%3F")}`,
    server.url,
  );
  const unauthenticatedLocalImage = await fetch(localImageUrl);
  assert.equal(unauthenticatedLocalImage.status, 403);

  const localImage = await fetch(localImageUrl, {
    headers: authenticatedHeaders,
  });
  assert.equal(localImage.status, 200);
  assert.equal(localImage.headers.get("content-type"), "image/png");
  assert.equal(
    localImage.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.deepEqual(Buffer.from(await localImage.arrayBuffer()), localImageBytes);

  const localTextPath = join(root, "local.txt");
  await writeFile(localTextPath, "not media\n");
  const localText = await fetch(
    new URL(`/@fs${encodeURI(localTextPath)}`, server.url),
    { headers: authenticatedHeaders },
  );
  assert.equal(localText.status, 404);

  const localVideoPath = join(root, "local.mp4");
  await writeFile(localVideoPath, "0123456789");
  const localVideoUrl = new URL(`/@fs${encodeURI(localVideoPath)}`, server.url);
  const localVideoRange = await fetch(localVideoUrl, {
    headers: { ...authenticatedHeaders, Range: "bytes=2-5" },
  });
  assert.equal(localVideoRange.status, 206);
  assert.equal(localVideoRange.headers.get("accept-ranges"), "bytes");
  assert.equal(localVideoRange.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await localVideoRange.text(), "2345");

  const invalidLocalVideoRange = await fetch(localVideoUrl, {
    headers: { ...authenticatedHeaders, Range: "bytes=20-30" },
  });
  assert.equal(invalidLocalVideoRange.status, 416);
  assert.equal(
    invalidLocalVideoRange.headers.get("content-range"),
    "bytes */10",
  );

  const malformedLocalMedia = await fetch(
    new URL("/@fs/%E0%A4%A", server.url),
    { headers: authenticatedHeaders },
  );
  assert.equal(malformedLocalMedia.status, 404);
  const unavailableBootstrap = await fetch(
    new URL("/__codex_bootstrap", server.url),
    { headers: authenticatedHeaders },
  );
  assert.equal(unavailableBootstrap.status, 503);

  const bootstrapFixture = {
    appSessionId: "fixture-session",
    sentryInitOptions: null,
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
  assert.equal(page.headers.get("content-security-policy"), "manifest-src 'self'");

  const webManifestResponse = await fetch(new URL("/manifest.json", server.url), {
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(webManifestResponse.status, 200);
  assert.equal(
    webManifestResponse.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal((await webManifestResponse.json()).display, "standalone");

  const installIcon = await fetch(new URL("/icon-512.svg", server.url), {
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(installIcon.status, 200);
  assert.equal(installIcon.headers.get("content-type"), "image/svg+xml");

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
  assert.match(bridgeSource, /keyboardShortcutSignature/);
  assert.match(bridgeSource, /dispatchKeyboardShortcut/);
  assert.match(bridgeSource, /getKeyboardShortcuts/);
  assert.match(bridgeSource, /value\.messages/);
  assert.match(bridgeSource, /handleHostNotification/);
  assert.doesNotMatch(bridgeSource, /getSentryInitOptions/);

  assert.match(bridgeSource, /triggerSentryTestError: \(\) => undefined/);
  assert.doesNotMatch(bridgeSource, /bootstrap\.sentryInitOptions/);
  assert.doesNotMatch(bridgeSource, /window\.prompt/);
  assert.doesNotMatch(bridgeSource, /showContextMenu/);
  assert.match(bridgeSource, /createElement\("dialog"\)/);
  assert.match(bridgeSource, /showModal\(\)/);
  assert.match(bridgeSource, /__codex_web_about_dialog/);
  assert.match(bridgeSource, /frame\.srcdoc = html/);
  assert.match(
    bridgeSource,
    /left:50%;margin:0;[\s\S]*position:fixed;top:50%;transform:translate\(-50%,-50%\)/,
  );
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

test("remote Last-Modified controls the DMG and extraction cache", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-cache-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const dmgPath = await createSyntheticDmg(root);
  const remote = await createRemoteDmgFixture(dmgPath);
  const progressEvents = [];
  const buildRemote = () =>
    buildWebWrapper({
      root,
      fetchImpl: remote.fetchImpl,
      stageRuntime: stageSyntheticRuntime,
      progress: event => progressEvents.push(event),
    });

  const first = await buildRemote();
  assert.equal(first.manifest.sourceLastModified, remote.state.lastModified);
  assert.deepEqual(remote.state.calls, ["HEAD", "GET"]);

  const cacheMarker = join(
    root,
    "work",
    "upstream",
    "extracted",
    "upstream",
    "cache-marker.txt",
  );
  await writeFile(cacheMarker, "reused extraction\n");

  remote.state.revision = 2;
  const cached = await buildRemote();
  assert.equal(
    await readFile(join(cached.outputRoot, "upstream", "cache-marker.txt"), "utf8"),
    "reused extraction\n",
  );
  assert.deepEqual(remote.state.calls, ["HEAD", "GET", "HEAD"]);
  assert.ok(
    progressEvents.some(
      event =>
        event.status === "info" &&
        event.message === "DMG cache is current",
    ),
  );
  assert.ok(
    progressEvents.some(
      event =>
        event.status === "started" &&
        event.phase === "reuse extracted application",
    ),
  );
  assert.ok(
    progressEvents.some(
      event =>
        event.status === "started" &&
        event.phase === "stage Electron runtime",
    ),
  );

  remote.state.revision = 3;
  remote.state.lastModified = "Fri, 07 Aug 2026 12:00:00 GMT";
  const refreshed = await buildRemote();
  assert.equal(refreshed.manifest.sourceLastModified, remote.state.lastModified);
  await assert.rejects(
    readFile(join(refreshed.outputRoot, "upstream", "cache-marker.txt"), "utf8"),
    error => error.code === "ENOENT",
  );
  assert.deepEqual(remote.state.calls, ["HEAD", "GET", "HEAD", "HEAD", "GET"]);

  await writeFile(cacheMarker, "damaged extraction cache\n");
  await writeFile(
    join(root, "work", "upstream", "extracted", "metadata.json"),
    "{invalid json\n",
  );
  remote.state.revision = 4;
  const repaired = await buildRemote();
  await assert.rejects(
    readFile(join(repaired.outputRoot, "upstream", "cache-marker.txt"), "utf8"),
    error => error.code === "ENOENT",
  );
  assert.deepEqual(
    remote.state.calls,
    ["HEAD", "GET", "HEAD", "HEAD", "GET", "HEAD", "GET"],
  );
});

test("remote DMG inspection requires Last-Modified", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-web-cache-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    buildWebWrapper({
      root,
      fetchImpl: async () => {
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "url", {
          value: "https://downloads.example.test/ChatGPT.dmg",
        });
        return response;
      },
      stageRuntime: stageSyntheticRuntime,
    }),
    /no Last-Modified header/,
  );
});
