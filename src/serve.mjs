import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  formatAuthority,
  isWildcardHost,
  normalizeHost,
  normalizePublicUrl,
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
  response.setHeader("Content-Security-Policy", "manifest-src 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function createCapabilityLandingPage(showError) {
  const errorMessage = showError
    ? "That capability URL is not valid for this codex-web service. Copy the complete URL from the host and try again."
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to codex-web</title>
  <style>
    :root {
      color-scheme: light dark;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
      --color-text: #0d0d0d;
      --color-text-secondary: #5d5d5d;
      --color-surface: #ffffff;
      --color-surface-secondary: #f3f3f3;
      --color-border: rgba(13, 13, 13, 0.12);
      --color-focus: rgba(51, 159, 255, 0.7);
      --color-danger: #c83232;
      --color-button: #0d0d0d;
      --color-button-hover: #303030;
      --color-button-text: #ffffff;
      font-family: var(--font-sans);
      color: var(--color-text);
      background: var(--color-surface);
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--color-surface);
    }
    main {
      width: min(100%, 440px);
      border: 1px solid var(--color-border);
      border-radius: 14px;
      background: var(--color-surface-secondary);
      overflow: hidden;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 28px 32px 0;
      color: var(--color-text-secondary);
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
    }
    .status::before {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--color-text-secondary);
      content: "";
    }
    .content { padding: 18px 32px 32px; }
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -0.025em;
    }
    .intro {
      margin: 10px 0 28px;
      color: var(--color-text-secondary);
      font-size: 14px;
      line-height: 1.5;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 500;
    }
    input {
      width: 100%;
      min-height: 48px;
      padding: 12px 14px;
      border: 1px solid var(--color-border);
      border-radius: 14px;
      outline: none;
      color: var(--color-text);
      background: var(--color-surface);
      font: 13px/1.4 var(--font-mono);
    }
    input::placeholder { color: var(--color-text-secondary); }
    input:focus {
      border-color: var(--color-focus);
      box-shadow: 0 0 0 1px var(--color-focus);
    }
    button {
      width: 100%;
      min-height: 44px;
      margin-top: 12px;
      border: 0;
      border-radius: 999px;
      color: var(--color-button-text);
      background: var(--color-button);
      font: 500 14px/1 var(--font-sans);
      cursor: pointer;
    }
    button:hover { background: var(--color-button-hover); }
    button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .error {
      margin: 12px 0 0;
      color: var(--color-danger);
      font-size: 13px;
      line-height: 1.45;
    }
    .error:empty { display: none; }
    .privacy {
      margin: 20px 0 0;
      color: var(--color-text-secondary);
      font-size: 12px;
      line-height: 1.5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-text: #ffffff;
        --color-text-secondary: rgba(255, 255, 255, 0.65);
        --color-surface: #212121;
        --color-surface-secondary: #181818;
        --color-border: rgba(255, 255, 255, 0.08);
        --color-danger: #ff8585;
        --color-button: #ffffff;
        --color-button-hover: #ededed;
        --color-button-text: #0d0d0d;
      }
    }
    @media (max-width: 480px) {
      body {
        display: block;
        padding: 0;
        background: var(--color-surface-secondary);
      }
      main {
        width: 100%;
        min-height: 100vh;
        border: 0;
        border-radius: 0;
      }
      .status { padding: 28px 24px 0; }
      .content { padding: 18px 24px 28px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status">Connection required</div>
    <div class="content">
      <h1>Connect this app.</h1>
      <p class="intro">Paste the complete capability URL shown by codex-web on the host.</p>
      <form id="capability-form" novalidate>
        <label for="capability-url">Capability URL</label>
        <input id="capability-url" name="capability-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:…/?cap=…" aria-describedby="capability-error">
        <button type="submit">Open Codex</button>
        <p class="error" id="capability-error" role="alert">${errorMessage}</p>
      </form>
      <p class="privacy">The capability is exchanged for a protected browser cookie. This page does not store it.</p>
    </div>
  </main>
  <script>
    const form = document.querySelector("#capability-form");
    const input = document.querySelector("#capability-url");

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      let capabilityUrl;
      try {
        capabilityUrl = new URL(input.value.trim());
      } catch {
        input.setCustomValidity("Paste the complete capability URL.");
        input.reportValidity();
        return;
      }

      const parameters = [...capabilityUrl.searchParams.keys()];
      if (
        capabilityUrl.origin !== window.location.origin ||
        capabilityUrl.pathname !== "/" ||
        capabilityUrl.hash !== "" ||
        parameters.length !== 1 ||
        parameters[0] !== "cap" ||
        capabilityUrl.searchParams.get("cap") === ""
      ) {
        input.setCustomValidity("Use the complete capability URL for this codex-web service.");
        input.reportValidity();
        return;
      }

      input.setCustomValidity("");
      window.location.assign(capabilityUrl.href);
    });

    input.addEventListener("input", () => input.setCustomValidity(""));
  </script>
</body>
</html>`;
}

function sendText(response, statusCode, text) {
  const payload = Buffer.from(`${text}\n`);
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function sendHtml(request, response, html) {
  const payload = Buffer.from(html);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.length,
  });
  response.end(request.method === "HEAD" ? undefined : payload);
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
  publicUrl,
  capability = randomBytes(32).toString("base64url"),
} = {}) {
  if (appRoot === undefined) {
    throw new Error("A generated application root is required");
  }
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);
  const normalizedPublicUrl = normalizePublicUrl(publicUrl);

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

  function hostOrigin(hostHeader, protocol) {
    if (typeof hostHeader !== "string") {
      return null;
    }

    let candidate;
    try {
      candidate = new URL(`${protocol}//${hostHeader}`);
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
    return candidate;
  }

  function requestOrigin(hostHeader) {
    if (listenerPort === null) {
      return null;
    }

    if (normalizedPublicUrl !== null) {
      const publicCandidate = hostOrigin(hostHeader, "https:");
      if (publicCandidate?.origin === normalizedPublicUrl) {
        return normalizedPublicUrl;
      }
    }

    const internalCandidate = hostOrigin(hostHeader, "http:");
    if (internalCandidate === null) {
      return null;
    }
    const candidatePort =
      internalCandidate.port === "" ? 80 : Number(internalCandidate.port);
    if (candidatePort !== listenerPort) {
      return null;
    }
    if (
      !isWildcardHost(normalizedHost) &&
      internalCandidate.hostname !== new URL(listenerOrigin).hostname
    ) {
      return null;
    }
    return internalCandidate.origin;
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
        "Set-Cookie": `codex_web_cap=${capability}; HttpOnly; SameSite=Strict; Path=/${allowedRequestOrigin.startsWith("https:") ? "; Secure" : ""}`,
        Location: url.pathname,
      });
      response.end();
      return;
    }

    if (!hasCapability(request, capability)) {
      if (url.pathname === "/") {
        sendHtml(
          request,
          response,
          createCapabilityLandingPage(presentedCapability !== null),
        );
        return;
      }
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

  const browserOrigin = normalizedPublicUrl ?? listenerOrigin;
  return {
    url: `${browserOrigin}/?cap=${capability}`,
    internalUrl: `${listenerOrigin}/?cap=${capability}`,
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
