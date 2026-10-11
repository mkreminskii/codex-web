import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { browserBridgeSource, browserWebsiteUrl } from "../src/upstream-patches.mjs";

function browserFixture() {
  const listeners = new Map();
  const opened = [];
  const sent = [];
  let socket;
  class Element {
    constructor(href, { download = false, link = this } = {}) {
      this.href = href;
      this.download = download;
      this.link = link;
      this.rel = new Set(["nofollow"]);
      this.relList = { add: (...values) => values.forEach(value => this.rel.add(value)) };
    }
    closest() { return this.link; }
    getAttribute() { return this.href; }
    hasAttribute(name) { return name === "download" && this.download; }
  }
  const context = {
    URL,
    Element,
    location: new URL("https://codex.example.test/"),
    performance: { timeOrigin: 0 },
    document: { documentElement: { dataset: {}, classList: { add() {} } } },
    matchMedia: () => ({ addEventListener() {} }),
    XMLHttpRequest: class {
      status = 200;
      responseText = JSON.stringify({ sharedObjectSnapshot: {}, systemThemeVariant: "light" });
      open() {}
      send() {}
    },
    WebSocket: class {
      listeners = new Map();
      constructor() { socket = this; }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      send(message) { sent.push(JSON.parse(message)); }
    },
    window: {
      addEventListener(type, callback, options) { listeners.set(type, { callback, options }); },
      open: (...args) => opened.push(args),
    },
  };
  runInNewContext(browserBridgeSource, context);
  function click(href, { type = "click", nested = false, download = false, ...overrides } = {}) {
    const link = new Element(href, { download });
    const event = {
      target: nested ? new Element(null, { link }) : link,
      button: 0,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...overrides,
    };
    listeners.get(type).callback(event);
    return { link, event };
  }
  return { context, listeners, opened, sent, click, connect: () => socket.listeners.get("open")() };
}

test("accepts only absolute HTTP(S) website URLs without credentials", () => {
  for (const url of ["https://example.com/docs?x=1#details", "http://localhost:8080/", "HTTPS://EXAMPLE.COM/"]) {
    assert.equal(browserWebsiteUrl(url).href, new URL(url).href);
  }
  for (const url of [null, {}, "invalid", "/@fs/file", "#heading", "codex://review", "app://page", "file:///tmp/file", "mailto:a@example.com", "javascript:alert(1)", "https://user:password@example.com/"]) {
    assert.equal(browserWebsiteUrl(url), null);
  }
});

test("captures website clicks before desktop handlers while keeping native navigation", () => {
  const browser = browserFixture();
  for (const options of [{}, { nested: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { type: "auxclick", button: 1 }, { detail: 0 }]) {
    const { link, event } = browser.click("https://example.com/", options);
    assert.equal(link.target, "_blank");
    assert.deepEqual([...link.rel], ["nofollow", "noopener", "noreferrer"]);
    assert.equal(event.stopped, true);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(browser.listeners.get("click").options.capture, true);
  assert.equal(browser.listeners.get("auxclick").options.capture, true);
  assert.deepEqual(browser.opened, [], "anchor navigation uses the browser's native default action");
  assert.deepEqual(browser.sent, [], "website clicks never reach the host relay");
});

test("preserves file links, app navigation, downloads, and non-navigation clicks", () => {
  const browser = browserFixture();
  for (const [href, options] of [
    ["/@fs/tmp/file", {}], ["https://codex.example.test/@fs/tmp/file", {}],
    ["#heading", {}], ["codex://review", {}], ["app://page", {}],
    ["https://example.com/", { download: true }],
    ["https://example.com/", { button: 2 }],
    ["https://example.com/", { defaultPrevented: true }],
  ]) {
    const { link, event } = browser.click(href, options);
    assert.equal(link.target, undefined);
    assert.equal(event.stopped, false);
  }
});

test("opens website buttons synchronously without relaying to the internal browser", async () => {
  const browser = browserFixture();
  for (const [index, openTarget] of [undefined, "in-app-browser", "external-browser"].entries()) {
    const result = browser.context.electronBridge.sendMessageFromView({
      type: "open-in-browser", url: "https://example.com/", openTarget,
    });
    assert.equal(browser.opened.length, index + 1, "the popup opens before awaiting the result");
    await result;
  }
  assert.deepEqual(browser.opened, Array(3).fill(["https://example.com/", "_blank", "noopener,noreferrer"]));
  assert.deepEqual(browser.sent, [], "no WebSocket connection is needed for website buttons");

  const message = { type: "open-in-browser", url: "mailto:a@example.com" };
  void browser.context.electronBridge.sendMessageFromView(message);
  browser.connect();
  await new Promise(resolve => setImmediate(resolve));
  const request = browser.sent.find(value => value.method === "sendMessageFromView");
  assert.deepEqual(request.args, [message], "other protocols keep the upstream handler");
  assert.equal(browser.opened.length, 3);
});
