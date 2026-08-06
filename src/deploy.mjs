import { spawn } from "node:child_process";
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

const serviceName = "codex-web.service";
const managedMarker = "# Managed by codex-web";
const serviceEnvironmentNames = [
  "PATH",
  "CODEX_CLI_PATH",
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
  const environmentLines = serviceEnvironmentNames
    .filter(name => environment[name])
    .map(name =>
      `Environment=${quoteSystemdArgument(`${name}=${environment[name]}`)}`,
    )
    .join("\n");

  return `${managedMarker}
[Unit]
Description=codex-web upstream Codex browser wrapper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${environmentLines === "" ? "" : `${environmentLines}\n`}ExecStartPre=${daemonCommand}
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

async function runCommand(command, arguments_) {
  const output = [];
  const child = spawn(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => output.push(chunk));
  }
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, output: output.join("") }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with code ${result.code}: ${result.output.trim()}`,
    );
  }
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
}) {
  const serviceDirectory = join(
    homeDirectory,
    ".config",
    "systemd",
    "user",
  );
  const servicePath = join(serviceDirectory, serviceName);
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

  const startedAfter = new Date().toISOString();
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", serviceName]);
  await run("systemctl", ["--user", "restart", serviceName]);

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
    const url = reportedUrl(await run("journalctl", journalArguments));
    if (url !== null) {
      return { servicePath, url };
    }
    await wait(1_000);
  }

  throw new Error(
    `The service started but did not report an access URL. Inspect it with: journalctl --user --unit ${serviceName}`,
  );
}
