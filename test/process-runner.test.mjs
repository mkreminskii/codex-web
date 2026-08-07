import assert from "node:assert/strict";
import test from "node:test";

import { runBufferedCommand } from "../src/process-runner.mjs";

test("runs a buffered child command", async () => {
  const result = await runBufferedCommand(
    process.execPath,
    ["-e", 'process.stdout.write("fixture output\\n")'],
    {
      label: "fixture command",
      timeoutMs: 1_000,
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.output, "fixture output\n");
});

test("terminates a child command after its phase timeout", async () => {
  await assert.rejects(
    runBufferedCommand(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      ],
      {
        label: "fixture phase",
        timeoutMs: 20,
      },
    ),
    /fixture phase timed out after 0\.02 seconds/,
  );
});

