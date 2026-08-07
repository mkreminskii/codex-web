import assert from "node:assert/strict";
import test from "node:test";

import { keyboardShortcutSignature } from "../src/upstream-patches.mjs";

function keyboardEvent(key, modifiers = {}) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

test("normalizes browser keyboard events to Electron accelerator signatures", () => {
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("k", { ctrlKey: true }), false),
    "control+k",
  );
  assert.equal(
    keyboardShortcutSignature(
      keyboardEvent("P", { ctrlKey: true, shiftKey: true }),
      false,
    ),
    "control+p+shift",
  );
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("k", { metaKey: true }), true),
    "command+k",
  );
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("k", { altKey: true }), true),
    "k+option",
  );
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("ArrowLeft", { altKey: true }), false),
    "alt+left",
  );
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("+", { ctrlKey: true }), false),
    "control+plus",
  );
  assert.equal(
    keyboardShortcutSignature(keyboardEvent("Control", { ctrlKey: true }), false),
    null,
  );
});

