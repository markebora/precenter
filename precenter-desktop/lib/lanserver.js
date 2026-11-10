'use strict';
// Wi-Fi remote server. Phones on the same network open http://<this computer>:<port>/?pin=123456 (the QR code
// holds that address). The page that opens is the phone remote; it talks to this file over a WebSocket at /ws.
// Nothing goes through the internet. Only Node's own modules are used (no extra packages).
//
//   host side (the app):  start(), stop(), setState(obj), info(), newPin()
//   phone side:           GET /  -> remote page,  GET /ping -> ok,  WebSocket /ws?pin=...
//   messages to a phone:  {t:'state', d:<what PreCenter shows>}
//   messages from a phone: {t:'cmd', c:{t:'next'|'prev'|'go'|...}}   (handed to onCommand)

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024;        // a phone only sends small button presses
const MAX_CLIENTS = 12;
const MAX_BUFFER = 8 * 1024 * 1024; // drop a phone that cannot keep up

function newPinValue() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// IPv4 addresses of this computer that a phone could reach, home networks first.
function lanAddresses(ifaces) {
  const out = [];
  const all = ifaces || os.networkInterfaces();
  for (const name of Object.keys(all)) {
    for (const a of all[name] || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address)) continue;
      const rank = /^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      const virt = /virtual|vethernet|vmware|vbox|wsl|docker|hyper-v|loopback|tailscale|zerotier/i.test(name) ? 10 : 0;
      out.push({ address: a.address, name, rank: rank + virt });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(x => ({ address: x.address, name: x.name }));
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// options: { pin, port, pageFile, onCommand(cmd), onClients(count), dir (folder to remember the PIN in) }
function create(opt) {
  opt = opt || {};
  let pin = opt.pin || '';
  let server = null, port = 0, lastState = null, timer = null;
  const clients = new Set();
  const fails = new Map(); // ip -> { n, t }

  if (!pin && opt.dir) {
    try { const j = JSON.parse(fs.readFileSync(path.join(opt.dir, 'lan.json'), 'utf8')); if (/^\d{6}$/.test(j.pin)) pin = j.pin; } catch (e) { /* first run */ }
  }
  if (!pin) pin = newPinValue();
  const savePin = () => { if (opt.dir) { try { fs.mkdirSync(opt.dir, { recursive: true }); fs.writeFileSync(path.join(opt.dir, 'lan.json'), JSON.stringify({ pin })); } catch (e) { /* not fatal */ } } };
  savePin();

  const count = () => clients.size;
  const tell = () => { try { if (opt.onClients) opt.onClients(count()); } catch (e) { /* page gone */ } };

  function pinOk(given, ip) {
    const f = fails.get(ip);
    if (f && f.n >= 8 && Date.now() - f.t < 60000) return false;
    const a = Buffer.from(String(given || '')), b = Buffer.from(pin);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) fails.delete(ip);
    else fails.set(ip, { n: (f && Date.now() - f.t < 60000 ? f.n : 0) + 1, t: Date.now() });
    return ok;
  }

  function send(c, text) {
    if (c.dead) return;
    try {
      if (c.socket.writableLength > MAX_BUFFER) { drop(c); return; }
      c.socket.write(frame(1, Buffer.from(text)));
    } catch (e) { drop(c); }
  }

  function drop(c) {
    if (c.dead) return;
    c.dead = true;
    clients.delete(c);
    try { c.socket.destroy(); } catch (e) { /* gone */ }
    tell();
  }

  function onFrame(c, op, data) {
    if (op === 8) { try { c.socket.write(frame(8, Buffer.alloc(0))); } catch (e) { /* gone */ } drop(c); return; }
    if (op === 9) { try { c.socket.write(frame(10, data)); } catch (e) { /* gone */ } return; }
    if (op === 10) { c.alive = true; return; }
    if (op !== 1) return;
    c.alive = true;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hb') { send(c, '{"t":"hb"}'); return; }
    if (m.t === 'cmd' && m.c && typeof m.c === 'object' && typeof m.c.t === 'string' && m.c.t.length < 24) {
      try { if (opt.onCommand) opt.onCommand(m.c); } catch (e) { /* the app handles its own errors */ }
    }
  }

  function upgrade(req, socket) {
    const ip = req.socket.remoteAddress || '';
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (u.pathname !== '/ws' || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (!pinOk(u.searchParams.get('pin'), ip)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    if (clients.size >= MAX_CLIENTS) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    const c = { socket, buf: Buffer.alloc(0), alive: true, dead: false, frag: null };
    clients.add(c);
    socket.on('data', chunk => {
      c.buf = Buffer.concat([c.buf, chunk]);
      for (;;) {
        const b = c.buf;
        if (b.length < 2) return;
        const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) { drop(c); return; } len = Number(big); off = 10; }
        if (len > MAX_FRAME || !masked) { drop(c); return; }   // browsers always mask
        if (b.length < off + 4 + len) return;
        const mask = b.subarray(off, off + 4);
        const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        c.buf = b.subarray(off + 4 + len);
        if (op === 0) { if (!c.frag) { drop(c); return; } c.frag.parts.push(data); if (fin) { const all = Buffer.concat(c.frag.parts); const o = c.frag.op; c.frag = null; onFrame(c, o, all); } }
        else if (!fin && (op === 1 || op === 2)) c.frag = { op, parts: [data] };
        else onFrame(c, op, data);
        if (c.dead) return;
      }
    });
    socket.on('end', () => drop(c));    // http servers keep half-open sockets: a phone that closed must be dropped now
    socket.on('close', () => drop(c));
    socket.on('error', () => drop(c));
    send(c, JSON.stringify({ t: 'hello', ok: true }));
    if (lastState) send(c, lastState);
    tell();
  }

  // Backgrounds for the phone (short clips and pictures PreCenter makes), kept in memory and served to phones on this Wi-Fi.
  const media = new Map(); let mediaBytes = 0;
  const MEDIA_MAX = 256 * 1024 * 1024;
  const MEDIA_TYPES = { mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  function putMedia(key, buf, type) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._\-\/]{1,160}$/.test(key) || key.includes('..') || !Buffer.isBuffer(buf) || !buf.length || buf.length > 120 * 1024 * 1024) return false;
    const old = media.get(key); if (old) { mediaBytes -= old.buf.length; media.delete(key); }
    media.set(key, { buf, type: String(type || '') });
    mediaBytes += buf.length;
    for (const k of Array.from(media.keys())) { if (mediaBytes <= MEDIA_MAX || k === key) break; mediaBytes -= media.get(k).buf.length; media.delete(k); }   // oldest first
    return true;
  }
  function serveMedia(req, res, key, headers) {
    const m = media.get(key);
    if (!m) { res.writeHead(404, headers); res.end('Not found'); return; }
    const ext = key.split('.').pop().toLowerCase(), type = MEDIA_TYPES[ext] || m.type || 'application/octet-stream', n = m.buf.length;
    const h = Object.assign({}, headers, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=300' });
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (r && (r[1] || r[2])) {
      let a = r[1] === '' ? Math.max(0, n - parseInt(r[2], 10)) : parseInt(r[1], 10), b = (r[1] === '' || r[2] === '') ? n - 1 : Math.min(n - 1, parseInt(r[2], 10));
      if (a > b || a >= n) { res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + n }, headers)); res.end(); return; }
      res.writeHead(206, Object.assign({ 'Content-Range': 'bytes ' + a + '-' + b + '/' + n, 'Content-Length': b - a + 1 }, h));
      res.end(req.method === 'HEAD' ? undefined : m.buf.subarray(a, b + 1)); return;
    }
    res.writeHead(200, Object.assign({ 'Content-Length': n }, h));
    res.end(req.method === 'HEAD' ? undefined : m.buf);
  }

  function handle(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (u.pathname === '/ping') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }, headers)); res.end('ok'); return; }
    if (u.pathname === '/' || u.pathname === '/remote') {
      let html = '';
      try { html = fs.readFileSync(opt.pageFile, 'utf8'); } catch (e) { html = '<!doctype html><meta charset=utf-8><title>Remote</title><p style="font:16px sans-serif;padding:24px">The remote page is missing from this copy of PreCenter.</p>'; }
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers)); res.end(html); return;
    }
    if (u.pathname.startsWith('/m/') && (req.method === 'GET' || req.method === 'HEAD')) { serveMedia(req, res, decodeURIComponent(u.pathname.slice(3)), headers); return; }
    res.writeHead(404, headers); res.end('Not found');
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handle);
      s.on('upgrade', upgrade);
      s.once('error', reject);
      s.listen(p, '0.0.0.0', () => { s.removeListener('error', reject); resolve(s); });
    });
  }

  async function start() {
    if (server) return port;
    const first = opt.port == null ? 8765 : opt.port;
    let lastErr = null;
    for (let i = 0; i < 20; i++) {
      try { server = await listen(first + i); break; } catch (e) { lastErr = e; if (e.code !== 'EADDRINUSE') break; }
    }
    if (!server) { try { server = await listen(0); } catch (e) { throw lastErr || e; } }
    server.on('error', () => { /* keep running */ });
    port = server.address().port;
    timer = setInterval(() => {
      for (const c of Array.from(clients)) {
        if (!c.alive) { drop(c); continue; }
        c.alive = false;
        try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) { drop(c); }
      }
    }, 20000);
    if (timer.unref) timer.unref();
    return port;
  }

  function stop() {
    clearInterval(timer);
    for (const c of Array.from(clients)) drop(c);
    if (server) { try { server.close(); } catch (e) { /* closed */ } server = null; }
    port = 0;
  }

  function setState(obj) {
    lastState = JSON.stringify({ t: 'state', d: obj });
    for (const c of clients) send(c, lastState);
  }

  function newPin() {
    pin = newPinValue(); savePin();
    for (const c of Array.from(clients)) drop(c);   // phones paired with the old PIN must scan again
    return pin;
  }

  function info() {
    const urls = port ? lanAddresses().map(a => ({ name: a.name, address: a.address, url: 'http://' + a.address + ':' + port + '/?pin=' + pin })) : [];
    return { running: !!server, port, pin, urls, clients: count() };
  }

  return { start, stop, setState, newPin, info, count, putMedia };
}

module.exports = { create, lanAddresses, frame };
