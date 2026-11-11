'use strict';
// Run with: npm test   (needs only Node, no Electron)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, stripComments, parseText, loadConfig } = require('../lib/config');
const { createUrlPolicy } = require('../lib/urls');
const { isPermissionAllowed } = require('../lib/permissions');
const { mimeFor, resolveAppFile } = require('../lib/files');
const appUpdate = require('../lib/appupdate');
 
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'precenter-'));
 
// ---- config ----
test('comments are stripped but https:// inside text survives', () => {
  const t = stripComments('{ // note\n "a": "https://x.y/z", /* c */ "b": 1, }');
  assert.deepStrictEqual(JSON.parse(t), { a: 'https://x.y/z', b: 1 });
});
test('the shipped default file parses and equals the built-in defaults', () => {
  const text = fs.readFileSync(path.join(root, 'config', 'config.default.json'), 'utf8');
  const r = parseText(text);
  assert.strictEqual(r.error, '');
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.config, DEFAULTS);
});
test('a fresh install starts in remote mode', () => {
  const r = parseText('{}');
  assert.strictEqual(r.config.mode, 'remote');
  assert.strictEqual(r.config.startUrl, 'https://precenter-bay.vercel.app/');
});
test('user values override defaults and wrong types are reported', () => {
  const r = parseText('{ "window": { "width": 1200, "height": "tall" }, "devTools": true, "externalLinks": "nope" }');
  assert.strictEqual(r.config.window.width, 1200);
  assert.strictEqual(r.config.window.height, DEFAULTS.window.height);
  assert.strictEqual(r.config.devTools, true);
  assert.strictEqual(r.config.externalLinks, 'browser');
  assert.ok(r.warnings.some(w => /window\.height/.test(w)));
  assert.ok(r.warnings.some(w => /externalLinks/.test(w)));
});
test('unknown settings are reported, extra permissions are allowed', () => {
  const r = parseText('{ "colour": 1, "permissions": { "usb": true } }');
  assert.ok(r.warnings.some(w => /colour/.test(w)));
  assert.strictEqual(r.config.permissions.usb, true);
});
test('remote mode needs a real https address', () => {
  assert.strictEqual(parseText('{ "mode": "remote", "startUrl": "" }').config.mode, 'local');
  assert.strictEqual(parseText('{ "mode": "remote", "startUrl": "http://evil.example/" }').config.mode, 'local');
  const ok = parseText('{ "mode": "remote", "startUrl": "https://worship-chords-rho.vercel.app/presenter.html" }');
  assert.strictEqual(ok.config.mode, 'remote');
});
test('broken JSON falls back to defaults and says so', () => {
  const r = parseText('{ "mode": ');
  assert.ok(r.error);
  assert.deepStrictEqual(r.config, DEFAULTS);
});
test('first run writes config.json from the default; a second run keeps edits', () => {
  const dir = tmp();
  const def = path.join(root, 'config', 'config.default.json');
  const a = loadConfig(dir, def);
  assert.strictEqual(a.created, true);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  fs.writeFileSync(path.join(dir, 'config.json'), '{ "devTools": true }');
  const b = loadConfig(dir, def);
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.config.devTools, true);
});
test('a broken config.json on disk is reported and never overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ nope');
  const r = loadConfig(dir, path.join(root, 'config', 'config.default.json'));
  assert.ok(r.warnings.length > 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{ nope');
  assert.deepStrictEqual(r.config, DEFAULTS);
});
 
// ---- URL policy ----
const local = createUrlPolicy(parseText('{ "mode": "local" }').config);
test('the bundled app and blank pop-ups are app addresses', () => {
  assert.ok(local.isAppUrl('dsc://app/index.html#output'));
  assert.ok(local.isAppUrl('about:blank'));
  assert.ok(local.isAppUrl(''));
  assert.ok(!local.isAppUrl('dsc://other/index.html'));
  assert.ok(!local.isAppUrl('https://evil.example/'));
  assert.ok(!local.isAppUrl('file:///C:/secret.html'));
});
test('window.open: app pop-ups allowed, web links go to the browser, odd schemes denied', () => {
  assert.strictEqual(local.windowOpen('dsc://app/index.html#stage0'), 'allow');
  assert.strictEqual(local.windowOpen('https://songselect.ccli.com/'), 'external');
  assert.strictEqual(local.windowOpen('javascript:alert(1)'), 'deny');
  assert.strictEqual(local.windowOpen('file:///C:/Windows/System32/cmd.exe'), 'deny');
  const blocked = createUrlPolicy(parseText('{ "externalLinks": "block" }').config);
  assert.strictEqual(blocked.windowOpen('https://songselect.ccli.com/'), 'deny');
});
test('the main window cannot be navigated away from the app', () => {
  assert.strictEqual(local.navigate('dsc://app/index.html'), 'allow');
  assert.strictEqual(local.navigate('https://evil.example/'), 'external');
  assert.strictEqual(local.navigate('data:text/html,hi'), 'deny');
});
test('remote mode trusts only its own address', () => {
  const r = createUrlPolicy(parseText('{ "mode": "remote", "startUrl": "https://worship-chords-rho.vercel.app/p.html" }').config);
  assert.strictEqual(r.startUrl(), 'https://worship-chords-rho.vercel.app/p.html');
  assert.ok(r.isAppUrl('https://worship-chords-rho.vercel.app/p.html#output'));
  assert.ok(!r.isAppUrl('https://worship-chords-rho.vercel.app.evil.example/'));
  assert.strictEqual(r.localUrl(), 'dsc://app/index.html');
});
test('CORS headers are added only for hosts in the list', () => {
  assert.ok(local.needsCors('https://worship-chords-rho.vercel.app/api/firebase-config'));
  assert.ok(local.needsCors('https://bible-api.com/john+3:16'));
  assert.ok(!local.needsCors('https://www.youtube.com/embed/x'));
  assert.ok(!local.needsCors('dsc://app/index.html'));
  const wild = createUrlPolicy(parseText('{ "corsRelaxHosts": ["*.example.org"] }').config);
  assert.ok(wild.needsCors('https://api.example.org/x'));
  assert.ok(!wild.needsCors('https://example.org.evil.com/x'));
});
 
// ---- permissions ----
test('permissions follow the config and only for app pages', () => {
  const cfg = parseText('{ "mode": "local" }').config, pol = createUrlPolicy(cfg);
  assert.ok(isPermissionAllowed(cfg, pol, 'media', 'dsc://app/index.html'));
  assert.ok(isPermissionAllowed(cfg, pol, 'midi', 'dsc://app'));
  assert.ok(isPermissionAllowed(cfg, pol, 'window-placement', 'about:blank'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'geolocation', 'dsc://app/index.html'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'media', 'https://www.youtube.com/embed/x'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'openExternal', 'dsc://app/index.html'));
  const off = parseText('{ "mode": "local", "permissions": { "media": false } }').config;
  assert.ok(!isPermissionAllowed(off, createUrlPolicy(off), 'media', 'dsc://app/index.html'));
});
 
// ---- files ----
test('the app protocol cannot read outside the app folder', () => {
  const appDir = path.join(root, 'app');
  assert.strictEqual(resolveAppFile(appDir, '/'), path.join(appDir, 'index.html'));
  assert.strictEqual(resolveAppFile(appDir, '/../main.js'), null);
  assert.strictEqual(resolveAppFile(appDir, '/..%2Fmain.js'.replace('%2F', '/')), null);
  assert.strictEqual(resolveAppFile(appDir, '/a\0b'), null);
  assert.strictEqual(resolveAppFile(appDir, '/vendor/jszip.min.js', { 'vendor/jszip.min.js': '/x/jszip.js' }), '/x/jszip.js');
  assert.strictEqual(mimeFor('a.HTML'), 'text/html; charset=utf-8');
  assert.strictEqual(mimeFor('a.unknown'), 'application/octet-stream');
});
 
 
// ---- page updates ----
const { createUpdater, parseVersion, looksValid, cmp } = require('../lib/update');
const fakePage = v => '<!doctype html><html><head></head><body><script>const DSC_VERSION=\'' + v + '\',DSC_RELEASED=\'x\';</script>' + 'x'.repeat(120000) + '</body></html>\n';
const fakeFetch = (status, body, etag) => async () => ({ status, ok: status >= 200 && status < 300, headers: { get: () => etag || null }, text: async () => body });
function mkUpdater(bundledVer, fetchFn) {
  const dir = tmp(), b = path.join(dir, 'bundled.html');
  fs.writeFileSync(b, fakePage(bundledVer));
  return { dir, up: createUpdater({ dir, url: 'https://x.example/index.html', bundledFile: b, fetchFn }) };
}
test('versions are read and compared', () => {
  assert.deepStrictEqual(parseVersion(fakePage('1.2.3')), [1, 2, 3]);
  assert.strictEqual(cmp([1, 0, 10], [1, 0, 9]), 1);
  assert.strictEqual(cmp([1, 0, 0], [1, 0, 0]), 0);
  assert.strictEqual(cmp([0, 9, 9], [1, 0, 0]), -1);
});
test('only a whole, real page is accepted', () => {
  assert.ok(looksValid(fakePage('1.0.1')));
  assert.ok(!looksValid('<html>404 Not Found</html>'));
  assert.ok(!looksValid(fakePage('1.0.1').slice(0, 50000)));
  assert.ok(!looksValid(fakePage('1.0.1').replace(/DSC_VERSION/, 'OTHER')));
});
test('a newer hosted page is downloaded and used from the next start', async () => {
  const { dir, up } = mkUpdater('1.0.0', fakeFetch(200, fakePage('1.0.3'), '"abc"'));
  assert.strictEqual(up.current().fromCache, false);
  const r = await up.check();
  assert.deepStrictEqual([r.status, r.version], ['updated', '1.0.3']);
  assert.strictEqual(up.current().fromCache, false);           // not switched mid-session
  const again = createUpdater({ dir, url: 'x', bundledFile: path.join(dir, 'bundled.html'), fetchFn: fakeFetch(500, '') });
  assert.strictEqual(again.current().fromCache, true);         // next start uses it
  assert.strictEqual(again.current().version.join('.'), '1.0.3');
});
test('same or older hosted page changes nothing', async () => {
  const same = mkUpdater('1.0.2', fakeFetch(200, fakePage('1.0.2')));
  assert.strictEqual((await same.up.check()).status, 'current');
  assert.ok(!fs.existsSync(same.up.cacheFile));
  const older = mkUpdater('1.0.2', fakeFetch(200, fakePage('1.0.1')));
  assert.strictEqual((await older.up.check()).status, 'current');
});
test('offline, server errors and broken pages never break the app', async () => {
  const off = mkUpdater('1.0.0', async () => { throw new Error('offline'); });
  assert.strictEqual((await off.up.check()).status, 'offline');
  const bad = mkUpdater('1.0.0', fakeFetch(200, '<html>oops</html>'));
  assert.strictEqual((await bad.up.check()).status, 'invalid');
  assert.ok(!fs.existsSync(bad.up.cacheFile));
  const e500 = mkUpdater('1.0.0', fakeFetch(500, 'err'));
  assert.strictEqual((await e500.up.check()).status, 'offline');
});
test('a cached page older than the built-in one is ignored (after the app itself is updated)', async () => {
  const { dir, up } = mkUpdater('1.0.0', fakeFetch(200, fakePage('1.0.3')));
  await up.check();
  fs.writeFileSync(path.join(dir, 'bundled.html'), fakePage('1.1.0'));
  const next = createUpdater({ dir, url: 'x', bundledFile: path.join(dir, 'bundled.html'), fetchFn: fakeFetch(500, '') });
  assert.strictEqual(next.current().fromCache, false);
  assert.strictEqual(next.current().version.join('.'), '1.1.0');
});
test('a damaged cached page is ignored', () => {
  const { dir } = mkUpdater('1.0.0', fakeFetch(500, ''));
  fs.mkdirSync(path.join(dir, 'app-cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-cache', 'index.html'), '<html>half');
  const up = createUpdater({ dir, url: 'x', bundledFile: path.join(dir, 'bundled.html'), fetchFn: fakeFetch(500, '') });
  assert.strictEqual(up.current().fromCache, false);
});
test('the update address must be https', () => {
  const r = parseText('{ "update": { "enabled": true, "url": "http://evil.example/index.html" } }');
  assert.strictEqual(r.config.update.enabled, false);
  assert.ok(r.warnings.some(w => /update\.url/.test(w)));
});
 
// ---- program auto-update ----
test('program auto-update is off for portable and unpackaged runs', () => {
  assert.strictEqual(appUpdate.isInstalledBuild({ isPackaged: false }, {}), false);
  assert.strictEqual(appUpdate.isInstalledBuild({ isPackaged: true }, { PORTABLE_EXECUTABLE_DIR: 'C:\\x' }), false);
  assert.strictEqual(appUpdate.isInstalledBuild({ isPackaged: true }, {}), true);
  assert.strictEqual(appUpdate.start({ app: { isPackaged: false } }), null);
});
test('program auto-update downloads quietly, installs on close, and reports when ready', () => {
  const handlers = {};
  const fake = { autoUpdater: { on: (n, f) => { handlers[n] = f; }, checkForUpdates: () => Promise.resolve() } };
  let told = null;
  const u = appUpdate.start({ app: { isPackaged: true }, env: {}, updater: fake, delayMs: 1e9, everyMs: 1e9, notify: i => { told = i; } });
  assert.ok(u && typeof u.check === 'function');
  assert.strictEqual(fake.autoUpdater.autoDownload, true);
  assert.strictEqual(fake.autoUpdater.autoInstallOnAppQuit, true);
  handlers['update-downloaded']({ version: '9.9.9' });
  assert.deepStrictEqual(told, { version: '9.9.9' });
  handlers.error(new Error('offline')); // must not throw
});
test('auto-update is on by default and publishes to GitHub Releases', () => {
  assert.strictEqual(DEFAULTS.autoUpdate, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['electron-updater']);
  assert.strictEqual(pkg.build.publish[0].provider, 'github');
});

// ---- package sanity ----
test('every file the installer needs is present', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
  ['app/index.html', 'preload.js', 'config/config.default.json', 'build/icon.ico', 'build/icon.png'].forEach(f =>
    assert.ok(fs.existsSync(path.join(root, f)), f + ' is missing'));
  assert.ok(fs.statSync(path.join(root, 'build', 'icon.ico')).size > 5000);
  assert.ok(pkg.dependencies.jszip);
  assert.strictEqual(pkg.build.npmRebuild, false);
});
 
// ---- stream link bridge ----
const linkBridge = require('../lib/linkbridge');
function fakeIpc() {
  const h = {}, o = {};
  return { handle: (c, f) => { h[c] = f; }, on: (c, f) => { o[c] = f; }, call: (c, ...a) => h[c](...a), emit: (c, ...a) => o[c](...a) };
}
class FakeWS {
  constructor(u) { this.url = u; this.readyState = 0; this.sent = []; this.l = {}; FakeWS.last = this; }
  addEventListener(t, f) { this.l[t] = f; }
  send(x) { this.sent.push(x); }
  close() { this.readyState = 3; }
  fire(t, ev) { if (t === 'open') this.readyState = 1; this.l[t] && this.l[t](ev || {}); }
}
test('the link bridge only opens ws://host/link addresses', () => {
  assert.ok(linkBridge.validUrl('ws://192.168.1.105:3000/link?role=remote&code=ABC'));
  assert.ok(linkBridge.validUrl('wss://stream.example.com/link?code=1'));
  assert.strictEqual(linkBridge.validUrl('http://192.168.1.105:3000/link'), null);
  assert.strictEqual(linkBridge.validUrl('ws://192.168.1.105:3000/other'), null);
  assert.strictEqual(linkBridge.validUrl('file:///etc/passwd'), null);
  assert.strictEqual(linkBridge.validUrl('nonsense'), null);
});
test('the link bridge opens, relays text both ways and closes', async () => {
  const ipc = fakeIpc(), got = [], sender = { id: 7, send: (c, m) => got.push(m), once() {}, isDestroyed: () => false };
  const b = linkBridge.create(ipc, FakeWS), e = { sender };
  assert.deepStrictEqual(await ipc.call('link:open', e, 'a', 'ws://192.168.1.105:3000/link?code=X'), { ok: true });
  FakeWS.last.fire('open');
  ipc.emit('link:send', e, 'a', '{"t":"slide"}');
  assert.deepStrictEqual(FakeWS.last.sent, ['{"t":"slide"}']);
  ipc.emit('link:send', e, 'a', { not: 'text' });
  assert.strictEqual(FakeWS.last.sent.length, 1);
  FakeWS.last.fire('close', { code: 4001 });
  assert.deepStrictEqual(got.map(m => m.type + (m.code || '')), ['open', 'close4001']);
  assert.strictEqual(b.count(), 0);
});
test('the link bridge refuses a bad address and a missing WebSocket', async () => {
  const ipc = fakeIpc(), e = { sender: { id: 1, send() {}, once() {} } };
  linkBridge.create(ipc, FakeWS);
  assert.strictEqual((await ipc.call('link:open', e, 'a', 'http://x/link')).ok, false);
  const ipc2 = fakeIpc(); linkBridge.create(ipc2, null);
  const saved = globalThis.WebSocket; globalThis.WebSocket = undefined;
  try { const ipc3 = fakeIpc(); linkBridge.create(ipc3); assert.strictEqual((await ipc3.call('link:open', e, 'a', 'ws://h:1/link')).ok, false); }
  finally { globalThis.WebSocket = saved; }
});

// ---- saving a service through the system Save window ----
const saveBridge = require('../lib/savebridge');
const bytes = (...a) => Uint8Array.from(a);
test('a save is written in pieces and only appears under its real name when complete', async () => {
  const d = tmp(), target = path.join(d, 'Sunday.dscservice'), fs_ = new saveBridge.FileSaver();
  const id = await fs_.begin(1, target);
  assert.ok(!fs.existsSync(target), 'nothing under the real name yet');
  await fs_.write(1, id, bytes(1, 2, 3)); await fs_.write(1, id, bytes(4, 5));
  const r = await fs_.end(1, id);
  assert.strictEqual(r.bytes, 5);
  assert.deepStrictEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(fs.readdirSync(d), ['Sunday.dscservice'], 'no leftover temporary file');
});
test('an empty save is refused and leaves no file at all', async () => {
  const d = tmp(), target = path.join(d, 'a.dscservice'), s_ = new saveBridge.FileSaver();
  const id = await s_.begin(1, target);
  await assert.rejects(() => s_.end(1, id), /Nothing was written/);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});
test('cancelling a save keeps an older file of the same name untouched', async () => {
  const d = tmp(), target = path.join(d, 'a.dscservice'), s_ = new saveBridge.FileSaver();
  fs.writeFileSync(target, 'OLD');
  const id = await s_.begin(1, target);
  await s_.write(1, id, bytes(9, 9, 9));
  await s_.abort(1, id);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
  assert.deepStrictEqual(fs.readdirSync(d), ['a.dscservice']);
});
test('a finished save replaces an older file of the same name', async () => {
  const d = tmp(), target = path.join(d, 'a.dscservice'), s_ = new saveBridge.FileSaver();
  fs.writeFileSync(target, 'OLD OLD OLD OLD');
  const id = await s_.begin(1, target); await s_.write(1, id, bytes(65, 66)); await s_.end(1, id);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'AB');
});
test('one window cannot write into another window\'s save', async () => {
  const d = tmp(), s_ = new saveBridge.FileSaver();
  const id = await s_.begin(1, path.join(d, 'a.dscservice'));
  await assert.rejects(() => s_.write(2, id, bytes(1)), /not open/);
  await s_.abortOwner(1);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});
test('only real byte data is accepted', async () => {
  const d = tmp(), s_ = new saveBridge.FileSaver();
  const id = await s_.begin(1, path.join(d, 'a.dscservice'));
  await assert.rejects(() => s_.write(1, id, 'text'), /Nothing to write/);
  await assert.rejects(() => s_.write(1, id, { length: 3 }), /Nothing to write/);
  await s_.abort(1, id);
});
test('the save bridge: begin, write, end, and it remembers the folder', async () => {
  const ipc = fakeIpc(), d = tmp(), dest = path.join(d, 'out'); fs.mkdirSync(dest);
  let asked = null;
  saveBridge.create(ipc, { dir: d, documents: d, showSaveDialog: async (_s, o) => { asked = o; return { canceled: false, filePath: path.join(dest, 'Service.dscservice') }; }, showOpenDialog: async () => ({ canceled: true }) });
  const e = { sender: { id: 5, once() {} } };
  const b = await ipc.call('save:begin', e, { name: 'Sunday: 12/Oct?.dscservice', title: 'Save service' });
  assert.strictEqual(b.ok, true);
  assert.ok(!/[\\/:?]/.test(path.basename(asked.defaultPath)), 'the suggested name is a safe file name');
  assert.strictEqual(asked.filters[0].extensions[0], 'dscservice');
  assert.deepStrictEqual(await ipc.call('save:write', e, b.id, bytes(1, 2, 3, 4)), { ok: true });
  const r = await ipc.call('save:end', e, b.id);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.bytes, 4); assert.strictEqual(r.name, 'Service.dscservice'); assert.strictEqual(r.dir, dest);
  await ipc.call('save:begin', e, { name: 'Next.dscservice' });
  assert.strictEqual(path.dirname(asked.defaultPath), dest, 'the Save window opens in the folder used last time');
});
test('the save bridge: closing the Save window is not an error, a bad folder is reported', async () => {
  const d = tmp(), e = { sender: { id: 5, once() {} } };
  const ipc = fakeIpc();
  saveBridge.create(ipc, { dir: d, documents: d, showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) });
  assert.deepStrictEqual(await ipc.call('save:begin', e, { name: 'a.dscservice' }), { canceled: true });
  const ipc2 = fakeIpc();
  saveBridge.create(ipc2, { dir: d, documents: d, showSaveDialog: async () => ({ canceled: false, filePath: path.join(d, 'no-such-folder', 'a.dscservice') }), showOpenDialog: async () => ({ canceled: true }) });
  const r = await ipc2.call('save:begin', e, { name: 'a.dscservice' });
  assert.strictEqual(r.ok, false); assert.ok(r.error);
});
test('a service saved without the zip library gets a .json name and filter', async () => {
  const d = tmp(), e = { sender: { id: 5, once() {} } }, ipc = fakeIpc(); let asked;
  saveBridge.create(ipc, { dir: d, documents: d, showSaveDialog: async (_s, o) => { asked = o; return { canceled: true }; }, showOpenDialog: async () => ({ canceled: true }) });
  await ipc.call('save:begin', e, { name: 'Sunday.json' });
  assert.strictEqual(asked.filters[0].extensions[0], 'json');
});
test('choosing a service folder is remembered and used', async () => {
  const d = tmp(), pick = path.join(d, 'Services'); fs.mkdirSync(pick);
  const e = { sender: { id: 5, once() {} } }, ipc = fakeIpc(); let asked;
  const b = saveBridge.create(ipc, { dir: d, documents: d, showSaveDialog: async (_s, o) => { asked = o; return { canceled: true }; }, showOpenDialog: async () => ({ canceled: false, filePaths: [pick] }) });
  const f = await ipc.call('save:folder', e);
  assert.strictEqual(f.ok, true); assert.strictEqual(f.name, 'Services');
  assert.strictEqual(b.remembered(), pick);
  await ipc.call('save:begin', e, { name: 'a.dscservice' });
  assert.strictEqual(path.dirname(asked.defaultPath), pick);
});
test('file names are made safe', () => {
  assert.strictEqual(saveBridge.safeName('a/b\\c:d?.dscservice', 'x'), 'a-b-c-d-.dscservice');
  assert.strictEqual(saveBridge.safeName('', 'fallback.dscservice'), 'fallback.dscservice');
  assert.strictEqual(saveBridge.safeName('..', 'f'), 'f');
});
test('the app allows the file window by default (a saved service needs it)', () => {
  assert.strictEqual(DEFAULTS.permissions.fileSystem, true);
  const cfg = parseText('{}').config;
  assert.ok(isPermissionAllowed(cfg, createUrlPolicy(cfg), 'fileSystem', cfg.startUrl));
  assert.ok(!isPermissionAllowed(cfg, createUrlPolicy(cfg), 'fileSystem', 'https://evil.example/'));
});
test('the preload offers the save window to the page', () => {
  const src = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  ['save:begin', 'save:write', 'save:end', 'save:abort', 'save:folder'].forEach(c => assert.ok(src.includes("'" + c + "'"), c));
  assert.ok(fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes("require('./lib/savebridge')"));
});

// ---- Wi-Fi remote (lib/lanserver.js) ----
const lan = require('../lib/lanserver');
const http = require('http');
const crypto = require('crypto');
function wsClient(port, pin) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: '/ws?pin=' + pin, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('response', res => { res.resume(); reject(new Error('HTTP ' + res.statusCode)); });
    req.on('upgrade', (res, socket, head) => {
      const msgs = []; let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          if ((buf[0] & 0x0f) === 1) msgs.push(JSON.parse(buf.subarray(off, off + len).toString()));
          buf = buf.subarray(off + len);
        }
      };
      socket.on('data', onData);
      if (head && head.length) onData(head);
      const send = text => {
        const pay = Buffer.from(text), mask = crypto.randomBytes(4);
        let head;
        if (pay.length < 126) head = Buffer.from([0x81, 0x80 | pay.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(pay.length, 2); }
        const body = Buffer.from(pay); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        socket.write(Buffer.concat([head, mask, body]));
      };
      resolve({ msgs, send, socket });
    });
    req.on('error', reject);
    req.end();
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
test('Wi-Fi remote: a phone with the right PIN gets the state and its button presses reach the app', async () => {
  const got = [], counts = [];
  const srv = lan.create({ pin: '123456', port: 0, pageFile: path.join(root, 'lan', 'remote.html'), onCommand: c => got.push(c), onClients: n => counts.push(n) });
  const port = await srv.start();
  try {
    srv.setState({ title: 'Song', idx: 2 });
    const c = await wsClient(port, '123456');
    await wait(80);
    assert.strictEqual(c.msgs[0].t, 'hello');
    assert.deepStrictEqual(c.msgs[1], { t: 'state', d: { title: 'Song', idx: 2 } });
    srv.setState({ title: 'Song', idx: 3 });
    await wait(80);
    assert.strictEqual(c.msgs[c.msgs.length - 1].d.idx, 3);
    c.send(JSON.stringify({ t: 'cmd', c: { t: 'next' } }));
    c.send(JSON.stringify({ t: 'cmd', c: { t: 'x'.repeat(40) } }));   // too long: ignored
    c.send('not json');
    await wait(80);
    assert.deepStrictEqual(got, [{ t: 'next' }]);
    assert.strictEqual(srv.count(), 1);
    c.socket.destroy(); await wait(80);
    assert.strictEqual(srv.count(), 0);
    assert.ok(counts.includes(1) && counts[counts.length - 1] === 0);
  } finally { srv.stop(); }
});
test('Wi-Fi remote: a remote.html in the data folder replaces the built-in page without a restart', async () => {
  const fs = require('fs'), os = require('os'), http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanpage-')), custom = path.join(dir, 'remote.html');
  const srv = lan.create({ pin: '222222', port: 0, pageFile: () => fs.existsSync(custom) ? custom : path.join(root, 'lan', 'remote.html') });
  const port = await srv.start();
  const get = () => new Promise((ok, no) => http.get({ host: '127.0.0.1', port, path: '/' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => ok(b)); }).on('error', no));
  try {
    assert.ok((await get()).includes('rmtOv'));            // built-in page
    fs.writeFileSync(custom, '<!doctype html><title>custom</title>');
    assert.strictEqual(await get(), '<!doctype html><title>custom</title>');   // picked up at once
    fs.unlinkSync(custom);
    assert.ok((await get()).includes('rmtOv'));            // back to the built-in page
  } finally { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Phone page: rebuilt from Harmony, kept when the download is bad, and only rewritten when it changes', async () => {
  const fs = require('fs'), os = require('os'), lanPage = require(path.join(root, 'lib', 'lanpage'));
  const tpl = fs.readFileSync(path.join(root, 'lan', 'template.html'), 'utf8');
  const fake = (css, js) => '<!doctype html><html><head><style id="remoteCss">' + css + '</style></head><body>' + 'x'.repeat(60 * 1024) + '<script id="remoteJs">' + js + '</script></body></html>';
  const good = fake('.a{color:red}', "var o='rmtOv';var d=window.firestoreDb;'Could not send. Check your connection.'");
  const out = lanPage.convert(good, tpl);
  assert.ok(out.includes('.a{color:red}') && out.includes('Check the Wi-Fi.') && !out.includes('Check your connection.') && out.includes('PreCenter Remote'));
  assert.throws(() => lanPage.convert('<html>nope</html>', tpl));
  assert.throws(() => lanPage.convert(fake('a{}', 'var nothing=1'), tpl));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanauto-'));
  let body = good, status = 200;
  const up = lanPage.create({ dir, templateFile: path.join(root, 'lan', 'template.html'), url: 'https://example.test/', fetchFn: async () => ({ ok: status === 200, status, text: async () => body }) });
  try {
    assert.strictEqual((await up.check()).status, 'updated');
    assert.ok(fs.readFileSync(up.autoFile, 'utf8').includes('.a{color:red}'));
    assert.strictEqual((await up.check()).status, 'current');
    body = fake('.b{color:blue}', "var o='rmtOv';var d=window.firestoreDb;");
    assert.strictEqual((await up.check()).status, 'updated');
    assert.ok(fs.readFileSync(up.autoFile, 'utf8').includes('.b{color:blue}'));
    body = '<html>Error page</html>';
    assert.strictEqual((await up.check()).status, 'invalid');
    assert.ok(fs.readFileSync(up.autoFile, 'utf8').includes('.b{color:blue}'));   // the good copy stays
    status = 500;
    assert.strictEqual((await up.check()).status, 'offline');
    assert.ok(up.info().auto);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Wi-Fi remote: a wrong PIN is refused, and too many wrong tries are blocked', async () => {
  const srv = lan.create({ pin: '654321', port: 0, pageFile: 'x' });
  const port = await srv.start();
  try {
    for (let i = 0; i < 8; i++) await assert.rejects(wsClient(port, '000000'), /401/);
    await assert.rejects(wsClient(port, '654321'), /401/);   // blocked for a minute even with the right PIN
  } finally { srv.stop(); }
});
test('Wi-Fi remote: new PIN disconnects paired phones; the page and /ping are served', async () => {
  const srv = lan.create({ pin: '111111', port: 0, pageFile: path.join(root, 'lan', 'remote.html') });
  const port = await srv.start();
  try {
    const c = await wsClient(port, '111111'); await wait(50);
    const np = srv.newPin(); await wait(80);
    assert.ok(/^\d{6}$/.test(np) && np !== '111111');
    assert.strictEqual(srv.count(), 0);
    const get = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b })); }).on('error', rej));
    assert.strictEqual((await get('/ping')).body, 'ok');
    assert.strictEqual((await get('/nothing')).code, 404);
    assert.strictEqual((await get('/')).code, 200);
    assert.ok(srv.info().urls.every(u => u.url.includes('pin=' + np)));
  } finally { srv.stop(); }
});
test('Wi-Fi remote: home-network addresses come first, loopback and link-local are skipped', () => {
  const l = lan.lanAddresses({ 'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }], 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.175', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth: [{ family: 'IPv4', address: '169.254.3.3', internal: false }] });
  assert.deepStrictEqual(l.map(x => x.address), ['192.168.1.175', '172.20.0.1']);
});
test('Wi-Fi remote is on by default and the app wires it up', () => {
  assert.strictEqual(DEFAULTS.lan.enabled, true);
  assert.strictEqual(parseText('{ "lan": { "enabled": false } }').config.lan.enabled, false);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8'), pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  ["lan:info", "lan:state", "lan:newPin", "lan:cmd"].forEach(c => { assert.ok(main.includes("'" + c + "'"), 'main ' + c); assert.ok(pre.includes("'" + c + "'"), 'preload ' + c); });
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('PASS ' + name); }
    catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join(' | ')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
