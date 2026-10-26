'use strict';
// Live mirror. Serves the app page plus a Server-Sent-Events stream on the local network, so other
// devices (phones, tablets, laptops) can show the audience screen (#view) or only its text (#view&mode=text).
// No extra packages: only Node's http. Viewers must know the pairing code; the page itself holds no secrets.

const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const MAX_MESSAGE = 8 * 1024 * 1024; // one slide, with its look; media files are not sent
const MAX_VIEWERS = 30;
const MAX_FILE = 150 * 1024 * 1024;   // one library picture or video
const MAX_TOTAL = 400 * 1024 * 1024;  // all media together (kept in memory while sharing)

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// opts: { appHtml: path to the page, port, code }
function start(opts) {
  const code = opts.code || String(crypto.randomInt(100000, 1000000));
  const viewers = new Set();
  const blobs = new Map(); // library file name -> { type, data }
  let total = 0;
  let last = '';

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return fs.readFile(opts.appHtml, (err, data) => {
        if (err) { res.writeHead(500); return res.end('Error'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(data);
      });
    }
    if (u.pathname === '/events') {
      if (!same(u.searchParams.get('code') || '', code)) { res.writeHead(403); return res.end('Wrong code'); }
      if (viewers.size >= MAX_VIEWERS) { res.writeHead(503); return res.end('Too many viewers'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (last) res.write('data: ' + last + '\n\n'); // someone joining late sees the current slide at once
      viewers.add(res);
      req.on('close', () => viewers.delete(res));
      return;
    }
    if (u.pathname.startsWith('/blob/')) return sendBlob(req, res, u);
    res.writeHead(404); res.end('Not found');
  });

  // Library pictures and videos, served with Range support so videos can start and seek.
  function sendBlob(req, res, u) {
    if (!same(u.searchParams.get('code') || '', code)) { res.writeHead(403); return res.end('Wrong code'); }
    let name; try { name = decodeURIComponent(u.pathname.slice(6)); } catch (e) { res.writeHead(400); return res.end(); }
    const b = blobs.get(name);
    if (!b) { res.writeHead(404); return res.end('Not found'); }
    const size = b.data.length;
    const h = { 'content-type': b.type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let s, e;
      if (m[1] === '') { s = Math.max(0, size - Number(m[2])); e = size - 1; }
      else { s = Number(m[1]); e = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (s > e || s >= size) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
      res.writeHead(206, Object.assign(h, { 'content-range': 'bytes ' + s + '-' + e + '/' + size, 'content-length': e - s + 1 }));
      return res.end(b.data.subarray(s, e + 1));
    }
    res.writeHead(200, Object.assign(h, { 'content-length': size }));
    res.end(b.data);
  }

  function putBlob(name, type, data) {
    name = String(name || '').slice(0, 300);
    if (!name) return false;
    if (!Buffer.isBuffer(data)) { try { data = Buffer.from(data); } catch (e) { return false; } }
    if (data.length > MAX_FILE) return false;
    const old = blobs.get(name);
    const next = total - (old ? old.data.length : 0) + data.length;
    if (next > MAX_TOTAL) return false;
    const t = String(type || '');
    blobs.set(name, { type: /^(image|video|audio)\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream', data });
    total = next;
    return true;
  }

  const beat = setInterval(() => { for (const v of viewers) { try { v.write(': ping\n\n'); } catch (e) { /* gone */ } } }, 15000);
  if (beat.unref) beat.unref();

  function publish(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_MESSAGE) return false;
    last = text.replace(/[\r\n]+/g, ' '); // JSON.stringify never makes raw newlines; this keeps the stream safe anyway
    for (const v of viewers) { try { v.write('data: ' + last + '\n\n'); } catch (e) { viewers.delete(v); } }
    return true;
  }

  function stop() {
    clearInterval(beat);
    for (const v of viewers) { try { v.end(); } catch (e) { /* gone */ } }
    viewers.clear();
    blobs.clear(); total = 0;
    try { server.close(); } catch (e) { /* closed */ }
  }

  function listen(port) {
    return new Promise((ok, no) => {
      server.once('error', no);
      server.listen(port, '0.0.0.0', () => { server.removeListener('error', no); ok(server.address().port); });
    });
  }

  return listen(opts.port || 0)
    .catch(e => (e && e.code === 'EADDRINUSE' ? listen(0) : Promise.reject(e)))
    .then(port => ({ port, code, addresses: lanAddresses(), publish, putBlob, stop, viewerCount: () => viewers.size }));
}

module.exports = { start, lanAddresses };
