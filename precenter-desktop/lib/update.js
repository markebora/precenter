'use strict';
// Keeps the built-in copy of the page (index.html) up to date from your hosted site.
// The newest page lives in <userData>/app-cache/. It is only used when its version is higher than
// the one built into the app, and a new download is only applied the next time the app starts
// (so a service is never interrupted). If anything goes wrong the built-in copy is used.
const fs = require('fs');
const path = require('path');

const VER_RE = /const\s+DSC_VERSION\s*=\s*'(\d+)\.(\d+)\.(\d+)'/;
const MIN_BYTES = 100 * 1024;
const MAX_BYTES = 30 * 1024 * 1024;

function parseVersion(html) {
  const m = VER_RE.exec(String(html || ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
function verText(v) { return v ? v.join('.') : ''; }
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
// A real page, not an error message or a half-finished download.
function looksValid(html) {
  return typeof html === 'string' && html.length >= MIN_BYTES && html.length <= MAX_BYTES &&
    /<html[\s>]/i.test(html) && /<\/html>\s*$/i.test(html) && parseVersion(html) !== null;
}

function createUpdater(opts) {
  const dir = path.join(opts.dir, 'app-cache');
  const cacheFile = path.join(dir, 'index.html');
  const metaFile = path.join(dir, 'meta.json');
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const fetchFn = opts.fetchFn;
  const url = opts.url;

  const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
  const bundledVersion = parseVersion(readText(opts.bundledFile)) || [0, 0, 0];

  let current = { file: null, version: bundledVersion, fromCache: false };

  // Decide which copy to run: the cached one only if it is valid and newer than the built-in one.
  function refresh() {
    current = { file: null, version: bundledVersion, fromCache: false };
    const t = readText(cacheFile);
    if (t && looksValid(t)) {
      const v = parseVersion(t);
      if (cmp(v, bundledVersion) > 0) current = { file: cacheFile, version: v, fromCache: true };
    }
    return current;
  }
  refresh();

  function readMeta() { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) { return {}; } }

  // Looks at the hosted page. Never throws. Returns { status, version }:
  //   'updated' (downloaded, applies on next start), 'current', 'offline', 'invalid'
  async function check() {
    try {
      const meta = readMeta();
      const headers = { 'cache-control': 'no-cache' };
      if (meta.etag && current.fromCache) headers['if-none-match'] = meta.etag;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
      let res;
      try { res = await fetchFn(url, { headers, signal: ctl ? ctl.signal : undefined }); }
      finally { if (timer) clearTimeout(timer); }
      if (res.status === 304) return { status: 'current', version: verText(current.version) };
      if (!res.ok) { log.warn('Page update check: server answered ' + res.status); return { status: 'offline', version: verText(current.version) }; }
      const text = await res.text();
      if (!looksValid(text)) { log.warn('Page update check: the downloaded page did not look right and was ignored.'); return { status: 'invalid', version: verText(current.version) }; }
      const v = parseVersion(text);
      if (cmp(v, current.version) <= 0) return { status: 'current', version: verText(current.version) };
      fs.mkdirSync(dir, { recursive: true });
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, cacheFile);
      fs.writeFileSync(metaFile, JSON.stringify({ etag: res.headers && res.headers.get ? res.headers.get('etag') : null, version: verText(v), savedAt: new Date().toISOString() }));
      log.info('Page update downloaded: ' + verText(v));
      return { status: 'updated', version: verText(v) };
    } catch (e) {
      log.warn('Page update check failed: ' + (e && e.message));
      return { status: 'offline', version: verText(current.version) };
    }
  }

  return { check, refresh, current: () => current, cacheFile, bundledVersion: () => verText(bundledVersion) };
}

module.exports = { createUpdater, parseVersion, looksValid, cmp };
