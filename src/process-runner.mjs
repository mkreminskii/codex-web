import { spawn } from "node:child_process";

const maximumOutputLength = 128 * 1024;
const terminationGraceMs = 1_000;

function appendOutput(output, chunk, outputLength) {
  output.push(chunk);
  let nextLength = outputLength + chunk.length;
  while (nextLength > maximumOutputLength) {
    nextLength -= output.shift().length;
  }
  return nextLength;
}

function terminateProcessGroup(child, signal) {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      child.kill(signal);
    }
  }
}

function timeoutDescription(timeoutMs) {
  return `${timeoutMs / 1_000} seconds`;
}

export async function runBufferedCommand(
  command,
  arguments_,
  {
    allowNonZero = false,
    label = command,
    timeoutMs = 600_000,
    ...spawnOptions
  } = {},
) {
  const output = [];
  let outputLength = 0;
  const child = spawn(command, arguments_, {
    ...spawnOptions,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      outputLength = appendOutput(output, chunk, outputLength);
    });
  }

  let timedOut = false;
  let forwardedSignal;
  let forceKillTimer;
  const stopChild = () => {
    terminateProcessGroup(child, "SIGTERM");
    forceKillTimer ??= setTimeout(
      () => terminateProcessGroup(child, "SIGKILL"),
      terminationGraceMs,
    );
  };
  const forwardInterrupt = () => {
    forwardedSignal = "SIGINT";
    stopChild();
  };
  const forwardTermination = () => {
    forwardedSignal = "SIGTERM";
    stopChild();
  };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);

  const timeout = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, timeoutMs);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimer);
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }

  if (forwardedSignal !== undefined) {
    process.kill(process.pid, forwardedSignal);
    await new Promise(() => {});
  }

  const commandOutput = output.join("");
  if (timedOut) {
    throw new Error(`${label} timed out after ${timeoutDescription(timeoutMs)}`);
  }
  if (!allowNonZero && result.code !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.code}: ${commandOutput.trim()}`,
    );
  }
  return { ...result, output: commandOutput };
}
