import { timingSafeEqual } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

function equalSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function cookieCapability(request) {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "codex_web_cap") {
      return value.join("=");
    }
  }
  return null;
}

function sendJson(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

export function createRendererRelay({
  httpServer,
  origin,
  capability,
  onBootstrap = () => {},
  hostReadyTimeoutMs = 30_000,
}) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
  });
  let hostSocket = null;
  let browserSocket = null;
  let hostReady = false;
  let hostBootstrapReceived = false;
  const readyWaiters = new Set();

  function settleReadyWaiters(error) {
    for (const waiter of readyWaiters) {
      clearTimeout(waiter.timeout);
      if (error === null) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
    readyWaiters.clear();
  }

  function rejectUpgrade(socket, status, reason) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  function onUpgrade(request, socket, head) {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname !== "/__codex_bridge") {
      socket.destroy();
      return;
    }

    const role = url.searchParams.get("role");
    const queryCapability = url.searchParams.get("cap");
    const cookie = cookieCapability(request);
    const isHost =
      role === "host" &&
      (request.headers.origin === undefined || request.headers.origin === origin) &&
      queryCapability !== null &&
      equalSecret(queryCapability, capability);
    const isBrowser =
      role === "browser" &&
      request.headers.origin === origin &&
      cookie !== null &&
      equalSecret(cookie, capability);

    if (!isHost && !isBrowser) {
      rejectUpgrade(socket, "403", "Forbidden");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit(
        "connection",
        webSocket,
        request,
        isHost ? "host" : "browser",
      );
    });
  }

  function onConnection(socket, _request, role) {
    if (role === "host") {
      if (hostSocket !== null) {
        socket.close(1013, "Application host already connected");
        return;
      }
      hostSocket = socket;
      hostReady = false;
      hostBootstrapReceived = false;
      onBootstrap(null);
    } else {
      if (browserSocket !== null) {
        socket.close(1013, "Browser already connected");
        return;
      }
      browserSocket = socket;
    }

    socket.on("error", () => {
      // The close event owns state cleanup.
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Binary messages are not supported");
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(1007, "Invalid JSON");
        return;
      }
      if (message === null || typeof message !== "object") {
        socket.close(1007, "Invalid relay message");
        return;
      }

      if (
        message.type === "app-host-message" &&
        typeof message.message !== "string"
      ) {
        socket.close(1007, "Invalid app-host message");
        return;
      }

      if (role === "host") {
        if (message.type === "bootstrap") {
          if (
            hostBootstrapReceived ||
            message.value === null ||
            typeof message.value !== "object" ||
            Array.isArray(message.value)
          ) {
            socket.close(1007, "Invalid application bootstrap");
            return;
          }
          try {
            onBootstrap(message.value);
          } catch {
            socket.close(1011, "Application bootstrap failed");
            return;
          }
          hostBootstrapReceived = true;
          return;
        }
        if (message.type === "ready") {
          if (!hostBootstrapReceived) {
            socket.close(1008, "Application bootstrap required");
            return;
          }
          hostReady = true;
          settleReadyWaiters(null);
          return;
        }
        if (
          message.type === "result" ||
          message.type === "notification" ||
          message.type === "worker-message" ||
          message.type === "app-host-message" ||
          message.type === "app-host-error"
        ) {
          sendJson(browserSocket, message);
        }
        return;
      }

      if (
        message.type === "invoke" ||
        message.type === "subscribe-worker" ||
        message.type === "unsubscribe-worker" ||
        message.type === "connect-app-host" ||
        message.type === "app-host-message"
      ) {
        if (!sendJson(hostSocket, message) && message.type === "invoke") {
          sendJson(browserSocket, {
            type: "result",
            id: message.id,
            ok: false,
            error: {
              code: "codex_web_host_unavailable",
              message: "The upstream application host is unavailable",
            },
          });
        }
      }
    });
    socket.on("close", () => {
      if (role === "host" && hostSocket === socket) {
        hostSocket = null;
        hostReady = false;
        hostBootstrapReceived = false;
        onBootstrap(null);
        settleReadyWaiters(
          new Error("The upstream application host disconnected before readiness"),
        );
        sendJson(browserSocket, {
          type: "host-disconnected",
          error: {
            code: "codex_web_host_disconnected",
            message: "The upstream application host disconnected",
          },
        });
      }
      if (role === "browser" && browserSocket === socket) {
        sendJson(hostSocket, { type: "browser-disconnected" });
        browserSocket = null;
      }
    });
  }

  httpServer.on("upgrade", onUpgrade);
  webSocketServer.on("connection", onConnection);

  return {
    hostUrl: `${origin.replace(/^http/, "ws")}/__codex_bridge?role=host&cap=${capability}`,
    waitForHost() {
      if (hostReady) {
        return Promise.resolve();
      }
      return new Promise((resolveReady, rejectReady) => {
        const waiter = {
          resolve: resolveReady,
          reject: rejectReady,
          timeout: setTimeout(() => {
            readyWaiters.delete(waiter);
            rejectReady(
              new Error(
                `The upstream application host did not connect within ${hostReadyTimeoutMs}ms`,
              ),
            );
          }, hostReadyTimeoutMs),
        };
        readyWaiters.add(waiter);
      });
    },
    close() {
      httpServer.off("upgrade", onUpgrade);
      settleReadyWaiters(new Error("The renderer relay closed"));
      hostSocket?.close(1001, "Server shutting down");
      browserSocket?.close(1001, "Server shutting down");
      return new Promise((resolveClose) => {
        webSocketServer.close(() => resolveClose());
      });
    },
  };
}
