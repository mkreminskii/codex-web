import { realpath } from "node:fs/promises";

import { createRendererRelay } from "./relay.mjs";
import { startApplicationHost } from "./runtime-host.mjs";
import { startWebServer } from "./serve.mjs";

export async function startWebRuntime({
  appRoot,
  host,
  port,
  publicUrl,
  startServer = startWebServer,
  createRelay = createRendererRelay,
  startHost = startApplicationHost,
} = {}) {
  if (appRoot === undefined) {
    throw new Error("A generated application root is required");
  }
  const resolvedAppRoot = await realpath(appRoot);
  const server = await startServer({
    appRoot: resolvedAppRoot,
    host,
    port,
    publicUrl,
  });
  const relay = createRelay({
    httpServer: server.httpServer,
    origin: server.origin,
    capability: server.capability,
    onBootstrap: server.setBootstrap,
    isOriginAllowed: server.isRequestOriginAllowed,
  });

  let applicationHost;
  try {
    applicationHost = await startHost({
      appRoot: resolvedAppRoot,
      relayUrl: relay.hostUrl,
      rendererUrl: server.hostPageUrl,
    });

    await Promise.race([
      relay.waitForHost(),
      applicationHost.exited.then((result) => {
        const detail = result.output === "" ? "" : `: ${result.output}`;
        throw new Error(
          `The upstream application host exited before readiness with code ${result.code}${detail}`,
        );
      }),
    ]);
  } catch (error) {
    if (applicationHost !== undefined) {
      await applicationHost.stop().catch(() => {});
    }
    await relay.close().catch(() => {});
    await server.close().catch(() => {});
    const hostOutput = applicationHost?.output?.();
    if (hostOutput) {
      throw new Error(`${error.message}: ${hostOutput}`, { cause: error });
    }
    throw error;
  }

  let closed = false;
  const failure = applicationHost.exited.then(
    result => {
      if (closed) {
        return null;
      }
      const status =
        result.code === null ? `signal ${result.signal}` : `code ${result.code}`;
      const detail = result.output === "" ? "" : `: ${result.output}`;
      return new Error(
        `The upstream application host exited unexpectedly with ${status}${detail}`,
      );
    },
    error => {
      if (closed) {
        return null;
      }
      const detail = error instanceof Error ? error.message : String(error);
      return new Error(`The upstream application host failed unexpectedly: ${detail}`, {
        cause: error,
      });
    },
  );
  return {
    url: server.url,
    failure,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await applicationHost.stop();
      await relay.close();
      await server.close();
    },
  };
}
