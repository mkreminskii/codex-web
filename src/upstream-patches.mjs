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

  function pickWorkspaceRoot() {
    const selected = window.prompt("Enter one absolute Linux source folder path");
    if (selected === null) return;
    const root = selected.trim();
    if (!root.startsWith("/")) {
      window.alert("Enter an absolute Linux path.");
      return;
    }
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "workspace-root-option-picked", root },
      }),
    );
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
      if (message.type === "electron-pick-workspace-root-option") {
        pickWorkspaceRoot();
        return Promise.resolve();
      }
      return invoke("sendMessageFromView", [message]);
    },
    getPathForFile: () => unsupported("getPathForFile"),
    startFileDrag: () => unsupported("startFileDrag"),
    sendWorkerMessageFromView: (workerId, message) =>
      invoke("sendWorkerMessageFromView", [workerId, message]),
    subscribeToWorkerMessages,
    showContextMenu: options => invoke("showContextMenu", [options]),
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
    "showContextMenu",
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
  const buildEntries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(buildRoot),
  );
  const mainCandidates = buildEntries.filter(
    name => name.startsWith("main-") && name.endsWith(".js"),
  );
  if (mainCandidates.length !== 1) {
    throw new Error(
      `Expected one upstream main-process bundle, found ${mainCandidates.length}`,
    );
  }

  const mainPath = join(buildRoot, mainCandidates[0]);
  const indexPath = join(upstreamRoot, "webview", "index.html");
  const bridgePath = join(
    upstreamRoot,
    "webview",
    "__codex_browser_bridge.js",
  );

  const [preload, mainProcess, index] = await Promise.all([
    readFile(preloadPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(indexPath, "utf8"),
  ]);
  const patchedPreload = patchPreload(preload);
  const patchedMainProcess = patchMainProcess(mainProcess);
  const patchedIndex = patchWebviewIndex(index);

  await Promise.all([
    writeFile(preloadPath, patchedPreload),
    writeFile(mainPath, patchedMainProcess),
    writeFile(indexPath, patchedIndex),
    writeFile(bridgePath, browserBridgeSource),
  ]);

  return {
    mainBundle: mainCandidates[0],
    browserBridge: "__codex_browser_bridge.js",
  };
}
