import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appServerDaemonArguments } from "./runtime-host.mjs";
import { runBufferedCommand } from "./process-runner.mjs";
import { reportProgress, runPhase } from "./progress.mjs";

const serviceName = "codex-web.service";
const managedMarker = "# Managed by codex-web";
const serviceEnvironmentNames = [
  "PATH",
  "CODEX_CLI_PATH",
  "CODEX_HOME",
  "CODEX_APP_SERVER_CHATGPT_BASE_URL",
  "CODEX_APP_SERVER_OPENAI_BASE_URL",
];

function quoteSystemdArgument(value) {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("A systemd service argument contains an unsupported control character");
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

export function createUserServiceUnit({
  projectRoot,
  host,
  port,
  publicUrl = null,
  environment = process.env,
  nodePath = process.execPath,
}) {
  const cliPath = join(projectRoot, "src", "cli.mjs");
  const command = [
    nodePath,
    cliPath,
    "serve",
    "--host",
    host,
    "--port",
    String(port),
    ...(publicUrl === null ? [] : ["--public-url", publicUrl]),
  ]
    .map(quoteSystemdArgument)
    .join(" ");
  const daemonExecutable = environment.CODEX_CLI_PATH?.trim();
  const daemonCommand = [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--",
    ...(daemonExecutable ? [daemonExecutable] : ["/usr/bin/env", "codex"]),
    ...appServerDaemonArguments(environment),
  ]
    .map(quoteSystemdArgument)
    .join(" ");
  const environmentLines = [
    `Environment=${quoteSystemdArgument("BUILD_FLAVOR=prod")}`,
    ...serviceEnvironmentNames
      .filter(name => environment[name])
      .map(name =>
        `Environment=${quoteSystemdArgument(`${name}=${environment[name]}`)}`,
      ),
  ].join("\n");

  return `${managedMarker}
[Unit]
Description=codex-web upstream Codex browser wrapper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${environmentLines}\nExecStartPre=${daemonCommand}
ExecStart=${command}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

async function runCommand(
  command,
  arguments_,
  {
    label = command,
    timeoutMs = 30_000,
  } = {},
) {
  const result = await runBufferedCommand(command, arguments_, {
    label,
    timeoutMs,
  });
  return result.output;
}

function reportedUrl(output) {
  for (const line of output.trimEnd().split(/\r?\n/).reverse()) {
    if (line.startsWith("Open http://") || line.startsWith("Open https://")) {
      return line.slice("Open ".length).trim();
    }
  }
  return null;
}

export async function installUserService({
  projectRoot,
  host,
  port,
  publicUrl = null,
  homeDirectory = homedir(),
  nodePath = process.execPath,
  environment = process.env,
  run = runCommand,
  wait = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
  urlWaitAttempts = 30,
  progress,
}) {
  const serviceDirectory = join(
    homeDirectory,
    ".config",
    "systemd",
    "user",
  );
  const servicePath = join(serviceDirectory, serviceName);
  await runPhase(progress, "inspect systemd service", async () => {
    const existing = await readFile(servicePath, "utf8").catch(error => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (existing !== null && !existing.startsWith(`${managedMarker}\n`)) {
      throw new Error(
        `Refusing to replace an unmanaged systemd service: ${servicePath}`,
      );
    }
  });

  await runPhase(progress, "write systemd service", async () => {
    await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${servicePath}.tmp-${process.pid}-${randomUUID()}`;
    const unit = createUserServiceUnit({
      projectRoot,
      host,
      port,
      publicUrl,
      nodePath,
      environment,
    });
    try {
      await writeFile(temporaryPath, unit, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, servicePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  });

  const startedAfter = new Date().toISOString();
  await runPhase(progress, "reload systemd", () =>
    run(
      "systemctl",
      ["--user", "daemon-reload"],
      { label: "reload systemd", timeoutMs: 30_000 },
    ),
  );
  await runPhase(progress, "enable systemd service", () =>
    run(
      "systemctl",
      ["--user", "enable", serviceName],
      { label: "enable systemd service", timeoutMs: 30_000 },
    ),
  );
  await runPhase(progress, "restart systemd service", () =>
    run(
      "systemctl",
      ["--user", "restart", serviceName],
      { label: "restart systemd service", timeoutMs: 30_000 },
    ),
  );

  const journalArguments = [
    "--user",
    "--unit",
    serviceName,
    "--since",
    startedAfter,
    "--output=cat",
    "--no-pager",
  ];
  for (let attempt = 0; attempt < urlWaitAttempts; attempt += 1) {
    reportProgress(
      progress,
      `wait for service URL (attempt ${attempt + 1}/${urlWaitAttempts})`,
    );
    const output = await runPhase(progress, "read service journal", () =>
      run(
        "journalctl",
        journalArguments,
        { label: "read service journal", timeoutMs: 10_000 },
      ),
    );
    const url = reportedUrl(output);
    if (url !== null) {
      return { servicePath, url };
    }
    await wait(1_000);
  }

  throw new Error(
    `The service started but did not report an access URL. Inspect it with: journalctl --user --unit ${serviceName}`,
  );
}
