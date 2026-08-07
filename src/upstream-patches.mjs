import {
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export function keyboardShortcutSignature(event, isMacOS) {
  const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);
  if (modifierKeys.has(event.key)) return null;

  const specialKeys = new Map([
    [" ", "space"],
    ["+", "plus"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["Esc", "escape"],
    ["Return", "enter"],
  ]);
  const key = specialKeys.get(event.key) ?? event.key.toLowerCase();
  if (key.length === 0) return null;

  const parts = [];
  if (event.altKey) parts.push(isMacOS ? "option" : "alt");
  if (event.ctrlKey) parts.push("control");
  if (event.metaKey) parts.push(isMacOS ? "command" : "super");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.sort().join("+");
}

const browserBridgeSource = String.raw`
(() => {
  if (globalThis.electronBridge !== undefined) return;
  const keyboardShortcutSignature = ${keyboardShortcutSignature.toString()};

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
  const keyboardShortcuts = new Set();
  let keyboardShortcutsUseMacModifiers = false;

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

  function showAboutDialog(html) {
    if (typeof html !== "string") return;

    document.getElementById("__codex_web_about_dialog")?.remove();
    const dialog = document.createElement("dialog");
    const frame = document.createElement("iframe");
    const title = new DOMParser().parseFromString(html, "text/html").title;
    dialog.id = "__codex_web_about_dialog";
    dialog.setAttribute("aria-label", title);
    dialog.style.cssText =
      "border:0;border-radius:12px;inset:auto;left:50%;margin:0;max-height:calc(100vh - 32px);max-width:calc(100vw - 32px);overflow:auto;padding:0;position:fixed;top:50%;transform:translate(-50%,-50%)";
    frame.title = title;
    frame.style.cssText = "border:0;display:block;width:min(360px,calc(100vw - 32px))";
    frame.srcdoc = html;

    const close = () => {
      if (dialog.open) dialog.close();
    };
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    frame.addEventListener("load", () => {
      const contentDocument = frame.contentDocument;
      if (contentDocument === null) return;
      frame.style.height =
        Math.ceil(contentDocument.documentElement.scrollHeight) + "px";
      contentDocument.addEventListener("click", event => {
        const ok = event.target?.closest?.("#ok");
        if (ok === null || ok === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }, { capture: true });
      contentDocument.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }, { capture: true });
      contentDocument.getElementById("ok")?.focus();
    });

    dialog.append(frame);
    document.body.append(dialog);
    dialog.showModal();
  }

  function handleHostNotification(message) {
    if (message?.type === "__codex_web_keyboard_shortcuts_updated") {
      void loadKeyboardShortcuts().catch(() => undefined);
      return;
    }
    if (message?.type === "__codex_web_about") {
      showAboutDialog(message.html);
      return;
    }
    if (message?.type === "shared-object-updated") {
      updateSharedObject(message.key, message.value);
    }
    window.dispatchEvent(new MessageEvent("message", { data: message }));
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
      handleHostNotification(message.message);
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

  async function loadKeyboardShortcuts() {
    const value = await invoke("getKeyboardShortcuts");
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.isMacOS !== "boolean" ||
      !Array.isArray(value.shortcuts) ||
      !value.shortcuts.every(shortcut => typeof shortcut === "string")
    ) {
      throw new Error("The upstream keyboard shortcut registry is invalid");
    }
    keyboardShortcutsUseMacModifiers = value.isMacOS;
    keyboardShortcuts.clear();
    for (const shortcut of value.shortcuts) keyboardShortcuts.add(shortcut);
  }

  void loadKeyboardShortcuts().catch(() => undefined);
  window.addEventListener("focus", () => {
    void loadKeyboardShortcuts().catch(() => undefined);
  });
  window.addEventListener("keydown", event => {
    const signature = keyboardShortcutSignature(
      event,
      keyboardShortcutsUseMacModifiers,
    );
    if (signature === null || !keyboardShortcuts.has(signature)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke("dispatchKeyboardShortcut", [{
      signature,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
    }]).then(value => {
      if (
        value !== null &&
        typeof value === "object" &&
        Array.isArray(value.messages)
      ) {
        for (const message of value.messages) handleHostNotification(message);
      }
    }).catch(() => undefined);
  }, { capture: true });

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
    triggerSentryTestError: () => undefined,
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
    "dispatchKeyboardShortcut",
    "getKeyboardShortcuts",
    "sendMessageFromView",
    "sendWorkerMessageFromView",
    "getFastModeRolloutMetrics",
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
      sentryInitOptions: null,
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
      if (
        event.source == null ||
        (event.source === window && event.data?.type === "__codex_web_about")
      ) {
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
          const keyboardShortcutMethod =
            message.method === "dispatchKeyboardShortcut" ||
            message.method === "getKeyboardShortcuts";
          const value = keyboardShortcutMethod
            ? await ${electronAlias}.ipcRenderer.invoke(
                "__codex_web_keyboard_shortcut",
                {
                  type: message.method === "getKeyboardShortcuts" ? "list" : "dispatch",
                  event: Array.isArray(message.args) ? message.args[0] : undefined,
                },
              )
            : await ${bridgeAlias}[message.method](
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

const appServerAnalyticsDefaultFlag = "`--analytics-default-enabled`";
const appServerAnalyticsDisabledArguments = "`-c`,`analytics.enabled=false`";
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
    `/* ${appServerProxyMarker} */${launchMatches[0][0].replace(appServerAnalyticsDefaultFlag, appServerAnalyticsDisabledArguments)}`,
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

function keyboardShortcutMainSource(
  electronAlias,
  menuAlias,
  windowManagerAlias,
  browserShortcutSetAlias,
) {
  return `(() => {
    const channel = "__codex_web_keyboard_shortcut";
    const normalize = accelerator => accelerator.split("+").map(part => {
      switch (part.toLowerCase()) {
        case "cmdorctrl":
        case "commandorcontrol":
          return process.platform === "darwin" ? "command" : "control";
        case "cmd":
        case "command":
          return "command";
        case "control":
        case "ctrl":
          return "control";
        case "option":
          return process.platform === "darwin" ? "option" : "alt";
        case "alt":
          return "alt";
        case "meta":
        case "super":
          return process.platform === "darwin" ? "command" : "super";
        case "enter":
        case "return":
          return "enter";
        case "esc":
        case "escape":
          return "escape";
        case "plus":
          return "plus";
        default:
          return part.toLowerCase();
      }
    }).sort().join("+");
    const collect = menu => menu.items.flatMap(item => [
      item,
      ...(item.submenu == null ? [] : collect(item.submenu)),
    ]);
    let dispatchQueue = Promise.resolve();
    ${electronAlias}.ipcMain.removeHandler(channel);
    ${electronAlias}.ipcMain.handle(channel, async (_event, request) => {
      const items = collect(${menuAlias}).filter(
        item =>
          typeof item.accelerator === "string" &&
          typeof item.click === "function" &&
          ${browserShortcutSetAlias}.has(normalize(item.accelerator)),
      );
      const shortcuts = new Map(items.map(item => [normalize(item.accelerator), item]));
      if (request?.type === "list") {
        return {
          isMacOS: process.platform === "darwin",
          shortcuts: [...shortcuts.keys()],
        };
      }
      if (
        request?.type !== "dispatch" ||
        typeof request.event?.signature !== "string"
      ) {
        return false;
      }
      const item = shortcuts.get(request.event.signature);
      if (item === undefined || item.enabled === false) {
        return { handled: false, messages: [] };
      }
      const dispatch = async () => {
        const windows = ${electronAlias}.BrowserWindow.getAllWindows().filter(
          window => !window.isDestroyed(),
        );
        const messages = [];
        const originalSendMessageToWindow =
          ${windowManagerAlias}.sendMessageToWindow;
        ${windowManagerAlias}.sendMessageToWindow = (_window, message) => {
          messages.push(message);
        };
        try {
          const browserWindow =
            ${electronAlias}.BrowserWindow.fromWebContents(_event.sender) ??
            ${electronAlias}.BrowserWindow.getFocusedWindow() ??
            windows[0];
          await item.click(item, browserWindow, {
            triggeredByAccelerator: true,
            altKey: request.event.altKey === true,
            ctrlKey: request.event.ctrlKey === true,
            metaKey: request.event.metaKey === true,
            repeat: request.event.repeat === true,
            shiftKey: request.event.shiftKey === true,
          });
          return { handled: true, messages };
        } finally {
          ${windowManagerAlias}.sendMessageToWindow =
            originalSendMessageToWindow;
        }
      };
      const result = dispatchQueue.then(dispatch, dispatch);
      dispatchQueue = result.then(() => undefined, () => undefined);
      return result;
    });
    for (const window of ${electronAlias}.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(
          "codex_desktop:message-for-view",
          { type: "__codex_web_keyboard_shortcuts_updated" },
        );
      }
    }
  })()`;
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

  const aboutDialogPattern =
    /async function [A-Za-z_$][\w$]*\(\{buildFlavor:[A-Za-z_$][\w$]*,parent:([A-Za-z_$][\w$]*)\}\)\{/g;
  const aboutDialogMatches = [...source.matchAll(aboutDialogPattern)];
  if (aboutDialogMatches.length !== 1) {
    throw new Error(
      `Expected one upstream About dialog handler, found ${aboutDialogMatches.length}`,
    );
  }

  const aboutWindowPattern =
    /,([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\.BrowserWindow\(\{width:[A-Za-z_$][\w$]*,height:[A-Za-z_$][\w$]*,useContentSize:!0,title:[A-Za-z_$][\w$]*,show:!1,resizable:!1,minimizable:!1,maximizable:!1,fullscreenable:!1,autoHideMenuBar:!0,/g;
  const aboutWindowMatches = [...source.matchAll(aboutWindowPattern)];
  if (aboutWindowMatches.length !== 1) {
    throw new Error(
      `Expected one upstream About dialog window, found ${aboutWindowMatches.length}`,
    );
  }

  const aboutHtmlPattern =
    /[A-Za-z_$][\w$]*\(\{appDisplayName:[A-Za-z_$][\w$]*,buildInfoLabel:[A-Za-z_$][\w$]*,buildInfoText:[A-Za-z_$][\w$]*,iconDataUrl:[A-Za-z_$][\w$]*\.htmlIconDataUrl,isDark:[A-Za-z_$][\w$]*,okLabel:[A-Za-z_$][\w$]*,title:[A-Za-z_$][\w$]*\}\)/g;
  const aboutHtmlMatches = [...source.matchAll(aboutHtmlPattern)];
  if (aboutHtmlMatches.length !== 1) {
    throw new Error(
      `Expected one upstream About dialog HTML payload, found ${aboutHtmlMatches.length}`,
    );
  }

  const applicationMenuPattern =
    /([A-Za-z_$][\w$]*)\.Menu\.setApplicationMenu\(([A-Za-z_$][\w$]*)\)/g;
  const applicationMenuMatches = [...source.matchAll(applicationMenuPattern)];
  if (applicationMenuMatches.length !== 1) {
    throw new Error(
      `Expected one upstream application menu installation, found ${applicationMenuMatches.length}`,
    );
  }

  const menuTargetPattern =
    /([A-Za-z_$][\w$]*)=async\(\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.BrowserWindow\.getFocusedWindow\(\);return \2&&!\2\.isDestroyed\(\)\?\2:([A-Za-z_$][\w$]*)\(\)\}/g;
  const menuTargetMatches = [...source.matchAll(menuTargetPattern)];
  if (menuTargetMatches.length !== 1) {
    throw new Error(
      `Expected one upstream application menu target resolver, found ${menuTargetMatches.length}`,
    );
  }

  const commandMenuMessagePattern =
    /([A-Za-z_$][\w$]*)\.sendMessageToWindow\([A-Za-z_$][\w$]*,\{type:`command-menu`,query:[A-Za-z_$][\w$]*\}\)/g;
  const commandMenuMessageMatches = [...source.matchAll(commandMenuMessagePattern)];
  if (commandMenuMessageMatches.length !== 1) {
    throw new Error(
      `Expected one upstream command menu message sender, found ${commandMenuMessageMatches.length}`,
    );
  }

  const browserShortcutSetPattern =
    /`isOverridableByBrowserWebpage`in [\s\S]{0,600}?\)\),([A-Za-z_$][\w$]*)=new Set;for\(let/g;
  const browserShortcutSetMatches = [...source.matchAll(browserShortcutSetPattern)];
  if (browserShortcutSetMatches.length !== 1) {
    throw new Error(
      `Expected one upstream browser shortcut set, found ${browserShortcutSetMatches.length}`,
    );
  }

  const [match, backgroundAlias, showAlias, parentAlias, focusableAlias] =
    matches[0];
  const replacement =
    `backgroundColor:${backgroundAlias},show:process.env.CODEX_WEB_HEADLESS===\`1\`?!1:${showAlias},` +
    `parent:${parentAlias},...${focusableAlias}===void 0?{}:{focusable:${focusableAlias}}`;
  const aboutParentAlias = aboutDialogMatches[0][1];
  const aboutWindowHeader = aboutWindowMatches[0][0];
  const aboutWindowAlias = aboutWindowMatches[0][1];
  const aboutHtmlSource = aboutHtmlMatches[0][0];
  const aboutWindowReplacement =
    `;if(process.env.CODEX_WEB_HEADLESS===\`1\`){` +
    `if(${aboutParentAlias}!=null&&!${aboutParentAlias}.isDestroyed())` +
    `await ${aboutParentAlias}.webContents.executeJavaScript(` +
    `\`window.postMessage(\${JSON.stringify({type:"__codex_web_about",html:${aboutHtmlSource}})},location.origin)\`` +
    `);return}let ${aboutWindowAlias}=${aboutWindowHeader.slice(
      aboutWindowHeader.indexOf("new "),
    )}`;
  const [applicationMenuSource, electronAlias, menuAlias] =
    applicationMenuMatches[0];
  const windowManagerAlias = commandMenuMessageMatches[0][1];
  const browserShortcutSetAlias = browserShortcutSetMatches[0][1];
  const applicationMenuReplacement =
    `${applicationMenuSource},${keyboardShortcutMainSource(
      electronAlias,
      menuAlias,
      windowManagerAlias,
      browserShortcutSetAlias,
    )}`;
  const [
    menuTargetSource,
    menuTargetFunctionAlias,
    focusedWindowAlias,
    menuElectronAlias,
    ensureWindowAlias,
  ] = menuTargetMatches[0];
  const menuTargetReplacement =
    `${menuTargetFunctionAlias}=async()=>{let ${focusedWindowAlias}=` +
    `${menuElectronAlias}.BrowserWindow.getFocusedWindow();return ` +
    `${focusedWindowAlias}&&!${focusedWindowAlias}.isDestroyed()?${focusedWindowAlias}:` +
    `process.env.CODEX_WEB_HEADLESS===\`1\`?` +
    `${menuElectronAlias}.BrowserWindow.getAllWindows().find(window=>!window.isDestroyed())??` +
    `${ensureWindowAlias}():${ensureWindowAlias}()}`;
  return source
    .replace(match, replacement)
    .replace(aboutWindowHeader, aboutWindowReplacement)
    .replace(applicationMenuSource, applicationMenuReplacement)
    .replace(menuTargetSource, menuTargetReplacement);
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

const remoteTelemetryMarker = "__codex_disable_remote_telemetry";

function patchRendererRemoteTelemetry(source) {
  if (source.includes(remoteTelemetryMarker)) {
    return source;
  }

  const statsigOptionsPattern =
    /([A-Za-z_$][\w$]*)=\{networkConfig:\{api:([A-Za-z_$][\w$]*),logEventUrl:([A-Za-z_$][\w$]*),sdkExceptionUrl:([A-Za-z_$][\w$]*),networkOverrideFunc:([A-Za-z_$][\w$]*)\}\},([A-Za-z_$][\w$]*)=\{\.\.\.\1,disableStorage:!0,loggingEnabled:`disabled`\}/g;
  const statsigOptionsMatches = [...source.matchAll(statsigOptionsPattern)];
  if (statsigOptionsMatches.length !== 1) {
    throw new Error(
      `Expected one upstream Statsig options block, found ${statsigOptionsMatches.length}`,
    );
  }

  const [
    statsigOptionsSource,
    optionsAlias,
    apiUrlAlias,
    logEventUrlAlias,
    sdkExceptionUrlAlias,
    networkOverrideAlias,
    fallbackOptionsAlias,
  ] = statsigOptionsMatches[0];
  const networkOverride =
    `(url,options)=>url===${logEventUrlAlias}||url===${sdkExceptionUrlAlias}` +
    `?Promise.resolve(new Response(null,{status:204})):${networkOverrideAlias}(url,options)`;
  let patched = source.replace(
    statsigOptionsSource,
    `${optionsAlias}={networkConfig:{api:${apiUrlAlias},logEventUrl:${logEventUrlAlias},` +
      `sdkExceptionUrl:${sdkExceptionUrlAlias},networkOverrideFunc:${networkOverride}},` +
      `disableStorage:!0,loggingEnabled:\`disabled\`},` +
      `${fallbackOptionsAlias}=${optionsAlias}/* ${remoteTelemetryMarker} */`,
  );

  const codexAnalyticsPattern =
    /submitCodexAnalyticsEvent:[A-Za-z_$][\w$]*===`chatgpt`\?[A-Za-z_$][\w$]*:null/g;
  const codexAnalyticsMatches = [...patched.matchAll(codexAnalyticsPattern)];
  if (codexAnalyticsMatches.length !== 1) {
    throw new Error(
      `Expected one upstream Codex analytics provider, found ${codexAnalyticsMatches.length}`,
    );
  }

  patched = patched.replace(
    codexAnalyticsMatches[0][0],
    "submitCodexAnalyticsEvent:null",
  );
  return patched;
}

function patchProfilePetAction(source) {
  const marker = "__codex_hide_profile_pet_action";
  if (source.includes(marker)) {
    return source;
  }

  const label = "id:`codex.profileFooter.showPet`";
  const labelMatches = source.split(label).length - 1;
  if (labelMatches !== 1) {
    throw new Error(
      `Expected one upstream profile pet action, found ${labelMatches}`,
    );
  }

  const labelIndex = source.indexOf(label);
  const componentTail = source.slice(labelIndex, labelIndex + 5_000);
  const wrapperMatch =
    /;let ([A-Za-z_$][\w$]*);t\[\d+\]===([A-Za-z_$][\w$]*)\?/.exec(
      componentTail,
    );
  if (wrapperMatch === null) {
    throw new Error("Upstream profile pet action wrapper was not found");
  }

  const wrapperName = wrapperMatch[1];
  const childListMatches = [
    ...componentTail.matchAll(
      /children:\[([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)\]/g,
    ),
  ].filter(match => match[1].split(",").includes(wrapperName));
  if (childListMatches.length !== 1) {
    throw new Error(
      `Expected one upstream profile menu child list, found ${childListMatches.length}`,
    );
  }

  const childListMatch = childListMatches[0];
  const childList = childListMatch[1]
    .split(",")
    .filter(child => child !== wrapperName)
    .join(",");
  const matchStart = labelIndex + childListMatch.index;
  const matchEnd = matchStart + childListMatch[0].length;
  return (
    source.slice(0, matchStart) +
    `children:[${childList}]/* ${marker} */` +
    source.slice(matchEnd)
  );
}

const defaultSidebarRowsMarker = "__codex_default_sidebar_rows";

function patchDefaultSidebarRows(source) {
  if (source.includes(defaultSidebarRowsMarker)) {
    return source;
  }

  const projectGroupSelectorMatches = [
    ...source.matchAll(
      /projectGroup:[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*\)/g,
    ),
  ];
  if (projectGroupSelectorMatches.length !== 1) {
    throw new Error(
      `Expected one upstream thread project-group selector, found ${projectGroupSelectorMatches.length}`,
    );
  }
  const projectGroupSelector = projectGroupSelectorMatches[0][1];

  const detailsComponentPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),\{chatGptConversationId:[A-Za-z_$][\w$]*,chatGptProjectId:[A-Za-z_$][\w$]*,itemKind:[A-Za-z_$][\w$]*,localConversationId:[A-Za-z_$][\w$]*,projectGroup:[A-Za-z_$][\w$]*,sidebarMode:[A-Za-z_$][\w$]*\}=\2,[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(/g;
  const detailsComponentMatches = [...source.matchAll(detailsComponentPattern)];
  if (detailsComponentMatches.length !== 1) {
    throw new Error(
      `Expected one upstream thread details component, found ${detailsComponentMatches.length}`,
    );
  }
  const detailsComponent = detailsComponentMatches[0][1];
  const stateHook = detailsComponentMatches[0][3];
  const detailsComponentTail = source.slice(
    detailsComponentMatches[0].index,
    detailsComponentMatches[0].index + 4_000,
  );
  const detailsJsxAlias = /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(/.exec(
    detailsComponentTail,
  )?.[1];
  if (detailsJsxAlias === undefined) {
    throw new Error("Upstream thread details JSX runtime was not found");
  }

  const defaultRowPattern =
    /if\(([A-Za-z_$][\w$]*)\?\.source===`codex`\)return\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{canPin:!0,floatStatusIconsEnd:!0,hideTimestamp:!0,isGrouped:!1,[\s\S]*?showPinActionOnHover:!0,threadKey:\1\.threadKey\}\)/g;
  const defaultRowMatches = [...source.matchAll(defaultRowPattern)];
  if (defaultRowMatches.length !== 1) {
    throw new Error(
      `Expected one upstream default Codex sidebar row, found ${defaultRowMatches.length}`,
    );
  }
  const defaultRowMatch = defaultRowMatches[0];
  const itemAlias = defaultRowMatch[1];
  const rowJsxAlias = defaultRowMatch[2];
  const rowSource = defaultRowMatch[0];
  const rowOwnerStart = source.lastIndexOf("function ", defaultRowMatch.index);
  if (rowOwnerStart === -1) {
    throw new Error("Upstream default sidebar row owner was not found");
  }

  const noWorkspaceLabel =
    "id:`sidebarElectron.priorityThreads.details.codex`,defaultMessage:`Codex`,description:`Source label for a standalone Codex task in the Priority filter`";
  const noWorkspaceLabelMatches = source.split(noWorkspaceLabel).length - 1;
  if (noWorkspaceLabelMatches !== 1) {
    throw new Error(
      `Expected one upstream standalone Codex detail label, found ${noWorkspaceLabelMatches}`,
    );
  }

  const workspaceDetailsComponent = "__codexDefaultWorkspaceDetails";
  const workspaceDetailsSource =
    `function ${workspaceDetailsComponent}(e){` +
    `let t=${stateHook}(${projectGroupSelector},e.threadKey);` +
    `return(0,${detailsJsxAlias}.jsx)(${detailsComponent},{itemKind:\`local\`,` +
    `projectGroup:t,sidebarMode:\`codex\`})}` +
    `/* ${defaultSidebarRowsMarker} */`;
  const patchedRow = rowSource
    .replace(
      "floatStatusIconsEnd:!0,hideTimestamp:!0",
      "floatStatusIconsEnd:!0,hideRemoteHostEnvIcon:!0,hideTimestamp:!0",
    )
    .replace(
      `showPinActionOnHover:!0,threadKey:${itemAlias}.threadKey`,
      `secondaryContent:(0,${rowJsxAlias}.jsx)(${workspaceDetailsComponent},{threadKey:${itemAlias}.threadKey}),` +
        `showPinActionOnHover:!0,threadKey:${itemAlias}.threadKey,wrapSecondaryContent:!0`,
    );

  let patched =
    source.slice(0, rowOwnerStart) +
    workspaceDetailsSource +
    source.slice(rowOwnerStart);
  patched = patched.replace(rowSource, patchedRow);
  return patched.replace(
    noWorkspaceLabel,
    "id:`sidebarElectron.thread.noWorkspace`,defaultMessage:`No workspace`,description:`Fallback shown beneath a sidebar task that has no workspace`",
  );
}

function patchBrowserSidePanelAction(source) {
  const marker = "__codex_hide_browser_side_panel_action";
  if (source.includes(marker)) {
    return source;
  }

  const label = "id:`thread.sidePanel.openBrowserTab`";
  const labelMatches = source.split(label).length - 1;
  if (labelMatches !== 1) {
    throw new Error(
      `Expected one upstream browser side-panel action, found ${labelMatches}`,
    );
  }

  const labelIndex = source.indexOf(label);
  const actionStart = source.lastIndexOf("...", labelIndex);
  const actionEnd = source.indexOf("})}]:[],", labelIndex);
  const actionPrefix = source.slice(actionStart, labelIndex);
  const actionPrefixMatch = /^\.\.\.([A-Za-z_$][\w$]*)\?\[\{/.exec(actionPrefix);
  const targetMatch =
    /\.\.\.([A-Za-z_$][\w$]*)===`right`\?/.exec(
      source.slice(labelIndex, labelIndex + 3_000),
    );
  if (
    actionStart === -1 ||
    actionEnd === -1 ||
    actionPrefixMatch === null ||
    targetMatch === null ||
    !actionPrefix.includes("id:`browser`")
  ) {
    throw new Error("Upstream browser side-panel action block was not found");
  }

  const enabledName = actionPrefixMatch[1];
  const targetName = targetMatch[1];
  const prefixEnd = actionStart + actionPrefixMatch[0].length;
  return (
    source.slice(0, actionStart) +
    `...${enabledName}&&${targetName}!==\`right\`?/* ${marker} */[{` +
    source.slice(prefixEnd)
  );
}

function createPwaIconSvg(png, size) {
  const source = png.toString("base64");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <image width="${size}" height="${size}" href="data:image/png;base64,${source}" />`,
    "</svg>",
    "",
  ].join("\n");
}

function patchWebviewIndex(source) {
  let patched = source.replace(
    /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=")([^"]*)("[^>]*>)/i,
    (meta, prefix, policy, suffix) => {
      if (/(?:^|;)\s*manifest-src\s/i.test(policy)) {
        return meta;
      }
      const separator = policy.trimEnd().endsWith(";") ? " " : "; ";
      return `${prefix}${policy}${separator}manifest-src 'self'${suffix}`;
    },
  );

  const manifestTag =
    '<link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />';
  patched = patched.replace(/<link\s+rel=["']manifest["'][^>]*>/i, tag => {
    if (/\bcrossorigin=/.test(tag)) {
      return tag;
    }
    return tag.replace(/\s*\/?>$/, ' crossorigin="use-credentials" />');
  });

  const headTags = [];
  if (!/<link\s+rel=["']manifest["']/i.test(patched)) {
    headTags.push(manifestTag);
  }
  if (!patched.includes("__codex_browser_bridge.js")) {
    headTags.push('<script src="./__codex_browser_bridge.js"></script>');
  }
  if (headTags.length === 0) {
    return patched;
  }
  if (!patched.includes("</head>")) {
    throw new Error("Upstream webview index has no closing head element");
  }

  patched = patched.replace("</head>", `    ${headTags.join("\n    ")}\n  </head>`);
  return patched;
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
  const iconCandidates = assetEntries.filter(
    name => name.startsWith("app-") && name.endsWith(".png"),
  );
  if (iconCandidates.length !== 1) {
    throw new Error(`Expected one upstream app icon, found ${iconCandidates.length}`);
  }

  const sidePanelFiles = await Promise.all(
    assetEntries
      .filter(
        name =>
          name.startsWith("thread-app-shell-chrome-") &&
          name.endsWith(".js"),
      )
      .map(async name => ({
        name,
        source: await readFile(join(assetsRoot, name), "utf8"),
      })),
  );
  const sidePanelCandidates = sidePanelFiles.filter(({ source }) =>
    source.includes("id:`thread.sidePanel.openBrowserTab`"),
  );
  if (sidePanelCandidates.length !== 1) {
    throw new Error(
      `Expected one upstream side-panel browser action bundle, found ${sidePanelCandidates.length}`,
    );
  }

  const appServerTransport = await findAppServerTransportBundle(buildRoot, buildEntries);
  const mainPath = join(buildRoot, mainCandidates[0]);
  const indexPath = join(webviewRoot, "index.html");
  const rendererPath = join(assetsRoot, rendererCandidates[0]);
  const sidePanelPath = join(assetsRoot, sidePanelCandidates[0].name);
  const bridgePath = join(webviewRoot, "__codex_browser_bridge.js");
  const iconPath = join(assetsRoot, iconCandidates[0]);

  const [preload, mainProcess, index, renderer, sidePanel, appIcon] = await Promise.all([
    appServerTransport.path === preloadPath
      ? appServerTransport.source
      : readFile(preloadPath, "utf8"),
    appServerTransport.path === mainPath
      ? appServerTransport.source
      : readFile(mainPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(rendererPath, "utf8"),
    sidePanelCandidates[0].source,
    readFile(iconPath),
  ]);
  let patchedPreload = patchPreload(preload);
  let patchedMainProcess = patchMainProcess(mainProcess);
  const patchedIndex = patchWebviewIndex(index);
  const patchedRenderer = patchRendererRemoteTelemetry(
    patchDefaultSidebarRows(patchProfilePetAction(patchWebviewRenderer(renderer))),
  );
  const patchedSidePanel = patchBrowserSidePanelAction(sidePanel);
  const webManifest = `${JSON.stringify(
    {
      name: "Codex",
      short_name: "Codex",
      icons: [
        {
          src: "/icon-192.svg",
          sizes: "192x192",
          type: "image/svg+xml",
        },
        {
          src: "/icon-512.svg",
          sizes: "512x512",
          type: "image/svg+xml",
        },
      ],
      start_url: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
    },
    null,
    2,
  )}\n`;
  let patchedAppServerTransport = null;
  if (appServerTransport.path === preloadPath) {
    patchedPreload = patchAppServerTransport(patchedPreload);
  } else if (appServerTransport.path === mainPath) {
    patchedMainProcess = patchAppServerTransport(patchedMainProcess);
  } else {
    patchedAppServerTransport = patchAppServerTransport(appServerTransport.source);
  }

  patchedPreload = patchedPreload.replaceAll(
    appServerAnalyticsDefaultFlag,
    appServerAnalyticsDisabledArguments,
  );
  patchedMainProcess = patchedMainProcess.replaceAll(
    appServerAnalyticsDefaultFlag,
    appServerAnalyticsDisabledArguments,
  );
  if (patchedAppServerTransport !== null) {
    patchedAppServerTransport = patchedAppServerTransport.replaceAll(
      appServerAnalyticsDefaultFlag,
      appServerAnalyticsDisabledArguments,
    );
  }

  await Promise.all([
    writeFile(preloadPath, patchedPreload),
    writeFile(mainPath, patchedMainProcess),
    writeFile(indexPath, patchedIndex),
    writeFile(rendererPath, patchedRenderer),
    writeFile(sidePanelPath, patchedSidePanel),
    writeFile(bridgePath, browserBridgeSource),
    writeFile(join(webviewRoot, "manifest.json"), webManifest),
    writeFile(join(webviewRoot, "icon-192.svg"), createPwaIconSvg(appIcon, 192)),
    writeFile(join(webviewRoot, "icon-512.svg"), createPwaIconSvg(appIcon, 512)),
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
