import {
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const browserBridgeSource = String.raw`
(() => {
  if (globalThis.electronBridge !== undefined) return;

  const socketUrl = new URL("/__codex_bridge?role=browser", location.href);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  function loadBootstrap() {
    const request = new XMLHttpRequest();
    request.open("GET", "/__codex_bootstrap", false);
    request.send();
    if (request.status !== 200) {
      throw new Error("The upstream application bootstrap is unavailable");
    }
    const value = JSON.parse(request.responseText);
    if (
      value === null ||
      typeof value !== "object" ||
      value.sharedObjectSnapshot === null ||
      typeof value.sharedObjectSnapshot !== "object"
    ) {
      throw new Error("The upstream application bootstrap is invalid");
    }
    return value;
  }

  const bootstrap = loadBootstrap();
  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  const workerSubscribers = new Map();
  const queuedAppHostMessages = [];
  let appHostPort = null;
  let appHostRelayReady = false;
  let nextId = 0;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Codex host connection failed")), { once: true });
  });

  function relayError(payload) {
    const error = new Error(payload?.message ?? "Codex host operation failed");
    error.code = payload?.code ?? "codex_web_host_error";
    return error;
  }

  function rejectPending(payload) {
    const error = relayError(payload);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function updateSharedObject(key, value) {
    if (value === undefined) {
      delete bootstrap.sharedObjectSnapshot[key];
      return;
    }
    bootstrap.sharedObjectSnapshot[key] = value;
  }

  function closeAppHostPort() {
    appHostPort?.close();
    appHostPort = null;
    appHostRelayReady = false;
    queuedAppHostMessages.length = 0;
  }

  function sendAppHostMessage(message) {
    socket.send(JSON.stringify({ type: "app-host-message", message }));
  }

  window.addEventListener("message", event => {
    if (
      event.source !== window ||
      event.data?.type !== "connect-app-host" ||
      event.ports.length !== 1
    ) {
      return;
    }

    closeAppHostPort();
    const port = event.ports[0];
    appHostPort = port;
    port.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.ports.length !== 0) {
        socket.close(1003, "Unsupported app-host message");
        closeAppHostPort();
        return;
      }
      if (!appHostRelayReady) {
        queuedAppHostMessages.push(event.data);
        return;
      }
      sendAppHostMessage(event.data);
    });
    port.addEventListener("messageerror", () => {
      socket.close(1007, "Invalid app-host message");
      closeAppHostPort();
    });
    port.start();

    void opened.then(() => {
      if (appHostPort !== port) return;
      socket.send(JSON.stringify({ type: "connect-app-host" }));
      appHostRelayReady = true;
      for (const message of queuedAppHostMessages.splice(0)) {
        sendAppHostMessage(message);
      }
    }).catch(() => {
      if (appHostPort === port) closeAppHostPort();
    });
  });

  socket.addEventListener("message", event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "result") {
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(relayError(message.error));
      return;
    }
    if (message.type === "notification") {
      if (message.message?.type === "shared-object-updated") {
        updateSharedObject(message.message.key, message.message.value);
      }
      window.dispatchEvent(new MessageEvent("message", { data: message.message }));
      return;
    }
    if (message.type === "worker-message") {
      for (const subscriber of workerSubscribers.get(message.workerId) ?? []) {
        subscriber(message.message);
      }
      return;
    }
    if (message.type === "app-host-message") {
      if (typeof message.message !== "string") {
        socket.close(1007, "Invalid app-host message");
        closeAppHostPort();
        return;
      }
      appHostPort?.postMessage(message.message);
      return;
    }
    if (message.type === "app-host-error") {
      console.error(message.error?.message ?? "The upstream app-host tunnel failed");
      closeAppHostPort();
      return;
    }
    if (message.type === "host-disconnected") {
      closeAppHostPort();
      rejectPending(message.error);
    }
  });

  socket.addEventListener("close", () => {
    closeAppHostPort();
    rejectPending({
      code: "codex_web_host_disconnected",
      message: "The upstream application host disconnected",
    });
  });

  async function invoke(method, args = []) {
    await opened;
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "invoke", id, method, args }));
    });
  }

  function unsupported(operation) {
    const error = new Error("Unsupported Electron operation in codex-web: " + operation);
    error.code = "codex_web_unsupported_operation";
    throw error;
  }

  function subscribeToWorkerMessages(workerId, callback) {
    let subscribers = workerSubscribers.get(workerId);
    if (subscribers === undefined) {
      subscribers = new Set();
      workerSubscribers.set(workerId, subscribers);
      void opened.then(() => {
        socket.send(JSON.stringify({ type: "subscribe-worker", workerId }));
      });
    }
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
      if (subscribers.size !== 0) return;
      workerSubscribers.delete(workerId);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe-worker", workerId }));
      }
    };
  }

  const dark = matchMedia("(prefers-color-scheme: dark)");
  let systemThemeVariant = bootstrap.systemThemeVariant;
  document.documentElement.classList.add(
    systemThemeVariant === "dark" ? "electron-dark" : "electron-light",
  );

  const bridge = Object.freeze({
    windowType: "electron",
    getPreloadStartedAtMs: () => performance.timeOrigin,
    sendMessageFromView: message => {
      if (message.type === "shared-object-set") {
        updateSharedObject(message.key, message.value);
      }
      return invoke("sendMessageFromView", [message]);
    },
    getPathForFile: () => unsupported("getPathForFile"),
    startFileDrag: () => unsupported("startFileDrag"),
    sendWorkerMessageFromView: (workerId, message) =>
      invoke("sendWorkerMessageFromView", [workerId, message]),
    subscribeToWorkerMessages,
    // The upstream renderer uses its web menu when this Electron-only method is absent.
    getFastModeRolloutMetrics: () => invoke("getFastModeRolloutMetrics"),
    getSharedObjectSnapshotValue: key => bootstrap.sharedObjectSnapshot[key],
    getInitialSidebarBootstrap: () => bootstrap.initialSidebarBootstrap,
    getSystemThemeVariant: () => systemThemeVariant,
    subscribeToSystemThemeVariant: callback => {
      const listener = event => {
        systemThemeVariant = event.matches ? "dark" : "light";
        callback(systemThemeVariant);
      };
      dark.addEventListener("change", listener);
      return () => dark.removeEventListener("change", listener);
    },
    triggerSentryTestError: () => invoke("triggerSentryTestError"),
    getSentryInitOptions: () => bootstrap.sentryInitOptions,
    getAppSessionId: () => bootstrap.appSessionId,
    getBuildFlavor: () => bootstrap.buildFlavor,
    isDeviceCheckSupported: () => bootstrap.deviceCheckSupported,
    isIntelMacBuild: () => bootstrap.intelMacBuild,
    usesOwlAppShell: () => bootstrap.usesOwlAppShell,
  });

  Object.defineProperty(globalThis, "codexWindowType", {
    value: "electron",
    configurable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, "electronBridge", {
    value: bridge,
    configurable: false,
    writable: false,
  });
})();
`;

function hostRelaySource(electronAlias, bridgeAlias, sharedObjectAlias) {
  const allowedMethods = [
    "sendMessageFromView",
    "sendWorkerMessageFromView",
    "getFastModeRolloutMetrics",
    "triggerSentryTestError",
  ];
  return `(() => {
    const relayUrl = process.env.CODEX_WEB_RELAY_URL;
    if (!relayUrl) return;

    const socket = new WebSocket(relayUrl);
    const workerSubscriptions = new Map();
    const allowedMethods = new Set(${JSON.stringify(allowedMethods)});
    let appHostPort = null;

    const createBootstrap = () => ({
      appSessionId: ${bridgeAlias}.getAppSessionId(),
      buildFlavor: ${bridgeAlias}.getBuildFlavor(),
      deviceCheckSupported: ${bridgeAlias}.isDeviceCheckSupported(),
      initialSidebarBootstrap: ${bridgeAlias}.getInitialSidebarBootstrap(),
      intelMacBuild: ${bridgeAlias}.isIntelMacBuild(),
      sentryInitOptions: ${bridgeAlias}.getSentryInitOptions(),
      sharedObjectSnapshot: ${sharedObjectAlias},
      systemThemeVariant: ${bridgeAlias}.getSystemThemeVariant(),
      usesOwlAppShell: ${bridgeAlias}.usesOwlAppShell(),
    });

    const send = message => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    const closeAppHostPort = () => {
      appHostPort?.close();
      appHostPort = null;
    };
    const failAppHost = message => {
      send({
        type: "app-host-error",
        error: {
          code: "codex_web_app_host_tunnel_error",
          message,
        },
      });
      closeAppHostPort();
    };

    window.addEventListener("message", event => {
      if (event.source == null) {
        send({ type: "notification", message: event.data });
      }
    });
    socket.addEventListener("open", () => {
      send({ type: "bootstrap", value: createBootstrap() });
      send({ type: "ready" });
    });
    socket.addEventListener("message", async event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message?.type === "invoke") {
        if (typeof message.id !== "string" || !allowedMethods.has(message.method)) {
          send({
            type: "result",
            id: message?.id,
            ok: false,
            error: {
              code: "codex_web_unsupported_operation",
              message: "Unsupported host bridge method",
            },
          });
          return;
        }
        try {
          const value = await ${bridgeAlias}[message.method](
            ...(Array.isArray(message.args) ? message.args : []),
          );
          send({ type: "result", id: message.id, ok: true, value });
        } catch (error) {
          send({
            type: "result",
            id: message.id,
            ok: false,
            error: {
              code: error?.code ?? "codex_web_host_error",
              message: String(error?.message ?? error),
            },
          });
        }
        return;
      }

      if (message?.type === "connect-app-host") {
        closeAppHostPort();
        const { port1, port2 } = new MessageChannel();
        appHostPort = port1;
        port1.addEventListener("message", event => {
          if (typeof event.data !== "string" || event.ports.length !== 0) {
            failAppHost("The upstream app-host sent an unsupported message");
            return;
          }
          send({ type: "app-host-message", message: event.data });
        });
        port1.addEventListener("messageerror", () => {
          failAppHost("The upstream app-host sent an invalid message");
        });
        port1.start();
        ${electronAlias}.ipcRenderer.postMessage(
          "codex_desktop:connect-app-host",
          undefined,
          [port2],
        );
        return;
      }

      if (message?.type === "app-host-message") {
        if (typeof message.message !== "string") {
          failAppHost("The browser sent an invalid app-host message");
          return;
        }
        if (appHostPort === null) {
          failAppHost("The browser app-host port is not connected");
          return;
        }
        appHostPort.postMessage(message.message);
        return;
      }

      if (message?.type === "browser-disconnected") {
        closeAppHostPort();
        return;
      }

      if (
        (message?.type === "subscribe-worker" ||
          message?.type === "unsubscribe-worker") &&
        typeof message.workerId === "string" &&
        /^[A-Za-z0-9:_-]{1,128}$/.test(message.workerId)
      ) {
        if (
          message.type === "subscribe-worker" &&
          !workerSubscriptions.has(message.workerId)
        ) {
          const dispose = ${bridgeAlias}.subscribeToWorkerMessages(
            message.workerId,
            workerMessage =>
              send({
                type: "worker-message",
                workerId: message.workerId,
                message: workerMessage,
              }),
          );
          workerSubscriptions.set(message.workerId, dispose);
        } else if (message.type === "unsubscribe-worker") {
          workerSubscriptions.get(message.workerId)?.();
          workerSubscriptions.delete(message.workerId);
        }
      }
    });
    socket.addEventListener("close", () => {
      closeAppHostPort();
      for (const dispose of workerSubscriptions.values()) dispose();
      workerSubscriptions.clear();
    });
  })()`;
}

const appServerProxyMarker = "CODEX_WEB_APP_SERVER_PROXY";
const appServerLaunchPattern =
  /`app-server`\s*,\s*`--analytics-default-enabled`\s*\]\}/g;
const appServerCommandPattern =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\((\{hostConfig:([A-Za-z_$][\w$]*)\.hostConfig,repoRoot:\4\.repoRoot,resourcesPath:\4\.resourcesPath\})\);(?=if\(!\1\)return null;let [A-Za-z_$][\w$]*=\{\.\.\.process\.env,LOG_FORMAT:`json`)/g;

function patchAppServerTransport(source) {
  if (source.includes(appServerProxyMarker)) {
    return source;
  }
  const launchMatches = [...source.matchAll(appServerLaunchPattern)];
  if (launchMatches.length !== 1) {
    throw new Error(
      `Expected one upstream local app-server launch, found ${launchMatches.length}`,
    );
  }
  const commandMatches = [...source.matchAll(appServerCommandPattern)];
  if (commandMatches.length !== 1) {
    throw new Error(
      `Expected one upstream local app-server command, found ${commandMatches.length}`,
    );
  }

  const [command, configAlias, resolverAlias, optionsSource] = commandMatches[0];
  const markedSource = source.replace(
    launchMatches[0][0],
    `/* ${appServerProxyMarker} */${launchMatches[0][0]}`,
  );
  return markedSource.replace(
    command,
    `let ${configAlias}=process.env.CODEX_WEB_APP_SERVER_PROXY_PATH?{executablePath:process.env.CODEX_WEB_APP_SERVER_PROXY_PATH,args:[]}:${resolverAlias}(${optionsSource});`,
  );
}

async function findAppServerTransportBundle(buildRoot, buildEntries) {
  const candidates = [];
  for (const name of buildEntries.filter(name => name.endsWith(".js"))) {
    const path = join(buildRoot, name);
    const source = await readFile(path, "utf8");
    const launchCount = [...source.matchAll(appServerLaunchPattern)].length;
    if (source.includes(appServerProxyMarker) || launchCount !== 0) {
      candidates.push({ name, path, source });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one upstream local app-server bundle, found ${candidates.length}`,
    );
  }
  const [candidate] = candidates;
  return {
    name: candidate.name,
    path: candidate.path,
    source: candidate.source,
  };
}

function patchPreload(source) {
  if (source.includes("CODEX_WEB_RELAY_URL")) {
    return source;
  }

  const exposePattern =
    /([A-Za-z_$][\w$]*)\.contextBridge\.exposeInMainWorld\(`electronBridge`,([A-Za-z_$][\w$]*)\)/g;
  const matches = [...source.matchAll(exposePattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one upstream electronBridge exposure, found ${matches.length}`,
    );
  }

  const [match, electronAlias, bridgeAlias] = matches[0];
  const sharedObjectPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.ipcRenderer\.sendSync\(`codex_desktop:get-shared-object-snapshot`\)\?\?\{\}/g;
  const sharedObjectMatches = [...source.matchAll(sharedObjectPattern)].filter(
    candidate => candidate[2] === electronAlias,
  );
  if (sharedObjectMatches.length !== 1) {
    throw new Error(
      `Expected one upstream shared-object snapshot, found ${sharedObjectMatches.length}`,
    );
  }
  const sharedObjectAlias = sharedObjectMatches[0][1];
  return source.replace(
    match,
    `${match},${hostRelaySource(electronAlias, bridgeAlias, sharedObjectAlias)}`,
  );
}

function patchMainProcess(source) {
  if (source.includes("CODEX_WEB_HEADLESS")) {
    return source;
  }

  const windowOptionsPattern =
    /backgroundColor:([A-Za-z_$][\w$]*),show:([A-Za-z_$][\w$]*),parent:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)===void 0\?\{\}:\{focusable:\4\}/g;
  const matches = [...source.matchAll(windowOptionsPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one upstream primary window option block, found ${matches.length}`,
    );
  }

  const [match, backgroundAlias, showAlias, parentAlias, focusableAlias] =
    matches[0];
  const replacement =
    `backgroundColor:${backgroundAlias},show:process.env.CODEX_WEB_HEADLESS===\`1\`?!1:${showAlias},` +
    `parent:${parentAlias},...${focusableAlias}===void 0?{}:{focusable:${focusableAlias}}`;
  return source.replace(match, replacement);
}

function patchWebviewRenderer(source) {
  if (source.includes("__codex_local_folder_browser")) {
    return source;
  }

  const pickerPattern =
    /function [A-Za-z_$][\w$]*\(\)\{[A-Za-z_$][\w$]*\.dispatchMessage\(`electron-pick-workspace-root-option`,\{allowMultiple:!0\}\)\}/g;
  const pickerMatches = [...source.matchAll(pickerPattern)];
  if (pickerMatches.length !== 1) {
    throw new Error(
      `Expected one upstream local workspace folder picker, found ${pickerMatches.length}`,
    );
  }
  const pickerSource = pickerMatches[0][0];
  const pickerStart = pickerMatches[0].index;

  const localComponentStart = source.lastIndexOf("function ", pickerStart - 1);
  const localHeader = /^function ([A-Za-z_$][\w$]*)\(e\)\{/.exec(
    source.slice(localComponentStart),
  );
  if (localComponentStart === -1 || localHeader === null) {
    throw new Error("Upstream local project source-folder component was not found");
  }

  const localComponentSource = source.slice(localComponentStart, pickerStart);
  if (!localComponentSource.includes("workspace-root-option-picked")) {
    throw new Error("Upstream local project source-folder event contract was not found");
  }

  const layoutAliases =
    /\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(([A-Za-z_$][\w$]*),\{className:`gap-2`,children:\[k,/.exec(
      localComponentSource,
    );
  const messageAlias =
    /\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`projectSetup\.createLocalProject\.sourceFoldersLabel`/.exec(
      localComponentSource,
    )?.[1];
  if (layoutAliases === null || messageAlias === undefined) {
    throw new Error("Upstream local project source-folder layout was not found");
  }

  const remoteQueryIndex = source.indexOf(
    "`remote-workspace-directory-entries`",
    pickerStart + pickerSource.length,
  );
  const remoteComponentStart = source.lastIndexOf("function ", remoteQueryIndex);
  const remoteHeader = /^function ([A-Za-z_$][\w$]*)\(e\)\{/.exec(
    source.slice(remoteComponentStart),
  );
  if (remoteQueryIndex === -1 || remoteComponentStart === -1 || remoteHeader === null) {
    throw new Error("Upstream remote source-folder browser was not found");
  }

  const initializerMatch = /=n\(\(\(\)=>\{/.exec(
    source.slice(remoteComponentStart),
  );
  if (initializerMatch === null) {
    throw new Error("Upstream remote source-folder browser module was not found");
  }
  const initializerEquals =
    remoteComponentStart + initializerMatch.index;
  const initializerName = /([A-Za-z_$][\w$]*)$/.exec(
    source.slice(Math.max(0, initializerEquals - 256), initializerEquals),
  )?.[1];
  if (initializerName === undefined) {
    throw new Error("Upstream remote source-folder browser initializer was not found");
  }

  const [, jsxAlias, sectionAlias] = layoutAliases;
  const localComponentName = localHeader[1];
  const remoteComponentName = remoteHeader[1];
  const replacement =
    `function ${localComponentName}(e){${initializerName}();` +
    "let{sources:t,setSources:n}=e,r=t[0]??``,i=e=>{n(e.length===0?[]:[e])};" +
    "return/* __codex_local_folder_browser */" +
    `(0,${jsxAlias}.jsxs)(${sectionAlias},{className:\`gap-2\`,children:[` +
    `(0,${jsxAlias}.jsx)(\`span\`,{className:\`text-sm font-medium text-token-text-primary select-none\`,` +
    `children:(0,${jsxAlias}.jsx)(${messageAlias},{id:\`projectSetupDialog.remoteSourceFolder\`,` +
    "defaultMessage:`Source folder`,description:`Label for the local project source folder browser`})})," +
    `(0,${jsxAlias}.jsx)(${remoteComponentName},{hostId:\`local\`,initialDirectoryPath:null,` +
    "selectedPath:r,setSelectedPath:i})]})}";

  return source.replace(
    source.slice(localComponentStart, pickerStart + pickerSource.length),
    replacement,
  );
}

function patchWebviewIndex(source) {
  if (source.includes("__codex_browser_bridge.js")) {
    return source;
  }
  const tag = '<script src="./__codex_browser_bridge.js"></script>';
  if (source.includes("</head>")) {
    return source.replace("</head>", `${tag}</head>`);
  }
  throw new Error("Upstream webview index has no closing head element");
}

export async function applyUpstreamWebPatches(upstreamRoot) {
  const preloadPath = join(upstreamRoot, ".vite", "build", "preload.js");
  const buildRoot = join(upstreamRoot, ".vite", "build");
  const webviewRoot = join(upstreamRoot, "webview");
  const assetsRoot = join(webviewRoot, "assets");
  const { readdir } = await import("node:fs/promises");
  const [buildEntries, assetEntries] = await Promise.all([
    readdir(buildRoot),
    readdir(assetsRoot),
  ]);
  const mainCandidates = buildEntries.filter(
    name => name.startsWith("main-") && name.endsWith(".js"),
  );
  if (mainCandidates.length !== 1) {
    throw new Error(
      `Expected one upstream main-process bundle, found ${mainCandidates.length}`,
    );
  }
  const rendererCandidates = assetEntries.filter(
    name => name.startsWith("app-initial-") && name.endsWith(".js"),
  );
  if (rendererCandidates.length !== 1) {
    throw new Error(
      `Expected one upstream webview renderer bundle, found ${rendererCandidates.length}`,
    );
  }

  const appServerTransport = await findAppServerTransportBundle(buildRoot, buildEntries);
  const mainPath = join(buildRoot, mainCandidates[0]);
  const indexPath = join(webviewRoot, "index.html");
  const rendererPath = join(assetsRoot, rendererCandidates[0]);
  const bridgePath = join(webviewRoot, "__codex_browser_bridge.js");

  const [preload, mainProcess, index, renderer] = await Promise.all([
    appServerTransport.path === preloadPath
      ? appServerTransport.source
      : readFile(preloadPath, "utf8"),
    appServerTransport.path === mainPath
      ? appServerTransport.source
      : readFile(mainPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(rendererPath, "utf8"),
  ]);
  let patchedPreload = patchPreload(preload);
  let patchedMainProcess = patchMainProcess(mainProcess);
  const patchedIndex = patchWebviewIndex(index);
  const patchedRenderer = patchWebviewRenderer(renderer);
  let patchedAppServerTransport = null;
  if (appServerTransport.path === preloadPath) {
    patchedPreload = patchAppServerTransport(patchedPreload);
  } else if (appServerTransport.path === mainPath) {
    patchedMainProcess = patchAppServerTransport(patchedMainProcess);
  } else {
    patchedAppServerTransport = patchAppServerTransport(appServerTransport.source);
  }

  await Promise.all([
    writeFile(preloadPath, patchedPreload),
    writeFile(mainPath, patchedMainProcess),
    writeFile(indexPath, patchedIndex),
    writeFile(rendererPath, patchedRenderer),
    writeFile(bridgePath, browserBridgeSource),
    ...(patchedAppServerTransport === null
      ? []
      : [writeFile(appServerTransport.path, patchedAppServerTransport)]),
  ]);

  return {
    mainBundle: mainCandidates[0],
    appServerTransportBundle: appServerTransport.name,
    rendererBundle: rendererCandidates[0],
    browserBridge: "__codex_browser_bridge.js",
  };
}
