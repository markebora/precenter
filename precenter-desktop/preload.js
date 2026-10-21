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
  displays: {
    list: () => ipcRenderer.invoke('display:list'),
    send: (displayId, fullscreen) => ipcRenderer.invoke('display:send', displayId, fullscreen !== false),
    sendNamed: (name, x, y) => ipcRenderer.invoke('display:sendNamed', name, x, y)
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    setNdi: on => ipcRenderer.invoke('app:setNdi', !!on),
    openConfig: () => ipcRenderer.invoke('app:openConfig'),
    openData: () => ipcRenderer.invoke('app:openData')
  }
});

ipcRenderer.on('file:open', (_e, f) => {
  try { deliverFile(document, f); } catch (e) { console.error('Could not open file', e); }
});

// ---- Slim title strip (Windows draws minimize / maximize / close over its right end) ----
const barArg = process.argv.find(a => a.startsWith('--dsc-titlebar='));
// Pop-up windows (output / stage / layout / remote...) inherit the main window's launch args,
// so they must opt out here: only the main window gets the title strip.
let isPopup = false;
try {
  isPopup = !!window.opener || /^(lp-|dsc)/.test(window.name || '') || /#(output|stage|layout)/.test(location.hash || '');
} catch (e) { /* ignore */ }
if (barArg && !isPopup) {
  const H = parseInt(barArg.split('=')[1], 10) || 32;
  window.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent =
      ':root{padding-top:' + H + 'px!important}' +
      ':root.dsc-fs{padding-top:0!important}' +
      '#dscTitle{position:fixed;top:0;left:0;right:0;height:' + H + 'px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:0 12px;box-sizing:border-box;-webkit-app-region:drag;-webkit-user-select:none;user-select:none;font:600 12px/1 system-ui,Segoe UI,sans-serif;letter-spacing:.2px}' +
      ':root.dsc-fs #dscTitle{display:none}' +
      '#dscTitle i{width:8px;height:8px;border-radius:50%;background:#E8B923;display:inline-block}' +
      // Title strip on top (title centered), the page's own menu bar (#mbar) directly under it.
      // Layout: root padding H + body padding 26 (menu bar) + #app + 24 (status bar).
      ':root:not(.dsc-fs) #mbar{top:' + H + 'px}' +
      '#dscTitle{justify-content:center}' +
      'body #app{height:calc(100vh - ' + H + 'px);height:calc(100dvh - ' + H + 'px)}' +
      'body.hasbars #app{height:calc(100vh - ' + (H + 50) + 'px);height:calc(100dvh - ' + (H + 50) + 'px)}' +
      'body.tlopen #app{height:calc(100vh - ' + (H + 218) + 'px)!important;height:calc(100dvh - ' + (H + 218) + 'px)!important}' +
      ':root.dsc-fs body #app{height:100vh;height:100dvh}' +
      ':root.dsc-fs body.hasbars #app{height:calc(100vh - 50px);height:calc(100dvh - 50px)}' +
      ':root.dsc-fs body.tlopen #app{height:calc(100vh - 218px)!important;height:calc(100dvh - 218px)!important}';
    document.head.appendChild(css);
    const bar = document.createElement('div');
    bar.id = 'dscTitle';
    bar.innerHTML = '<i></i><span>Disciples PreCenter</span>';
    document.body.appendChild(bar);

    // Match the strip to the page background (light / dark) and tell Windows what color its buttons sit on.
    const hex = c => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? m.slice(1, 4).map(n => ('0' + (+n).toString(16)).slice(-2)).join('') : '0e0f13'; };
    let last = '';
    function sync() {
      let bg = getComputedStyle(document.body).backgroundColor;
      if (!bg || /rgba\(.*,\s*0\)/.test(bg) || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
      const h = hex(bg);
      const lum = (parseInt(h.slice(0, 2), 16) * 299 + parseInt(h.slice(2, 4), 16) * 587 + parseInt(h.slice(4, 6), 16) * 114) / 1000;
      const ink = lum > 140 ? '#1a1a1d' : '#f7f7f7';
      const key = h + ink;
      if (key === last) return;
      last = key;
      bar.style.background = '#' + h;
      bar.style.color = ink;
      ipcRenderer.send('win:overlay', { color: '#' + h, symbolColor: ink });
    }
    sync();
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    ipcRenderer.on('win:fullscreen', (_e, on) => document.documentElement.classList.toggle('dsc-fs', !!on));
  });
}

// ---- "Update ready" notice (main window only). The update installs when the app is closed. ----
if (!isPopup) {
  ipcRenderer.on('update:ready', (_e, info) => {
    const show = () => {
      if (document.getElementById('dscUpdateNote')) return;
      const n = document.createElement('div');
      n.id = 'dscUpdateNote';
      n.textContent = 'Update ' + ((info && info.version) || '') + ' is ready. It installs when you close PreCenter.';
      n.style.cssText = 'position:fixed;right:16px;bottom:40px;z-index:2147483000;max-width:340px;padding:10px 14px;' +
        'border-radius:8px;background:#1d1f27;color:#f7f7f7;border:1px solid #E8B923;font:13px/1.4 system-ui,Segoe UI,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer';
      n.onclick = () => n.remove();
      document.body.appendChild(n);
      setTimeout(() => { try { n.remove(); } catch (e) { /* gone */ } }, 15000);
    };
    if (document.body) show(); else window.addEventListener('DOMContentLoaded', show);
  });
}
