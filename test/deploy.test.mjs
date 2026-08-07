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
    publicUrl: "https://codex.example.com",
    nodePath: "/opt/node 22/bin/node",
    environment: {
      PATH: "/usr/bin:/opt/bin",
      CODEX_CLI_PATH: "/opt/bin/codex",
      CODEX_HOME: "/srv/codex home",
      BUILD_FLAVOR: "dev",
      CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://chatgpt.example/%tenant",
      CODEX_APP_SERVER_OPENAI_BASE_URL: 'https://api.example/?label="primary"',
    },
  });

  assert.match(unit, /^# Managed by codex-web\n/);
  assert.match(unit, /ExecStart="\/opt\/node 22\/bin\/node"/);
  assert.ok(unit.includes('"/srv/codex web%%prod/src/cli.mjs"'));
  assert.ok(unit.includes('"--host" "0.0.0.0" "--port" "8080"'));
  assert.ok(unit.includes('"--public-url" "https://codex.example.com"'));
  assert.ok(unit.includes('Environment="PATH=/usr/bin:/opt/bin"'));
  assert.ok(unit.includes('Environment="CODEX_CLI_PATH=/opt/bin/codex"'));
  assert.ok(unit.includes('Environment="CODEX_HOME=/srv/codex home"'));
  assert.ok(unit.includes('Environment="BUILD_FLAVOR=prod"'));
  assert.doesNotMatch(unit, /Environment="BUILD_FLAVOR=dev"/);
  assert.ok(
    unit.includes(
      'Environment="CODEX_APP_SERVER_CHATGPT_BASE_URL=https://chatgpt.example/%%tenant"',
    ),
  );
  assert.ok(
    unit.includes(
      'Environment="CODEX_APP_SERVER_OPENAI_BASE_URL=https://api.example/?label=\\"primary\\""',
    ),
  );
  assert.ok(
    unit.includes(
      'ExecStartPre="systemd-run" "--user" "--scope" "--quiet" "--collect" "--" "/opt/bin/codex"',
    ),
  );
  assert.ok(
    unit.includes(
      '"chatgpt_base_url=\\"https://chatgpt.example/%%tenant\\""',
    ),
  );
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillMode=control-group/);
  assert.doesNotMatch(unit, /KillMode=process/);
});

test("installs and starts a managed user service", async context => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "codex-web-home-"));
  context.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const calls = [];
  const progressEvents = [];

  const result = await installUserService({
    projectRoot: "/srv/codex-web",
    host: "127.0.0.1",
    port: 4310,
    publicUrl: "https://codex.example.com",
    homeDirectory,
    nodePath: "/usr/bin/node",
    run: async (command, arguments_, options) => {
      calls.push([command, arguments_, options]);
      if (command === "journalctl") {
        return "Open https://codex.example.com/?cap=fixture\n";
      }
      return "";
    },
    wait: async () => {},
    urlWaitAttempts: 1,
    progress: event => progressEvents.push(event),
  });

  assert.equal(
    result.servicePath,
    join(homeDirectory, ".config", "systemd", "user", "codex-web.service"),
  );
  assert.equal(result.url, "https://codex.example.com/?cap=fixture");
  assert.match(await readFile(result.servicePath, "utf8"), /--port" "4310"/);
  assert.match(
    await readFile(result.servicePath, "utf8"),
    /--public-url" "https:\/\/codex\.example\.com"/,
  );  assert.deepEqual(
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
  assert.equal(calls[0][2].timeoutMs, 30_000);
  assert.equal(calls[3][2].timeoutMs, 10_000);
  assert.deepEqual(
    progressEvents
      .filter(event => event.status === "started")
      .map(event => event.phase),
    [
      "inspect systemd service",
      "write systemd service",
      "reload systemd",
      "enable systemd service",
      "restart systemd service",
      "read service journal",
    ],
  );
  assert.ok(
    progressEvents.some(
      event =>
        event.status === "info" &&
        event.message === "wait for service URL (attempt 1/1)",
    ),
  );
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
