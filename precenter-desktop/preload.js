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

// ---- Slim header: app name centered, Windows draws minimize / maximize / close at the right end ----
// Layout (like ProPresenter): [ header: name in the middle + window buttons ] then the app's own menu row.
const barArg = process.argv.find(a => a.startsWith('--dsc-titlebar='));
if (barArg) {
  const H = parseInt(barArg.split('=')[1], 10) || 28;
  window.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent =
      '#dscTitle{position:fixed;top:0;left:0;right:0;height:' + H + 'px;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;background:var(--panel);border-bottom:1px solid var(--line);color:var(--ink);-webkit-app-region:drag;-webkit-user-select:none;user-select:none;font:600 12px/1 Inter,system-ui,Segoe UI,sans-serif;letter-spacing:.3px}' +
      '#dscTitle i{width:8px;height:8px;border-radius:50%;background:#E8B923;display:inline-block}' +
      // the app menu row (File Edit View ...) moves down under the header; its own copy of the name is dropped
      '#mbar{top:' + H + 'px!important}' +
      '#mbar .brand{display:none}' +
      'body.hasbars{padding-top:' + (26 + H) + 'px!important}' +
      'body.hasbars #app{height:calc(100vh - ' + (50 + H) + 'px);height:calc(100dvh - ' + (50 + H) + 'px)}' +
      'body.tlopen #app{height:calc(100vh - ' + (218 + H) + 'px)!important;height:calc(100dvh - ' + (218 + H) + 'px)!important}' +
      // full screen (F11) has no window buttons, so give the space back
      ':root.dsc-fs #dscTitle{display:none}' +
      ':root.dsc-fs #mbar{top:0!important}' +
      ':root.dsc-fs #mbar .brand{display:inline}' +
      ':root.dsc-fs body.hasbars{padding-top:26px!important}' +
      ':root.dsc-fs body.hasbars #app{height:calc(100vh - 50px);height:calc(100dvh - 50px)}' +
      ':root.dsc-fs body.tlopen #app{height:calc(100vh - 218px)!important;height:calc(100dvh - 218px)!important}';
    document.head.appendChild(css);
    const bar = document.createElement('div');
    bar.id = 'dscTitle';
    bar.innerHTML = '<i></i><span>Disciples PreCenter</span>';
    document.body.insertBefore(bar, document.body.firstChild);

    // Paint the area behind Windows' buttons in the header color (light and dark theme).
    const hex = c => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? m.slice(1, 4).map(n => ('0' + (+n).toString(16)).slice(-2)).join('') : '151518'; };
    let last = '';
    function sync() {
      const h = hex(getComputedStyle(bar).backgroundColor);
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
