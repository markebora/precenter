'use strict';
// Runs before the page. The page only gets the small, safe window.dscNative object below.
// This file is self-contained on purpose: sandboxed preloads cannot require local files.
const { contextBridge, ipcRenderer } = require('electron');

function bytesFromBase64(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Opens a file the way the user would: by filling the hidden file picker the app already has
// (#svFile for a whole service, #itFile for exported items). Returns true if it was handed over.
function deliverFile(doc, f) {
  const bytes = bytesFromBase64(f.b64);
  const name = String(f.name || 'file');
  let target = 'svFile';
  if (/\.dscitems$/i.test(name)) target = 'itFile';
  else if (/\.json$/i.test(name)) {
    try { const j = JSON.parse(new TextDecoder().decode(bytes)); if (j && j.kind === 'items') target = 'itFile'; } catch (e) { /* treat as a service */ }
  }
  const input = doc.getElementById(target);
  if (!input) return false;
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: 'application/octet-stream' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

contextBridge.exposeInMainWorld('dscNative', {
  isDesktop: true,
  platform: process.platform,
  ndi: {
    sync: cfgs => ipcRenderer.invoke('ndi:sync', cfgs),
    onStatus: cb => { ipcRenderer.on('ndi:status', (_e, s) => cb(s)); }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openConfig: () => ipcRenderer.invoke('app:openConfig'),
    openData: () => ipcRenderer.invoke('app:openData')
  }
});

ipcRenderer.on('file:open', (_e, f) => {
  try { deliverFile(document, f); } catch (e) { console.error('Could not open file', e); }
});

// ---- Window buttons inside the toolbar (Windows draws minimize / maximize / close over its right end) ----
// There is no separate title bar: the toolbar row doubles as the title bar, so no space is wasted.
const barArg = process.argv.find(a => a.startsWith('--dsc-titlebar='));
if (barArg) {
  const H = parseInt(barArg.split('=')[1], 10) || 32;
  const BTNS = 140; // room kept free at the right end of the toolbar for the three buttons
  window.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent =
      // toolbar runs edge to edge across the very top, like a title bar
      'body #app{padding-top:0}' +
      'body #tb{margin:0 -8px;border-radius:0;border-top:0;border-left:0;border-right:0;padding-right:' + (BTNS + 8) + 'px;-webkit-app-region:drag}' +
      '#tb button,#tb input,#tb select,#tb a,#tb label,#tb textarea{-webkit-app-region:no-drag}' +
      // full screen (F11) has no window buttons, so give the space back
      ':root.dsc-fs body #app{padding-top:8px}' +
      ':root.dsc-fs body #tb{margin:0;border-radius:10px;border:1px solid var(--line);padding-right:8px}';
    document.head.appendChild(css);

    // Paint the button area in the toolbar color so it blends in (light and dark theme).
    const hex = c => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? m.slice(1, 4).map(n => ('0' + (+n).toString(16)).slice(-2)).join('') : '151518'; };
    let last = '';
    function sync() {
      const tb = document.getElementById('tb');
      if (!tb) return;
      const h = hex(getComputedStyle(tb).backgroundColor);
      const lum = (parseInt(h.slice(0, 2), 16) * 299 + parseInt(h.slice(2, 4), 16) * 587 + parseInt(h.slice(4, 6), 16) * 114) / 1000;
      const ink = lum > 140 ? '#1a1a1d' : '#f7f7f7';
      if (h + ink === last) return;
      last = h + ink;
      ipcRenderer.send('win:overlay', { color: '#' + h, symbolColor: ink });
    }
    sync();
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    ipcRenderer.on('win:fullscreen', (_e, on) => document.documentElement.classList.toggle('dsc-fs', !!on));
  });
}
