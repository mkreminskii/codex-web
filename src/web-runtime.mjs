import { realpath } from "node:fs/promises";

import { createRendererRelay } from "./relay.mjs";
import { startApplicationHost } from "./runtime-host.mjs";
import { startWebServer } from "./serve.mjs";

export async function startWebRuntime({
  appRoot,
  startServer = startWebServer,
  createRelay = createRendererRelay,
  startHost = startApplicationHost,
} = {}) {
  if (appRoot === undefined) {
    throw new Error("A generated application root is required");
  }
  const resolvedAppRoot = await realpath(appRoot);
  const server = await startServer({ appRoot: resolvedAppRoot });
  const relay = createRelay({
    httpServer: server.httpServer,
    origin: server.origin,
    capability: server.capability,
    onBootstrap: server.setBootstrap,
  });

  let host;
  try {
    host = await startHost({
      appRoot: resolvedAppRoot,
      relayUrl: relay.hostUrl,
      rendererUrl: server.url,
    });

    await Promise.race([
      relay.waitForHost(),
      host.exited.then((result) => {
        const detail = result.output === "" ? "" : `: ${result.output}`;
        throw new Error(
          `The upstream application host exited before readiness with code ${result.code}${detail}`,
        );
      }),
    ]);
  } catch (error) {
    if (host !== undefined) {
      await host.stop().catch(() => {});
    }
    await relay.close().catch(() => {});
    await server.close().catch(() => {});
    const hostOutput = host?.output?.();
    if (hostOutput) {
      throw new Error(`${error.message}: ${hostOutput}`, { cause: error });
    }
    throw error;
  }

  let closed = false;
  return {
    url: server.url,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await host.stop();
      await relay.close();
      await server.close();
    },
  };
}
