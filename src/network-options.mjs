import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export function normalizeHost(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error("Host must be a non-empty address or hostname");
  }

  let host = value;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (isIP(host) !== 0) {
    return host;
  }

  const withoutFinalDot = host.endsWith(".") ? host.slice(0, -1) : host;
  const ascii = domainToASCII(withoutFinalDot);
  const labels = ascii.split(".");
  if (
    ascii === "" ||
    ascii.length > 253 ||
    labels.some(
      label =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    )
  ) {
    throw new Error(`Invalid host: ${value}`);
  }
  return ascii.toLowerCase();
}

export function normalizePort(value) {
  if (
    typeof value === "string" &&
    !/^(?:0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`Invalid port: ${value}`);
  }
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function normalizePublicUrl(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error("Public URL must be a non-empty HTTPS origin");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid public URL: ${value}`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Public URL must be an HTTPS origin without credentials, a path, a query, or a fragment",
    );
  }
  return url.origin;
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

export function formatAuthority(host, port) {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `${formattedHost}:${port}`;
}
