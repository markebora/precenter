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

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
}
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
const local = createUrlPolicy(parseText('{}').config);
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
  const cfg = parseText('{}').config, pol = createUrlPolicy(cfg);
  assert.ok(isPermissionAllowed(cfg, pol, 'media', 'dsc://app/index.html'));
  assert.ok(isPermissionAllowed(cfg, pol, 'midi', 'dsc://app'));
  assert.ok(isPermissionAllowed(cfg, pol, 'window-placement', 'about:blank'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'geolocation', 'dsc://app/index.html'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'media', 'https://www.youtube.com/embed/x'));
  assert.ok(!isPermissionAllowed(cfg, pol, 'openExternal', 'dsc://app/index.html'));
  const off = parseText('{ "permissions": { "media": false } }').config;
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
