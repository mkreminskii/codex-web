# codex-web

Serve the current upstream Codex Desktop interface in a Chromium-family browser on Linux.

`codex-web` extracts the official application, preserves its Electron main process and Codex app-server authority, and adapts only the renderer boundary.

The wrapper is a single-user service. It is not a replacement Codex client.

## What's working

* Chat and related features
* Terminal, Files, Review
* Right click context menu
* "Choose project" file browser

## Removed

* Show pet
* Browser
* Telemetry

## UI Changes

### Sidebar

- Renders tasks as two-row like activity view (Title + Project Name)
- Tasks without a workspace are labeled "No workspace"

## Screenshot

<img width="1836" height="1119" alt="CleanShot 2026-08-07 at 02 15 40@2x" src="https://github.com/user-attachments/assets/8f8b7c1c-a0be-444c-b25c-e69563fa765e" />

## Requirements

* Linux with systemd user services
* Node.js 22 or later, npm
* `7z`
* Python 3 and a native build toolchain
* Electron runtime libraries
* An installed `codex` CLI with the `app-server daemon` command, available through `PATH` or `CODEX_CLI_PATH`

## Quick Start

Install the recorded dependencies:

```sh
npm ci
```

The deployment command downloads and builds the current upstream application. It writes `~/.config/systemd/user/codex-web.service`, reloads systemd, and enables and restarts the service.

Deploy on the default loopback listener and a random available port:

```sh
./src/cli.mjs deploy
```

Open the complete capability URL printed by the command. The capability URL grants access to the service, so do not share it or store it in public logs.

## Deployment

`deploy` performs these operations:

1. Download and build the current upstream application.
2. Write a managed user unit at `~/.config/systemd/user/codex-web.service`.
3. Reload the user systemd manager.
4. Enable and restart `codex-web.service`.
5. Read and print the capability URL from the user journal.

The installer replaces only a unit marked as managed by `codex-web`. It refuses to replace an unrelated unit with the same name.

The service runs as the current Linux user. That user must have access to the Codex configuration, CLI, and selected workspaces.

The service starts or reuses the local Codex app-server daemon in a separate transient systemd scope. A local WebSocket proxy connects the application to the daemon control socket.

Stopping or restarting `codex-web.service` does not stop the shared daemon or its active work. A service failure removes abandoned Electron and proxy processes before systemd restarts the web adapter.

The generated service sets the upstream build flavor to `prod`.

Inspect the service:

```sh
systemctl --user status codex-web.service
journalctl --user -feu codex-web.service -o cat
```

Stop or restart the service:

```sh
systemctl --user stop codex-web.service
systemctl --user restart codex-web.service
```

## Network access

Set a specific listener host and port:

```sh
./src/cli.mjs deploy --host 127.0.0.1 --port 4310
```

Both `--host VALUE` and `--host=VALUE` are accepted. The `--port` and `--public-url` options support both forms.

Port `0` selects a random available port. Valid explicit ports are from `1` through `65535`.

Use `--public-url` when an HTTPS reverse proxy exposes `codex-web` at a public origin:

```sh
./src/cli.mjs deploy --host 127.0.0.1 --port 4310 --public-url https://codex.example.com
```

`codex-web` listens on the address from `--host` and `--port`. It uses the public origin for the reported browser URL and browser security checks.

The public URL must be an HTTPS origin without credentials, a path, a query, or a fragment. The reverse proxy must preserve the public `Host` and `Origin` headers and support WebSocket upgrades.

A wildcard or private-network listener is also supported:

```sh
./src/cli.mjs deploy --host 0.0.0.0 --port 4310
./src/cli.mjs deploy --host 192.168.1.20 --port 4310
```

Replace `0.0.0.0` in the reported URL with the reachable server address. Keep the port and capability unchanged.

Non-loopback traffic uses plain HTTP. Use a trusted private network or an encrypted tunnel.

### SSH tunnel

A loopback deployment can remain private behind SSH. Start a tunnel from the browser computer:

```sh
ssh -N -L 4310:127.0.0.1:4310 USER@SERVER
```

Open the capability URL reported by the remote service.

## Manual session

Build without installing a systemd service:

```sh
./src/cli.mjs build
```

Start the built application in the current terminal:

```sh
./src/cli.mjs serve
```

`serve` uses the default loopback listener and a random available port. It accepts the same listener and public URL options as `deploy`.

## Remote telemetry

The build removes these remote telemetry paths from the adapted application:

* Sentry renderer error reporting and its `sentry-ipc://` requests
* OpenTelemetry renderer trace exports that use the Sentry transport
* Statsig event logging, exposure logging, and SDK exception reports
* Segment structured product analytics
* Codex analytics submissions to `/wham/analytics-events/events`
* Codex app-server analytics, including explicit user configuration that enables analytics

The app-server receives `-c analytics.enabled=false`. This command-line override has priority over `config.toml`.

Statsig feature-configuration downloads remain enabled because application features use their results. Authentication and Codex API requests also remain enabled.

## Development

Run the source checks and focused tests:

```sh
npm run check
npm test
```

Validate the indexed specification and architecture documents:

```sh
pjdoc validate --scope all
```

## Design documents

* [Product brief](doc/brief.md)
* [Specification](doc/spec/index.md)
* [Architecture contracts](doc/architecture/index.md)
