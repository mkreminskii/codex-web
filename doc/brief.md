# codex-web brief

## Problem

Linux users can run the upstream Codex Desktop application through an Electron wrapper, but they cannot use that upstream interface in a normal browser.

## Outcome

`codex-web` wraps the current official Codex Desktop application and serves its upstream interface to a Chromium-family browser from a Linux host.

## First-draft scope

The wrapper accepts an authorized current `Codex.dmg`, extracts its application and webview bundles, and applies browser compatibility patches.

A documented local build entry point produces a runnable wrapper without replacing the upstream interface.

A documented start entry point serves the patched upstream interface and bridge on configurable host and port values.

A documented deployment entry point builds the wrapper and installs a user-level systemd service.
The upstream interface can open one existing local workspace, submit one Codex prompt, stream the response, and resolve an approval request.
The local project flow reuses the upstream remote-project folder browser against the local host and starts at the service user's home directory.

Unsupported desktop operations and upstream bundle drift produce visible failures.

## User-visible surface

The user builds the wrapper from a local `Codex.dmg`.

The user starts one local service.

The user opens the capability URL reported by the start or deployment entry point.

The browser displays the extracted upstream Codex interface.
The local Create project dialog shows the same source-folder browser as New remote project, without a remote-host field.

## Non-goals

The first draft does not create a new Codex interface.

The first draft does not support multiple users, package formats, mobile layouts, public TLS termination, or general ChatGPT features.

The first draft does not promise support for desktop-only integrations beyond the core conversation path.

## Supplied constraints

The wrapper uses only the latest upstream application layout.

The upstream webview remains the user-visible interface.

The upstream Codex app-server remains the Codex authority.

Wrapper code owns extraction, compatibility patches, serving, lifecycle, and transport adaptation.

The project does not redistribute OpenAI application code, assets, or binaries.

The project path is `/home/yusing/projects/codex-web`.

## Assumptions

The host has an authorized current `Codex.dmg`.

The first draft supports a Chromium-family browser that can reach the configured Linux host and port.
