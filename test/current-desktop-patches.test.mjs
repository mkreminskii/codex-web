import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import {
  patchCurrentAppServerTransport,
  patchCurrentIpcDelivery,
  patchCurrentMainTelemetry,
  patchCurrentNativeFeatures,
  patchCurrentRenderer,
  patchCurrentRpcTransport,
  patchCurrentShellCompatibility,
  patchCurrentSidePanel,
  patchCurrentWorkerTelemetry,
} from '../src/current-desktop-patches.mjs';
import { currentRendererFixture } from './fixtures/current-renderer.mjs';

function rendererContext() {
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  return { jsx, Message: 'label', Compiler: { c: () => [] }, loadCompiler: () => ({}),
    baseOptions: { networkConfig: { api: 'feature-config' } }, Response, sendAnalytics() {},
    fetch: async url => ({ url, status: 200 }) };
}

test('uses the directory browser and preserves selected folder and disabled state', () => {
  const context = rendererContext();
  const source = patchCurrentRenderer(currentRendererFixture);
  runInNewContext(source, context);
  let selected;
  const rendered = context.LocalFolder({ sources: ['/work'], disabled: true, setSources: paths => selected = paths });
  const browser = rendered.props.children[1];
  assert.equal(browser.type, context.DirectoryBrowser);
  assert.equal(browser.props.hostId, 'local');
  assert.equal(browser.props.selectedPath, '/work');
  assert.equal(browser.props.disabled, true);
  browser.props.setSelectedPath('/next');
  assert.deepEqual(Array.from(selected), ['/next']);
  browser.props.setSelectedPath('');
  assert.deepEqual(Array.from(selected), []);
});

test('disables analytics while keeping feature configuration downloads', async () => {
  const context = rendererContext();
  runInNewContext(patchCurrentRenderer(currentRendererFixture), context);
  const options = context.statsigOptions(true);
  assert.equal(options.loggingEnabled, 'disabled');
  assert.equal(options.disableStorage, true);
  assert.equal(options.networkConfig.api, 'feature-config');
  for (const url of ['https://ab.chatgpt.com/v1/rgstr', 'https://ab.chatgpt.com/v1/sdk_exception']) {
    assert.equal((await context.statsigTransport(url, {}, true)).status, 204);
  }
  assert.equal((await context.statsigTransport('https://ab.chatgpt.com/v1/initialize', {})).url,
    'https://ab.chatgpt.com/v1/initialize');
  assert.equal(context.analyticsProvider('chatgpt').submitCodexAnalyticsEvent, null);
});

test('redirects only the local app-server to the proxy', async () => {
  const original = 'class C{async connect(){let e=[],t=await resolver(this.options,e);if(!t)throw Error(`Unable to locate the Codex CLI binary or required runtime components.`);return t}}async function resolver(e,t=[]){if(process.platform===`win32`)return null;return upstream(e,t)}';
  const source = patchCurrentAppServerTransport(original);
  const context = { process: { platform: 'linux', env: { CODEX_WEB_APP_SERVER_PROXY_PATH: '/proxy' } }, upstream: () => 'remote' };
  runInNewContext(source, context);
  const local = await context.resolver({ hostConfig: { kind: 'local' }, repoRoot: '/work' });
  assert.equal(local.executablePath, '/proxy');
  assert.deepEqual(Array.from(local.args), []);
  assert.equal(await context.resolver({ hostConfig: { kind: 'ssh' } }), 'remote');
  assert.equal(patchCurrentAppServerTransport(source), source);
});

test('turns off main and worker telemetry for the web host', () => {
  const context = { process: { env: { CODEX_WEB_HEADLESS: '1' } }, exportTraces: () => assert.fail('must not export'), startSentry: () => assert.fail('must not initialize') };
  runInNewContext(patchCurrentMainTelemetry('var enabled=e=>e.analytics?.enabled!==!1;'), context);
  assert.equal(context.enabled({ analytics: { enabled: true } }), false);
  context.process.env.CODEX_WEB_HEADLESS = '0';
  assert.equal(context.enabled({ analytics: { enabled: true } }), true);
  context.process.env.CODEX_WEB_HEADLESS = '1';
  runInNewContext(patchCurrentWorkerTelemetry('function init(e,t,n,r){r!=null&&exportTraces(e,`git-worker`,r);return()=>startSentry(e)}'), context);
  context.init({}, null, null, () => {})();
});

test('hides the browser launcher and rejects missing patch targets', () => {
  const source = 'function launcher(e){let t=(0,Compiler.c)(13),c={name:`browser.in-app`};let l=capability(Capability,c).isCapable,u;return{id:`thread.sidePanel.openTab`,enabled:l}}';
  const context = { Compiler: { c: () => [] } };
  runInNewContext(patchCurrentSidePanel(source), context);
  assert.equal(context.launcher({}).enabled, false);
  assert.throws(() => patchCurrentRenderer('function unrelated(){}'), /local source-folder component/);
  assert.throws(() => patchCurrentAppServerTransport(''), /app-server command resolver/);
});

test('selects the built-in string RPC codec on MessagePort transports', () => {
  const source = patchCurrentRpcTransport('var RpcPort=class{encodingLevel=`structuredClonable`};');
  const context = {};
  runInNewContext(source, context);
  assert.equal(new context.RpcPort().encodingLevel, 'string');
  assert.equal(patchCurrentRpcTransport(source), source);
  assert.throws(() => patchCurrentRpcTransport(''), /MessagePort RPC encoding/);
  assert.throws(() => patchCurrentRpcTransport('encodingLevel=`structuredClonable`;encodingLevel=`structuredClonable`'), /found 2/);
});

test('headless IPC cannot stall on a chunk acknowledgement before a browser connects', () => {
  const original = 'var Sender=class{send(e,t,n){e.isDestroyed()||this.sender.send(e,{channel:t,payload:n})}sendInline(e,t,n){e.isDestroyed()||this.sender.sendInline(e,{channel:t,payload:n})}sendCritical(e,t,n){e.isDestroyed()||this.sender.sendCritical(e,{channel:t,payload:n})}};';
  const source = patchCurrentIpcDelivery(original);
  const context = { process: { env: { CODEX_WEB_HEADLESS: '1' } } };
  runInNewContext(source, context);
  const sent = [], upstream = [], sender = new context.Sender();
  sender.sender = Object.fromEntries(['send', 'sendInline', 'sendCritical'].map(method => [method, (...args) => upstream.push([method, ...args])]));
  const target = { isDestroyed: () => false, send: (...args) => sent.push(args) };
  for (const method of ['sendCritical', 'send', 'sendInline']) sender[method](target, 'for-view', { type: method });
  assert.deepEqual(sent.map(([channel, payload]) => [channel, payload.type]),
    [['for-view', 'sendCritical'], ['for-view', 'send'], ['for-view', 'sendInline']]);
  assert.equal(upstream.length, 0);
  sender.send({ isDestroyed: () => true, send: () => assert.fail('destroyed') }, '', {});
  context.process.env.CODEX_WEB_HEADLESS = '0';
  sender.sendCritical(target, 'for-view', {});
  assert.equal(upstream[0][0], 'sendCritical');
  assert.equal(patchCurrentIpcDelivery(source), source);
});

test('allows stock Electron only for headless launches and skips unavailable reporting APIs', () => {
  const original = 'function check(){if(process.versions.electron!=null&&typeof f.app.showTaskManager!=`function`)throw Error(`Codex requires the Owl app shell; stock Electron is no longer supported.`);f.app.setWebsiteReportingEnabled(!1);f.app.setWebsiteReportingEnabled(!1);f.app.setWebsiteReportingEnabled(!1)}';
  const source = patchCurrentShellCompatibility(original);
  const context = { process: { versions: { electron: '42.3.0' }, env: { CODEX_WEB_HEADLESS: '1' } }, f: { app: {} } };
  runInNewContext(source, context);
  assert.doesNotThrow(() => context.check());
  context.process.env.CODEX_WEB_HEADLESS = '0';
  assert.throws(() => context.check(), /requires the Owl app shell/);
  assert.equal(patchCurrentShellCompatibility(source), source);
});

test('falls back for absent Owl capabilities and keeps the native browser disabled', async () => {
  const original = 'function nativeFeatures(){l.app.setDebugChromePagesEnabled(!1);l.app.setDebugChromePagesEnabled(!1);l.app.setDebugChromePagesEnabled(!1);l.app.setRuntimeFeatures({});l.app.setRuntimeFeatures({});return [l.BrowserWindow.isInputShapeSupported(),l.BrowserWindow.isSystemBackdropSupported(),l.screen.isCursorScreenPointSupported(),l.app.isRuntimeFeatureEnabled(feature)]}var BrowserHost=class{async setInAppBrowserFeatureEnabled(e,t){return e}};';
  const source = patchCurrentNativeFeatures(original);
  const context = { process: { env: { CODEX_WEB_HEADLESS: '1' } }, l: { app: {}, BrowserWindow: {}, screen: {} }, feature: 'browser' };
  runInNewContext(source, context);
  assert.deepEqual(Array.from(context.nativeFeatures()), [false, false, false, false]);
  assert.equal(await new context.BrowserHost().setInAppBrowserFeatureEnabled(true), false);
  context.process.env.CODEX_WEB_HEADLESS = '0';
  assert.equal(await new context.BrowserHost().setInAppBrowserFeatureEnabled(true), true);
  assert.equal(patchCurrentNativeFeatures(source), source);
});
