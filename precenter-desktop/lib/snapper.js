'use strict';
// Takes a picture of the real audience screen for the cloud remote (the Disciples phone app, over the internet).
// It opens the same page OBS and the Wi-Fi remote use (/broadcast/full, the app's own audience screen fed with the same
// messages as the projector) in a window nobody sees, and captures it. So the phone shows exactly what the room sees:
// same text, frame, font size, uppercase, backgrounds. Nothing is shown on the computer and nothing is drawn by hand.
//
// create({ BrowserWindow, url: () => 'http://127.0.0.1:PORT/broadcast/full?k=KEY&n=0&p=1&lite=1' | '', log })
//   capture() -> Promise<string>  a 'data:image/jpeg;base64,...' picture (640x360), or '' when it cannot be made
//   close()

const W = 1280, H = 720, OUT_W = 640, OUT_H = 360;
const MAX_CHARS = 380 * 1024;      // one Firestore document may be 1 MB; the rest of the state is small

function create(opt) {
  const log = opt.log || { info() {}, warn() {}, error() {} };
  let win = null, loadedUrl = '', ready = false, loading = null, lastFail = 0;

  function destroy() {
    const w = win; win = null; ready = false; loading = null; loadedUrl = '';
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch (e) { /* closing */ } }
  }

  function open(url) {
    if (win && !win.isDestroyed() && loadedUrl === url && (ready || loading)) return loading || Promise.resolve();
    destroy();
    win = new opt.BrowserWindow({
      show: false, width: W, height: H, useContentSize: true, frame: false, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' }
    });
    const w = win;
    loadedUrl = url;
    try { w.webContents.setFrameRate(5); w.webContents.setAudioMuted(true); } catch (e) { /* older Electron */ }
    w.on('closed', () => { if (win === w) { win = null; ready = false; loading = null; loadedUrl = ''; } });
    loading = w.loadURL(url).then(() => new Promise(r => setTimeout(r, 1200))).then(() => { if (win === w) { ready = true; } }).catch(e => { log.warn('Remote picture: page not loaded (' + e.message + ')'); if (win === w) destroy(); });
    loading.then(() => { if (win === w) loading = null; });
    return loading;
  }

  async function capture() {
    const url = opt.url();
    if (!url) { destroy(); return ''; }
    if (Date.now() - lastFail < 15000) return '';
    try {
      await open(url);
      if (!win || win.isDestroyed()) { lastFail = Date.now(); return ''; }
      await new Promise(r => setTimeout(r, 350));                       // let the slide finish drawing
      let img = await win.webContents.capturePage();
      if (!img || img.isEmpty()) return '';
      img = img.resize({ width: OUT_W, height: OUT_H, quality: 'best' });
      for (const q of [72, 55, 40]) {
        const s = 'data:image/jpeg;base64,' + img.toJPEG(q).toString('base64');
        if (s.length <= MAX_CHARS) return s;
      }
      return '';
    } catch (e) {
      lastFail = Date.now();
      log.warn('Remote picture failed: ' + e.message);
      destroy();
      return '';
    }
  }

  return { capture, close: destroy };
}

module.exports = { create };
