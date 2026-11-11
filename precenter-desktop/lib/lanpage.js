'use strict';
// Keeps the phone page (the remote shown when a phone connects over Wi-Fi) in step with Disciples: Harmony.
// The remote screen lives in Harmony's index.html (style#remoteCss and script#remoteJs). This module downloads
// that page from your site, wraps the remote in lan/template.html (the Wi-Fi connection code) and saves the result
// in <userData>/lan/remote.auto.html. A broken or half-finished download is never used.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 30 * 1024 * 1024;
const REPLACE = [   // Harmony's wording talks about Firestore; over Wi-Fi the only way to be blocked is a wrong PIN
  ['Blocked by Firestore rules (publish the new firestore.rules)', 'PIN not accepted. Scan the QR code again.'],
  ['Remote is blocked by Firestore. Publish the new firestore.rules.', 'PIN not accepted. Scan the QR code again.'],
  ['Could not send. Check your connection.', 'Could not send. Check the Wi-Fi.']
];

function between(html, openRe, close) {
  const m = openRe.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length, end = html.indexOf(close, start);
  return end < 0 ? null : html.slice(start, end);
}

// Harmony index.html text -> the phone page text. Throws a plain-English Error if Harmony does not look right.
function convert(harmonyHtml, template) {
  if (typeof harmonyHtml !== 'string' || harmonyHtml.length < 50 * 1024 || harmonyHtml.length > MAX_BYTES) throw new Error('that is not the Harmony page');
  const css = between(harmonyHtml, /<style id="remoteCss">/, '</style>');
  let js = between(harmonyHtml, /<script id="remoteJs">/, '</script>');
  if (css === null || js === null) throw new Error('the remote screen was not found in that page');
  if (!/rmtOv/.test(js) || !/firestoreDb/.test(js)) throw new Error('the remote screen looks different from what this app expects');
  for (const [a, b] of REPLACE) js = js.split(a).join(b);
  if (typeof template !== 'string' || !template.includes('/*__CSS__*/') || !template.includes('/*__JS__*/')) throw new Error('the page template is missing');
  return template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
}

function create(opts) {
  const dir = path.join(opts.dir, 'lan');
  const autoFile = path.join(dir, 'remote.auto.html');
  const metaFile = path.join(dir, 'remote.auto.json');
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const fetchFn = opts.fetchFn;
  const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
  const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch (e) { return {}; } };
  let busy = false, lastStatus = '';

  function template() { return readText(opts.templateFile); }
  function write(file, text) { const tmp = file + '.tmp'; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

  // Downloads Harmony and rebuilds the phone page. Never throws. Returns { status, message }:
  //   'updated', 'current', 'offline', 'invalid'
  async function check() {
    if (busy) return { status: 'busy', message: 'Already checking.' };
    busy = true;
    try {
      const meta = readMeta();
      let res;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
      try { res = await fetchFn(opts.url, { headers: { 'cache-control': 'no-cache' }, signal: ctl ? ctl.signal : undefined }); }
      catch (e) { return lastStatus = { status: 'offline', message: 'Could not reach ' + opts.url }; }
      finally { if (t) clearTimeout(t); }
      if (!res || !res.ok) return lastStatus = { status: 'offline', message: 'The site answered ' + (res ? res.status : 'nothing') };
      const html = await res.text();
      let page;
      try { page = convert(html, template()); } catch (e) { log.warn('Phone page not updated: ' + e.message); return lastStatus = { status: 'invalid', message: 'Not updated: ' + e.message }; }
      const hash = require('crypto').createHash('sha256').update(page).digest('hex');
      if (hash === meta.hash && fs.existsSync(autoFile)) { write(metaFile, JSON.stringify(Object.assign(meta, { checked: Date.now() }))); return lastStatus = { status: 'current', message: 'The phone page is already the latest.' }; }
      write(autoFile, page);
      write(metaFile, JSON.stringify({ hash, at: Date.now(), checked: Date.now(), from: opts.url, bytes: page.length }));
      log.info('Phone page updated from ' + opts.url);
      return lastStatus = { status: 'updated', message: 'The phone page was updated. Phones get it the next time they open the Wi-Fi page.' };
    } catch (e) {
      log.error('Phone page update failed: ' + e.message);
      return lastStatus = { status: 'offline', message: e.message };
    } finally { busy = false; }
  }

  function info() {
    const meta = readMeta();
    return { auto: fs.existsSync(autoFile), at: meta.at || 0, from: meta.from || '', last: lastStatus || null };
  }
  return { check, info, autoFile };
}

module.exports = { convert, create };
