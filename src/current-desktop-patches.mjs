import { parse } from "acorn";

export const currentDesktopVersion = "26.1007.21159";

// Use the RPC library's string codec across the WebSocket tunnel. Its default
// structured-clone codec cannot cross JSON without losing dates, bytes or bigint.
export function patchCurrentRpcTransport(source) {
  const marker = "__codex_string_rpc_transport";
  if (source.includes(marker)) return source;
  const encoding = oneMatch(source, /encodingLevel=`structuredClonable`/g,
    "MessagePort RPC encoding")[0];
  return source.replace(encoding, `encodingLevel=\`string\`/* ${marker} */`);
}

export function patchCurrentIpcDelivery(source) {
  const marker = "__codex_inline_headless_ipc";
  if (source.includes(marker)) return source;
  // The minimal Electron host page cannot acknowledge chunks. In particular,
  // startup chunks sent before a browser connects would block every later reply.
  // Send complete IPC payloads to the preload; WebSocket owns browser framing.
  for (const method of ["send", "sendInline", "sendCritical"]) {
    const body = oneMatch(source,
      new RegExp(`${method}\\(e,t,n\\)\\{e\\.isDestroyed\\(\\)\\|\\|this\\.sender\\.${method}\\(e,\\{channel:t,payload:n\\}\\)\\}`, "g"),
      `chunked IPC ${method} method`)[0];
    source = source.replace(body,
      `${method}(e,t,n){if(process.env.CODEX_WEB_HEADLESS===\`1\`){if(!e.isDestroyed())e.send(t,n);return}e.isDestroyed()||this.sender.${method}(e,{channel:t,payload:n})}`);
  }
  return source + `\n/* ${marker} */\n`;
}

function oneMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one upstream ${label}, found ${matches.length}`);
  }
  return matches[0];
}

function topLevelFunctions(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter(node => node.type === "FunctionDeclaration")
    .map(node => ({ node, source: source.slice(node.start, node.end) }));
}

function oneFunction(functions, predicate, label) {
  const matches = functions.filter(({ source }) => predicate(source));
  if (matches.length !== 1) {
    throw new Error(`Expected one upstream ${label}, found ${matches.length}`);
  }
  return matches[0];
}

function replaceRanges(source, changes) {
  for (const { start, end, replacement } of changes.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return source;
}

export function patchCurrentAppServerTransport(source) {
  const marker = "CODEX_WEB_APP_SERVER_PROXY";
  if (source.includes(marker)) return source;
  const [, resolver] = oneMatch(
    source,
    /,\w+=await ([\w$]+)\(this\.options,\w+\);if\(!\w+\)throw Error\(`Unable to locate the Codex CLI binary or required runtime components\./g,
    "app-server command resolver",
  );
  const header = oneMatch(
    source,
    new RegExp(`async function ${resolver.replaceAll("$", "\\$")}\\(e,t=\\[\\]\\)\\{`, "g"),
    "app-server resolver function",
  )[0];
  return source.replace(header,
    `${header}if(process.env.CODEX_WEB_APP_SERVER_PROXY_PATH&&e.hostConfig.kind===\`local\`)` +
    `return/* ${marker} */{executablePath:process.env.CODEX_WEB_APP_SERVER_PROXY_PATH,` +
    "args:[],env:{...process.env,LOG_FORMAT:`json`},cwd:e.repoRoot};",
  );
}

export function patchCurrentMainTelemetry(source) {
  const marker = "__codex_disable_main_telemetry";
  if (source.includes(marker)) return source;
  const predicate = oneMatch(
    source,
    /([\w$]+)=>\1\.analytics\?\.enabled!==!1/g,
    "desktop analytics predicate",
  )[0];
  return source.replace(predicate,
    `e=>process.env.CODEX_WEB_HEADLESS!==\`1\`&&e.analytics?.enabled!==!1/* ${marker} */`,
  );
}

export function patchCurrentShellCompatibility(source) {
  const marker = "__codex_headless_stock_electron";
  if (source.includes(marker)) return source;
  const guard = oneMatch(source,
    /if\(process\.versions\.electron!=null&&typeof [\w$]+\.app\.showTaskManager!=`function`\)throw Error\(`Codex requires the Owl app shell; stock Electron is no longer supported\.`\)/g,
    "Owl shell guard")[0];
  // The browser adapter does not use Owl's native browser/task-manager windows.
  // Keep the upstream guard for ordinary desktop launches.
  const reportingCalls = [...source.matchAll(/\.setWebsiteReportingEnabled\(/g)];
  if (reportingCalls.length !== 3) {
    throw new Error(`Expected three upstream website reporting calls, found ${reportingCalls.length}`);
  }
  return source.replace(guard, guard.replace("if(",
    `if(process.env.CODEX_WEB_HEADLESS!==\`1\`&&/* ${marker} */`))
    .replaceAll(".setWebsiteReportingEnabled(", ".setWebsiteReportingEnabled?.(");
}

export function patchCurrentNativeFeatures(source) {
  const marker = "__codex_optional_native_features";
  if (source.includes(marker)) return source;
  for (const [method, expected] of [["setDebugChromePagesEnabled", 3], ["setRuntimeFeatures", 2]]) {
    const call = `.app.${method}(`;
    const count = source.split(call).length - 1;
    if (count !== expected) throw new Error(`Expected ${expected} upstream ${method} calls, found ${count}`);
    source = source.replaceAll(call, `.app.${method}?.(`);
  }
  const query = oneMatch(source, /[\w$]+\.app\.isRuntimeFeatureEnabled\([\w$]+\)/g,
    "native feature query")[0];
  source = source.replace(query, query.replace("isRuntimeFeatureEnabled(", "isRuntimeFeatureEnabled?.(") + "??!1");
  for (const method of ["isInputShapeSupported", "isSystemBackdropSupported"]) {
    const capability = oneMatch(source, new RegExp(`[\\w$]+\\.BrowserWindow\\.${method}\\(\\)`, "g"),
      `native ${method} capability`)[0];
    source = source.replace(capability, "(" + capability.replace(`${method}(`, `${method}?.(`) + "??!1)");
  }
  const cursorCapability = oneMatch(source,
    /[\w$]+\.screen\.isCursorScreenPointSupported\(\)/g,
    "native cursor capability")[0];
  source = source.replace(cursorCapability,
    "(" + cursorCapability.replace("isCursorScreenPointSupported(", "isCursorScreenPointSupported?.(") + "??!1)");
  const browserHeader = oneMatch(source,
    /async setInAppBrowserFeatureEnabled\(e,t\)\{/g, "native browser feature setter")[0];
  source = source.replace(browserHeader,
    `${browserHeader}if(process.env.CODEX_WEB_HEADLESS===\`1\`)e=!1;`);
  return source + `\n/* ${marker} */\n`;
}

export function patchCurrentWorkerTelemetry(source) {
  const marker = "__codex_disable_worker_sentry";
  if (source.includes(marker)) return source;
  const header = oneMatch(
    source,
    /function [\w$]+\(e,t,n,r\)\{(?=r!=null&&[\w$]+\(e,`git-worker`,r\))/g,
    "worker telemetry initializer",
  )[0];
  return source.replace(header,
    `${header}if(process.env.CODEX_WEB_HEADLESS===\`1\`)return()=>{};/* ${marker} */`,
  );
}

export function patchCurrentRenderer(source) {
  const marker = "__codex_current_renderer";
  if (source.includes(marker)) return source;
  const functions = topLevelFunctions(source);
  const local = oneFunction(functions,
    value => value.includes("`workspace-root-option-picked`") &&
      value.includes("`electron-pick-workspace-root-option`"),
    "local source-folder component",
  );
  const remote = oneFunction(functions,
    value => value.includes("`remote-workspace-directory-entries`") &&
      value.includes("setSelectedPath"),
    "directory browser component",
  );
  const [, remoteCompiler] = oneMatch(remote.source, /let t=\(0,([\w$]+)\.c\)\(/g,
    "directory browser compiler");
  const remoteInitializer = oneFunction(functions,
    value => value.includes(`${remoteCompiler}=`), "directory browser initializer");
  const [, jsx] = oneMatch(local.source,
    /\(0,([\w$]+)\.jsx\)\([\w$]+,\{id:`projectSetup\.createLocalProject\.sourceFoldersLabel`/g,
    "source-folder JSX runtime");
  const label = oneMatch(local.source,
    /\(0,[\w$]+\.jsx\)\([\w$]+,\{id:`projectSetup\.createLocalProject\.sourceFoldersLabel`,[^}]+\}\)/g,
    "source-folder label")[0];
  const localReplacement = `function ${local.node.id.name}(e){${remoteInitializer.node.id.name}();` +
    `return/* __codex_local_folder_browser */(0,${jsx}.jsxs)(\`div\`,{className:\`flex flex-col gap-2\`,children:[` +
    label + `,(0,${jsx}.jsx)(${remote.node.id.name},{hostId:\`local\`,mode:\`directoryPath\`,` +
    "initialDirectoryPath:null,selectedPath:e.sources[0]??null,disabled:e.disabled," +
    "setSelectedPath:path=>e.setSources(path==null||path.length===0?[]:[path])})]})}";

  const statsig = oneFunction(functions,
    value => value.includes("enableLiveValuesAutoRefresh:!0") &&
      value.includes("loggingEnabled:`disabled`"), "Statsig options builder");
  const statsigSource = statsig.source.replace("{let t=", "{e=!1;let t=");
  if (statsigSource === statsig.source) throw new Error("Upstream Statsig options header changed");
  const transport = oneFunction(functions,
    value => value.includes("https://ab.chatgpt.com/v1/sdk_exception") &&
      value.includes("new Response(null,{status:204})"), "Statsig transport");
  const transportSource = transport.source.replace(/\{if\(!n&&e===`https:\/\/ab\.chatgpt\.com\/v1\/sdk_exception`\)/,
    "{if(e===`https://ab.chatgpt.com/v1/sdk_exception`||e===`https://ab.chatgpt.com/v1/rgstr`)");
  if (transportSource === transport.source) throw new Error("Upstream Statsig transport header changed");

  source = replaceRanges(source, [
    { start: local.node.start, end: local.node.end, replacement: localReplacement },
    { start: statsig.node.start, end: statsig.node.end, replacement: statsigSource },
    { start: transport.node.start, end: transport.node.end, replacement: transportSource },
  ]);
  const analytics = oneMatch(source,
    /submitCodexAnalyticsEvent:[\w$]+===`chatgpt`\?[\w$]+:null/g,
    "Codex analytics provider")[0];
  source = source.replace(analytics, "submitCodexAnalyticsEvent:null");

  // The current app has its own subagent model/effort header. Keep those upstream
  // components instead of injecting exports into a particular conversation chunk.
  return patchCurrentSidebarRows(source) + `\n/* ${marker} */\n`;
}

function patchCurrentSidebarRows(source) {
  const [, projectGroup] = oneMatch(source,
    /projectGroup:[\w$]+\(([\w$]+),[\w$]+\)/g, "thread project-group selector");
  const [, details, hook, jsx] = oneMatch(source,
    /function ([\w$]+)\(e\)\{let t=\(0,[\w$]+\.c\)\(\d+\),\{chatGptConversationId:n,chatGptProjectId:r,itemKind:i,localThreadKey:a,projectGroup:o,sidebarMode:s\}=e,[\s\S]{0,500}?=([\w$]+)\([\w$]+,`2031251742`\);[\s\S]{0,300}?\(0,([\w$]+)\.jsx\)/g,
    "thread details component");
  const row = oneMatch(source,
    /if\(([\w$]+)\?\.source===`codex`\)return\(0,([\w$]+)\.jsx\)\([\w$]+,\{archiveGroup:[\s\S]*?secondaryContent:([\w$]+)\?\(0,\2\.jsx\)\([\w$]+,\{conversation:\1\}\):void 0,wrapSecondaryContent:\3,variant:[\w$]+\}\)/g,
    "default Codex sidebar row");
  const [rowSource, item, rowJsx, showDetails] = row;
  const secondary = `secondaryContent:${showDetails}?(0,${rowJsx}.jsx)(`;
  const secondaryStart = rowSource.indexOf(secondary);
  const secondaryEnd = rowSource.indexOf(",variant:", secondaryStart);
  const patchedRow = rowSource.slice(0, secondaryStart) +
    `secondaryContent:(0,${rowJsx}.jsx)(__codexDefaultWorkspaceDetails,{threadKey:${item}.threadKey}),wrapSecondaryContent:!0` +
    rowSource.slice(secondaryEnd);
  const label = oneMatch(source,
    /id:`sidebarElectron\.priorityThreads\.details\.codex`,defaultMessage:`Codex`,description:`Source label for a standalone Codex task in the Priority filter`/g,
    "standalone Codex detail label")[0];
  return source.replace(rowSource, patchedRow)
    .replace(label, "id:`sidebarElectron.thread.noWorkspace`,defaultMessage:`No workspace`,description:`Fallback shown beneath a sidebar task that has no workspace`") +
    `\nfunction __codexDefaultWorkspaceDetails(e){let group=${hook}(${projectGroup},e.threadKey);` +
    `return(0,${jsx}.jsx)(${details},{itemKind:\`local\`,projectGroup:group,sidebarMode:\`codex\`})}\n`;
}

export function patchCurrentSidePanel(source) {
  const marker = "__codex_hide_browser_side_panel_action";
  if (source.includes(marker)) return source;
  const functions = topLevelFunctions(source);
  const launcher = oneFunction(functions,
    value => value.includes("id:`thread.sidePanel.openTab`"), "side-panel launcher");
  const capability = oneMatch(launcher.source, /let [\w$]+=[\w$]+\([\w$]+,[\w$]+\)\.isCapable/g,
    "side-panel browser capability")[0];
  const replacement = launcher.source.replace(capability, capability.slice(0, capability.indexOf("=")) + `=!1/* ${marker} */`);
  return source.slice(0, launcher.node.start) + replacement + source.slice(launcher.node.end);
}
