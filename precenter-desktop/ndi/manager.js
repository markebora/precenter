'use strict';
// Turns the app's NDI screen list into hidden offscreen windows and streams their frames to NDI.
const { BrowserWindow } = require('electron');
const sender = require('./sender');

const live = new Map(); // id -> { win, tx, key }
let notify = () => {};
let baseUrl = 'dsc://app/index.html';

function init(opts) { if (opts.notify) notify = opts.notify; if (opts.baseUrl) baseUrl = opts.baseUrl; }

function urlFor(cfg) {
  const base = baseUrl.split('#')[0];
  if (cfg.kind === 'stage') return base + '#stage' + cfg.index;
  return base + '#output' + (cfg.alpha ? '&key' : '');
}

async function start(cfg) {
  const win = new BrowserWindow({
    width: cfg.width, height: cfg.height, show: false, frame: false,
    transparent: !!cfg.alpha, backgroundColor: cfg.alpha ? '#00000000' : (cfg.color || '#000000'),
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true }
  });
  win.webContents.setFrameRate(cfg.fps);
  let tx;
  try { tx = await sender.create(cfg.name); }
  catch (e) { win.destroy(); notify({ id: cfg.id, name: cfg.name, error: e.message }); return; }
  win.webContents.on('paint', (_e, _dirty, image) => {
    const size = image.getSize();
    try { tx.video(sender.frameFrom(image.getBitmap(), size.width, size.height, cfg.fps, !!cfg.alpha)); }
    catch (e) { notify({ id: cfg.id, name: cfg.name, error: 'send failed: ' + e.message }); }
  });
  await win.loadURL(urlFor(cfg));
  live.set(cfg.id, { win, tx, key: JSON.stringify(cfg) });
}

function stop(id) {
  const o = live.get(id); if (!o) return;
  try { o.tx.destroy(); } catch (e) { /* ignore */ }
  try { o.win.destroy(); } catch (e) { /* ignore */ }
  live.delete(id);
}

// Called whenever the Screens settings change: start new ones, restart changed ones, stop removed ones.
async function sync(cfgs) {
  const want = new Map(cfgs.map(c => [c.id, c]));
  for (const id of [...live.keys()]) if (!want.has(id) || live.get(id).key !== JSON.stringify(want.get(id))) stop(id);
  for (const c of cfgs) if (!live.has(c.id)) await start(c);
  return { running: [...live.keys()] };
}

function stopAll() { [...live.keys()].forEach(stop); }

module.exports = { init, sync, stopAll };
