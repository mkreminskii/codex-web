# codex-web

Serve the current upstream Codex Desktop interface in a Chromium-family browser on Linux.

`codex-web` extracts the official application, preserves its Electron main process and Codex app-server authority, and adapts only the renderer boundary.

The wrapper is a single-user service. It is not a replacement Codex client.

## Requirements

- Linux
- Node.js 22 or later
- npm
- `7z`
- Python 3 and a native build toolchain
- Electron runtime libraries
- An installed `codex` CLI with the `app-server daemon` command, available through `PATH` or `CODEX_CLI_PATH`

Do not commit or redistribute `dist/` or `work/`. These directories contain downloaded or extracted upstream application files.

## Quick start

Install the recorded dependencies:

```sh
npm ci
```

Build from the current official DMG:

```sh
./src/cli.mjs build
```

Start on the default loopback listener and a random available port:

```sh
./src/cli.mjs serve
```

Open the complete capability URL printed by the command.

## Listener options

Set a specific listener host and port:

```sh
./src/cli.mjs serve --host 127.0.0.1 --port 4310
```

Both `--host VALUE` and `--host=VALUE` are accepted. The port option supports both forms.

Port `0` selects a random available port. Valid explicit ports are from `1` through `65535`.

Use `--public-url` when an HTTPS reverse proxy exposes `codex-web` at a public origin. The flag works with both `serve` and `deploy`.

```sh
./src/cli.mjs deploy \
  --host 127.0.0.1 \
  --port 4310 \
  --public-url https://codex.example.com
```

`codex-web` continues to listen on the address from `--host` and `--port`. It uses the public origin for the reported browser URL and browser security checks.

The value must be an HTTPS origin without credentials, a path, a query, or a fragment. The reverse proxy must terminate TLS, preserve the public `Host` and `Origin` headers, and support WebSocket upgrades.

Both `--public-url VALUE` and `--public-url=VALUE` are accepted.

A wildcard listener is supported:

```sh
./src/cli.mjs serve --host 0.0.0.0 --port 4310
```

Replace `0.0.0.0` in the reported URL with the reachable server address. Keep the port and capability unchanged.

Non-loopback traffic uses plain HTTP. Use a trusted private network or an encrypted tunnel.

The capability URL grants access to the service. Do not share it or store it in public logs.

## Automated deployment

The deployment command performs these operations:

1. Download and build the current upstream application.
2. Write a managed user unit at `~/.config/systemd/user/codex-web.service`.
3. Reload the user systemd manager.
4. Enable and restart `codex-web.service`.
5. Read and print the capability URL from the user journal.

The service starts or reuses the local Codex app-server daemon in a separate transient systemd scope. A local WebSocket proxy connects the upstream application to the daemon control socket.

Restarting or stopping `codex-web.service` does not stop the shared daemon or its active work.
A service failure removes abandoned Electron and proxy processes before systemd restarts the web adapter.
The generated service sets the upstream build flavor to `prod` explicitly.

Deploy on loopback:

```sh
./src/cli.mjs deploy --host 127.0.0.1 --port 4310
```

Deploy on a private network interface:

```sh
./src/cli.mjs deploy --host 192.168.1.20 --port 4310
```

The installer replaces only a unit marked as managed by `codex-web`. It refuses to replace an unrelated unit with the same name.

The service runs as the current Linux user. That user must have access to the Codex configuration, CLI, and selected workspaces.

Inspect the service:

```sh
systemctl --user status codex-web.service
journalctl --user --unit codex-web.service --output=cat
```

Stop or restart the service:

```sh
systemctl --user stop codex-web.service
systemctl --user restart codex-web.service
```

## Remote browser access

A loopback deployment can remain private behind SSH.

Start an SSH tunnel from the browser computer:

```sh
ssh -N -L 4310:127.0.0.1:4310 USER@SERVER
```

Then open the capability URL reported by the remote service.

## Validation

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

- [Product brief](doc/brief.md)
- [Specification](doc/spec/index.md)
- [Architecture contracts](doc/architecture/index.md)
