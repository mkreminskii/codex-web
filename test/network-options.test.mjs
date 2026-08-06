import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAuthority,
  normalizeHost,
  normalizePort,
  normalizePublicUrl,
} from "../src/network-options.mjs";

test("normalizes supported hosts and ports", () => {
  assert.equal(normalizeHost("EXAMPLE.COM."), "example.com");
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(normalizeHost("0.0.0.0"), "0.0.0.0");
  assert.equal(normalizePort("0"), 0);
  assert.equal(normalizePort("65535"), 65_535);
  assert.equal(formatAuthority("::1", 4310), "[::1]:4310");
  assert.equal(
    normalizePublicUrl("https://CODEX.EXAMPLE.COM:8443"),
    "https://codex.example.com:8443",
  );
});

test("rejects invalid hosts and ports", () => {
  assert.throws(() => normalizeHost("bad host"), /Invalid host/);
  assert.throws(() => normalizeHost(""), /non-empty/);
  assert.throws(() => normalizePort("-1"), /Invalid port/);
  assert.throws(() => normalizePort("65536"), /Invalid port/);
  assert.throws(() => normalizePort("08"), /Invalid port/);
  assert.throws(() => normalizePublicUrl("http://codex.example.com"), /HTTPS/);
  assert.throws(() => normalizePublicUrl("https://codex.example.com/app"), /HTTPS origin/);
});
