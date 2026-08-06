---
pjdoc:
  version: 1
  kind: spec
  scope: root
  status: draft
  revision: SPEC-2
  files: []
---

# codex-web first-draft specification

The product context and supplied constraints are authoritative in [the brief](../brief.md).

## REQ-BUILD-001 — Build from the current upstream application

The wrapper shall use an explicit local current `Codex.dmg`, or download the current official DMG when no path is supplied, and produce a runnable local web wrapper.

Acceptance:

- Given an authorized current DMG, the documented build entry point completes successfully.
- Given no explicit DMG path, the build downloads the current official DMG over HTTPS before extraction.
- The output contains the extracted upstream interface and only the compatibility changes required by this specification.
- Given a missing, unreadable, or structurally incompatible DMG, the build exits unsuccessfully with a specific diagnostic.
- The project source and distributable wrapper do not contain a committed upstream DMG or extracted upstream application payload.

## REQ-UI-001 — Serve the upstream interface

The running wrapper shall serve the extracted upstream Codex interface to a Chromium-family browser on the same host.

Acceptance:

- The start entry point reports its loopback URL.
- Opening that URL renders the upstream Codex interface without a replacement application shell.
- The service does not listen on a non-loopback address in the first draft.
- A browser request for an unknown application asset does not return the main HTML document as false success.

## REQ-BRIDGE-001 — Preserve the upstream Codex authority

The browser compatibility bridge shall connect the upstream interface to the upstream Codex app-server authority.

Acceptance:

- The interface can select one existing local workspace through its upstream workspace flow.
- The interface can start one thread and submit one prompt.
- Response items appear incrementally in the upstream interface.
- The completed response remains visible in that thread.
- The bridge does not define a second Codex conversation protocol.

## REQ-APPROVAL-001 — Preserve approval behavior

The wrapper shall preserve approval requests on the core conversation path.

Acceptance:

- When the Codex app-server requests approval, the upstream interface displays the request.
- The user's decision is returned to the same authority.
- Closing the browser does not automatically approve a pending request.

## REQ-FAIL-001 — Fail honestly

The wrapper shall report failures that prevent the core path from completing.

Acceptance:

- App-server startup failure is visible in the start command and browser.
- Bridge disconnection is visible in the browser.
- An unsupported required Electron operation produces a named unsupported-operation error.
- Upstream patch drift fails the build before it replaces a previously working generated output.

## Requirement coverage

Current must-have requirements: `REQ-BUILD-001`, `REQ-UI-001`, `REQ-BRIDGE-001`, `REQ-APPROVAL-001`, and `REQ-FAIL-001`.

There are no deferred requirements in this first-draft specification.
