'use strict';
// Stream link bridge. The page is loaded from an https address, and a browser will not let an https page
// open a plain ws:// connection to another computer on the network (it only allows localhost). So the
// page asks this file to open the connection instead. The page itself never gets network access from it:
// it can only open a WebSocket to a /link address, send text, and close it.
// Needs Node 22+ (Electron 38 has it): the global WebSocket is used, so no extra package is required.

const MAX_LINKS = 4;          // links open at once (one is normal)
const MAX_MESSAGE = 64 * 1024; // the slide text is small; refuse anything big

function validUrl(u) {
  let p;
  try { p = new URL(String(u)); } catch (e) { return null; }
  if (p.protocol !== 'ws:' && p.protocol !== 'wss:') return null;
  if (p.pathname !== '/link') return null;
  if (!p.hostname) return null;
  return p.href;
}

// ipc: { handle(channel, fn), on(channel, fn) } (Electron's ipcMain). WS: a WebSocket class (default: global).
function create(ipc, WS) {
  WS = WS || globalThis.WebSocket;
  const links = new Map(); // key (sender id + page id) -> { ws, sender }
  const key = (e, id) => e.sender.id + ':' + String(id);

  function closeAll(senderId) {
    for (const [k, l] of links) {
      if (l.sender.id === senderId) { links.delete(k); try { l.ws.close(); } catch (e) { /* gone */ } }
    }
  }

  ipc.handle('link:open', (e, id, url) => {
    if (!WS) return { ok: false, error: 'This version of the app cannot open the link.' };
    const u = validUrl(url);
    if (!u) return { ok: false, error: 'That address does not work' };
    const k = key(e, id);
    if (links.has(k)) { try { links.get(k).ws.close(); } catch (er) { /* gone */ } links.delete(k); }
    if (links.size >= MAX_LINKS) return { ok: false, error: 'Too many links are open' };
    let ws;
    try { ws = new WS(u); } catch (er) { return { ok: false, error: 'That address does not work' }; }
    const sender = e.sender;
    links.set(k, { ws, sender });
    if (!sender.__linkCleanup) {
      sender.__linkCleanup = true;
      try { sender.once('destroyed', () => closeAll(sender.id)); } catch (er) { /* test doubles */ }
    }
    const tell = m => { try { if (!sender.isDestroyed || !sender.isDestroyed()) sender.send('link:ev', Object.assign({ id }, m)); } catch (er) { /* window closed */ } };
    ws.addEventListener('open', () => tell({ type: 'open' }));
    ws.addEventListener('error', () => tell({ type: 'error' }));
    ws.addEventListener('close', ev => { if (links.get(k) && links.get(k).ws === ws) links.delete(k); tell({ type: 'close', code: ev && ev.code }); });
    return { ok: true };
  });

  ipc.on('link:send', (e, id, text) => {
    const l = links.get(key(e, id));
    if (!l || typeof text !== 'string' || text.length > MAX_MESSAGE) return;
    try { if (l.ws.readyState === 1) l.ws.send(text); } catch (er) { /* closing */ }
  });

  ipc.on('link:close', (e, id) => {
    const k = key(e, id), l = links.get(k);
    if (!l) return;
    links.delete(k);
    try { l.ws.close(); } catch (er) { /* gone */ }
  });

  return { closeAll, count: () => links.size };
}

module.exports = { create, validUrl };
