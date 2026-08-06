# codex-web brief

## Problem

Linux users can run the upstream Codex Desktop application through an Electron wrapper, but they cannot use that upstream interface in a normal browser.

## Outcome

`codex-web` wraps the current official Codex Desktop application and serves its upstream interface to a browser on the same Linux host.

## First-draft scope

The wrapper accepts an authorized current `Codex.dmg`, extracts its application and webview bundles, and applies browser compatibility patches.

A documented local build entry point produces a runnable wrapper without replacing the upstream interface.

A documented local start entry point serves the patched upstream interface and its required bridge on a loopback address.

The upstream interface can open one existing local workspace, submit one Codex prompt, stream the response, and resolve an approval request.

Unsupported desktop operations and upstream bundle drift produce visible failures.

## User-visible surface

The user builds the wrapper from a local `Codex.dmg`.

The user starts one local service.

The user opens the reported loopback URL in a supported browser.

The browser displays the extracted upstream Codex interface.

## Non-goals

The first draft does not create a new Codex interface.

The first draft does not support remote clients, multiple users, package formats, mobile layouts, or general ChatGPT features.

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

The first draft supports a Chromium-family browser on the same Linux host.

