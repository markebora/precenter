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
