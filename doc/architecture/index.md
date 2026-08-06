---
pjdoc:
  version: 1
  kind: architecture
  scope: root
  status: draft
  revision: ARCH-4
  files: []
---

# codex-web architecture contracts

The current implementation scope is defined by `REQ-BUILD-001`, `REQ-UI-001`, `REQ-DEPLOY-001`, `REQ-BRIDGE-001`, `REQ-PROJECT-001`, `REQ-APPROVAL-001`, and `REQ-FAIL-001` in [the specification](../spec/index.md).

## CTR-UPSTREAM-001 — Upstream payload boundary

The build owner reads the authorized DMG and treats every extracted OpenAI file as generated input.

Generated upstream files remain outside the source tree and outside distributable source archives.

The build owner applies compatibility changes to a candidate output and promotes that candidate only after structural validation succeeds.

The compatibility rules target only the current upstream layout specified by `doc/brief.md#supplied-constraints`.

## CTR-BRIDGE-001 — Browser bridge boundary

The build owner derives the browser-facing bridge surface from the current upstream preload and renderer bundles instead of defining a replacement product interface.

The upstream Electron main-process bundle remains the application host. A compatibility patch redirects its renderer IPC boundary to a same-origin browser transport without creating a visible BrowserWindow.

The runtime owner forwards Codex app-server messages without defining a second conversation protocol.

Browser transport code depends on the derived bridge contract. Upstream extraction and app-server lifecycle code do not depend on browser presentation code.

## CTR-AUTHORITY-001 — Process and data authority

The runtime owner ensures that the local Codex app-server daemon is available before it starts the upstream application host.

The patched upstream Electron main process owns only its daemon proxy transport. It does not own or stop the daemon.

The shared local Codex app-server daemon owns threads, turns, approval requests, workspace operations, and their durable process lifetime.

The browser owns presentation state only.

A browser disconnect never converts a pending approval into approval.

## CTR-TRUST-001 — Browser trust boundary

The runtime owner binds application and bridge endpoints to loopback by default and accepts a non-loopback listener only through explicit host configuration.

The runtime owner requires a per-launch browser capability and accepts browser WebSockets only when their Host and Origin values describe the same configured listener.

The runtime owner validates workspace paths before it forwards them to the upstream authority.

The wrapper does not expose the app-server socket or byte stream directly to untrusted network clients.

## CTR-DEPLOY-001 — User-service deployment boundary

The deployment owner builds the current generated wrapper before it changes service configuration.

The deployment owner writes only its marked `codex-web.service` user unit and refuses to replace an unmarked unit.

The generated unit invokes the ordinary serve entry point with explicit host and port values.
The generated unit starts or reuses the shared daemon in a transient systemd scope before it starts the serve process.

The deployment owner uses the user systemd manager for reload, enable, restart, and current capability URL discovery.

Restarting the user service replaces only the web adapter and its proxy transport. The shared daemon and active turns remain running.
The generated unit uses control-group cleanup for the web adapter, Electron, and proxy processes after a service failure.

## CTR-FAILURE-001 — Cross-boundary failure propagation

The build owner reports extraction, discovery, patch, and validation failures before candidate promotion.

The runtime owner reports child startup and transport failures to both the start entry point and the browser when each surface is available.

The browser bridge returns named unsupported-operation errors for required Electron operations that have no browser adapter.

No boundary converts a failed or unknown result into success.
