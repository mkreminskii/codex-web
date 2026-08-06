#!/usr/bin/env node

import { connect } from "node:net";
import { isAbsolute } from "node:path";

import { WebSocket } from "ws";

const maximumQueuedBytes = 64 * 1024 * 1024;
const pauseInputBytes = 1024 * 1024;
const resumeInputBytes = 512 * 1024;
const socketPath = process.env.CODEX_WEB_APP_SERVER_SOCKET_PATH?.trim();

if (!socketPath || !isAbsolute(socketPath)) {
  process.stderr.write(
    "codex-web: CODEX_WEB_APP_SERVER_SOCKET_PATH must be an absolute path\n",
  );
  process.exitCode = 1;
} else {
  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => connect(socketPath),
    maxPayload: maximumQueuedBytes,
    perMessageDeflate: false,
  });
  const queue = [];
  const bufferedInput = [];
  let bufferedInputBytes = 0;
  let closingForInput = false;
  let inputClosed = false;
  let inputPaused = false;
  let outputPaused = false;
  let queuedBytes = 0;
  let sending = false;
  let stopped = false;

  function stop(error) {
    if (stopped) {
      return;
    }
    stopped = true;
    if (error) {
      process.stderr.write(`codex-web: app-server proxy failed: ${error.message}\n`);
      process.exitCode = 1;
    }
    process.stdin.pause();
    process.stdin.destroy();
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.terminate();
    }
  }

  function adjustInputBackpressure() {
    if (!inputPaused && queuedBytes >= pauseInputBytes) {
      inputPaused = true;
      process.stdin.pause();
    } else if (inputPaused && !inputClosed && queuedBytes <= resumeInputBytes) {
      inputPaused = false;
      process.stdin.resume();
    }
  }

  function flush() {
    if (stopped || sending || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const line = queue.shift();
    if (line === undefined) {
      if (inputClosed) {
        closingForInput = true;
        socket.close(1000);
      }
      return;
    }
    sending = true;
    socket.send(line, { binary: false }, error => {
      sending = false;
      queuedBytes -= line.length;
      adjustInputBackpressure();
      if (error) {
        stop(error);
        return;
      }
      flush();
    });
  }

  function enqueue(line) {
    if (queuedBytes + line.length > maximumQueuedBytes) {
      stop(new Error("queued input exceeded 64 MiB"));
      return;
    }
    queue.push(line);
    queuedBytes += line.length;
    adjustInputBackpressure();
    flush();
  }

  process.stdin.on("data", chunk => {
    let offset = 0;
    let newline;
    while ((newline = chunk.indexOf(0x0a, offset)) !== -1) {
      const segment = chunk.subarray(offset, newline);
      if (bufferedInputBytes + segment.length > maximumQueuedBytes) {
        stop(new Error("input record exceeded 64 MiB"));
        return;
      }
      let line =
        bufferedInputBytes === 0
          ? segment
          : Buffer.concat(
              [...bufferedInput, segment],
              bufferedInputBytes + segment.length,
            );
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      bufferedInput.length = 0;
      bufferedInputBytes = 0;
      enqueue(line);
      if (stopped) {
        return;
      }
      offset = newline + 1;
    }

    const remainder = chunk.subarray(offset);
    if (bufferedInputBytes + remainder.length > maximumQueuedBytes) {
      stop(new Error("input record exceeded 64 MiB"));
      return;
    }
    if (remainder.length !== 0) {
      bufferedInput.push(Buffer.from(remainder));
      bufferedInputBytes += remainder.length;
    }
  });
  process.stdin.on("end", () => {
    if (bufferedInputBytes !== 0) {
      enqueue(Buffer.concat(bufferedInput, bufferedInputBytes));
      bufferedInput.length = 0;
      bufferedInputBytes = 0;
    }
    inputClosed = true;
    flush();
  });
  process.stdin.on("error", stop);

  socket.on("open", flush);
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      stop(new Error("the app-server sent a binary WebSocket message"));
      return;
    }
    const message = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const messageAccepted = process.stdout.write(message);
    const newlineAccepted = process.stdout.write("\n");
    const canContinue = messageAccepted && newlineAccepted;
    if (!canContinue && !outputPaused) {
      outputPaused = true;
      socket.pause();
    }
  });
  socket.on("error", stop);
  socket.on("close", (code, reason) => {
    const detail = reason.length === 0 ? "" : `: ${reason.toString()}`;
    const error =
      code === 1000 || closingForInput
        ? null
        : new Error(`the app-server WebSocket closed with code ${code}${detail}`);
    stop(error);
  });
  process.stdout.on("drain", () => {
    if (outputPaused && !stopped) {
      outputPaused = false;
      socket.resume();
    }
  });
  process.stdout.on("error", stop);
}
