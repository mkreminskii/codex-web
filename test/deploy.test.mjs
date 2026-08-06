import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createUserServiceUnit,
  installUserService,
} from "../src/deploy.mjs";

test("creates a quoted user service command", () => {
  const unit = createUserServiceUnit({
    projectRoot: "/srv/codex web%prod",
    host: "0.0.0.0",
    port: 8080,
    nodePath: "/opt/node 22/bin/node",
    environment: {
      PATH: "/usr/bin:/opt/bin",
      CODEX_CLI_PATH: "/opt/bin/codex",
    },
  });

  assert.match(unit, /^# Managed by codex-web\n/);
  assert.match(unit, /ExecStart="\/opt\/node 22\/bin\/node"/);
  assert.ok(unit.includes('"/srv/codex web%%prod/src/cli.mjs"'));
  assert.ok(unit.includes('"--host" "0.0.0.0" "--port" "8080"'));
  assert.ok(unit.includes('Environment="PATH=/usr/bin:/opt/bin"'));
  assert.ok(unit.includes('Environment="CODEX_CLI_PATH=/opt/bin/codex"'));
  assert.match(unit, /Restart=on-failure/);
});

test("installs and starts a managed user service", async context => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "codex-web-home-"));
  context.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const calls = [];

  const result = await installUserService({
    projectRoot: "/srv/codex-web",
    host: "127.0.0.1",
    port: 4310,
    homeDirectory,
    nodePath: "/usr/bin/node",
    run: async (command, arguments_) => {
      calls.push([command, arguments_]);
      if (command === "journalctl") {
        return "Open http://127.0.0.1:4310/?cap=fixture\n";
      }
      return "";
    },
    wait: async () => {},
    urlWaitAttempts: 1,
  });

  assert.equal(
    result.servicePath,
    join(homeDirectory, ".config", "systemd", "user", "codex-web.service"),
  );
  assert.equal(result.url, "http://127.0.0.1:4310/?cap=fixture");
  assert.match(await readFile(result.servicePath, "utf8"), /--port" "4310"/);
  assert.deepEqual(
    calls.slice(0, 3).map(([command, arguments_]) => [
      command,
      arguments_.slice(0, 2),
    ]),
    [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable"]],
      ["systemctl", ["--user", "restart"]],
    ],
  );
  assert.equal(calls[3][0], "journalctl");
});

test("does not replace an unmanaged user service", async context => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "codex-web-home-"));
  context.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const serviceDirectory = join(
    homeDirectory,
    ".config",
    "systemd",
    "user",
  );
  await mkdir(serviceDirectory, { recursive: true });
  const servicePath = join(serviceDirectory, "codex-web.service");
  await writeFile(servicePath, "[Service]\nExecStart=/custom\n");

  await assert.rejects(
    installUserService({
      projectRoot: "/srv/codex-web",
      host: "127.0.0.1",
      port: 0,
      homeDirectory,
      run: async () => {
        throw new Error("systemctl must not run");
      },
    }),
    /Refusing to replace an unmanaged systemd service/,
  );
  assert.equal(
    await readFile(servicePath, "utf8"),
    "[Service]\nExecStart=/custom\n",
  );
});
