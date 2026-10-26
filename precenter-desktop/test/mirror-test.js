'use strict';
// Run: node test/mirror-test.js
const http = require('http');
const path = require('path');
const assert = require('assert');
const mirror = require('../lib/mirror');

function open(port, code) {
  return new Promise((ok, no) => {
    const req = http.get({ port, path: '/events?code=' + code }, res => {
      const got = []; let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); if (b.startsWith('data: ')) got.push(JSON.parse(b.slice(6))); } });
      ok({ res, got, close: () => req.destroy() });
    });
    req.on('error', no);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function status(port, p) { return new Promise(ok => http.get({ port, path: p }, r => { r.resume(); ok(r.statusCode); })); }

(async () => {
  const s = await mirror.start({ appHtml: path.join(__dirname, '..', 'app', 'index.html'), port: 0 });
  assert.strictEqual(await status(s.port, '/events?code=000000'), 403, 'wrong code refused');
  assert.strictEqual(await status(s.port, '/'), 200, 'page served');
  assert.strictEqual(await status(s.port, '/other'), 404);

  assert.strictEqual(s.publish(JSON.stringify({ d: {}, text: 'before join' })), true);
  const a = await open(s.port, s.code); await wait(100);
  assert.deepStrictEqual(a.got.map(x => x.text), ['before join'], 'late joiner gets the current slide');

  const b = await open(s.port, s.code); await wait(50);
  s.publish(JSON.stringify({ d: {}, text: 'line1\nline2 "quoted"' })); await wait(100);
  assert.strictEqual(a.got[1].text, 'line1\nline2 "quoted"', 'newlines inside text survive');
  assert.strictEqual(b.got[b.got.length - 1].text, 'line1\nline2 "quoted"', 'every viewer gets it');
  assert.strictEqual(s.viewerCount(), 2);
  assert.strictEqual(s.publish('x'.repeat(9 * 1024 * 1024)), false, 'oversized refused');
  assert.strictEqual(s.publish(123), false);

  a.close(); b.close(); await wait(100);
  assert.strictEqual(s.viewerCount(), 0, 'closed viewers are dropped');
  s.stop();
  console.log('mirror: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
