import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  formatAuthority,
  isWildcardHost,
  normalizeHost,
  normalizePort,
} from "./network-options.mjs";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function equalSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function hasCapability(request, capability) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.trim().split("=");
    if (name === "codex_web_cap") {
      return equalSecret(valueParts.join("="), capability);
    }
  }
  return false;
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendText(response, statusCode, text) {
  const payload = Buffer.from(`${text}\n`);
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function resolveAssetPath(webviewRoot, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) {
    return null;
  }

  const requestedPath =
    decodedPath === "/" ? join(webviewRoot, "index.html") : resolve(webviewRoot, `.${decodedPath}`);
  const pathFromRoot = relative(webviewRoot, requestedPath);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    return null;
  }
  return requestedPath;
}

async function sendAsset(request, response, assetPath) {
  let assetStat;
  try {
    const entry = await lstat(assetPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      sendText(response, 404, "Not found");
      return;
    }
    assetStat = await stat(assetPath);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes.get(extname(assetPath).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": assetStat.size,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(assetPath);
  stream.once("error", () => {
    if (!response.headersSent) {
      sendText(response, 500, "Could not read application asset");
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

export async function startWebServer({
  appRoot,
  host = "127.0.0.1",
  port = 0,
  capability = randomBytes(32).toString("base64url"),
} = {}) {
  if (appRoot === undefined) {
    throw new Error("A generated application root is required");
  }
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);

  const resolvedAppRoot = await realpath(appRoot);
  const webviewRoot = await realpath(join(resolvedAppRoot, "upstream", "webview"));
  const webviewFromApp = relative(resolvedAppRoot, webviewRoot);
  if (
    webviewFromApp === ".." ||
    webviewFromApp.startsWith(`..${sep}`) ||
    isAbsolute(webviewFromApp)
  ) {
    throw new Error("The generated webview escaped the application root");
  }

  let bootstrapPayload = null;
  let listenerPort = null;
  let listenerOrigin = null;

  function requestOrigin(hostHeader) {
    if (typeof hostHeader !== "string" || listenerPort === null) {
      return null;
    }

    let candidate;
    try {
      candidate = new URL(`http://${hostHeader}`);
    } catch {
      return null;
    }
    if (
      candidate.username !== "" ||
      candidate.password !== "" ||
      candidate.pathname !== "/" ||
      candidate.search !== "" ||
      candidate.hash !== ""
    ) {
      return null;
    }

    const candidatePort = candidate.port === "" ? 80 : Number(candidate.port);
    if (candidatePort !== listenerPort) {
      return null;
    }
    if (
      !isWildcardHost(normalizedHost) &&
      candidate.hostname !== new URL(listenerOrigin).hostname
    ) {
      return null;
    }
    return candidate.origin;
  }
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);

    const allowedRequestOrigin = requestOrigin(request.headers.host);
    if (allowedRequestOrigin === null) {
      sendText(response, 421, "Unexpected Host header");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed");
      return;
    }

    const url = new URL(request.url ?? "/", allowedRequestOrigin);
    const presentedCapability = url.searchParams.get("cap");
    if (
      presentedCapability !== null &&
      equalSecret(presentedCapability, capability)
    ) {
      response.writeHead(303, {
        "Set-Cookie": `codex_web_cap=${capability}; HttpOnly; SameSite=Strict; Path=/`,
        Location: url.pathname,
      });
      response.end();
      return;
    }

    if (!hasCapability(request, capability)) {
      sendText(response, 403, "Browser capability required");
      return;
    }

    if (url.pathname === "/__codex_bootstrap") {
      if (bootstrapPayload === null) {
        sendText(response, 503, "Application bootstrap is unavailable");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": bootstrapPayload.length,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(bootstrapPayload);
      return;
    }

    const assetPath = resolveAssetPath(webviewRoot, url.pathname);
    if (assetPath === null) {
      sendText(response, 400, "Invalid application asset path");
      return;
    }
    await sendAsset(request, response, assetPath);
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(normalizedPort, normalizedHost, resolveListen);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the web server address");
  }
  listenerPort = address.port;
  listenerOrigin = `http://${formatAuthority(normalizedHost, listenerPort)}`;

  return {
    url: `${listenerOrigin}/?cap=${capability}`,
    origin: listenerOrigin,
    isRequestOriginAllowed(request) {
      const allowedOrigin = requestOrigin(request.headers.host);
      return allowedOrigin !== null && request.headers.origin === allowedOrigin;
    },
    capability,
    httpServer: server,
    setBootstrap(value) {
      if (value === null) {
        bootstrapPayload = null;
        return;
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error("The application bootstrap is not serializable");
      }
      bootstrapPayload = Buffer.from(serialized);
      if (bootstrapPayload.length > 64 * 1024 * 1024) {
        bootstrapPayload = null;
        throw new Error("The application bootstrap exceeds the relay limit");
      }
    },
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolveClose();
        });
      }),
  };
}
