'use strict';
const { app, BrowserWindow, Menu, protocol, session, ipcMain, shell, dialog, desktopCapturer, screen, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { createUrlPolicy } = require('./lib/urls');
const { isPermissionAllowed } = require('./lib/permissions');
const { mimeFor, resolveAppFile } = require('./lib/files');
const log = require('./lib/log');
const ndi = require('./ndi/manager');
const ndiSender = require('./ndi/sender');
const appUpdate = require('./lib/appupdate');
const lanPageLib = require('./lib/lanpage');
const saveBridge = require('./lib/savebridge');
const lanServer = require('./lib/lanserver');
const snapperLib = require('./lib/snapper');
const oauth = require('./lib/oauth');
 
// The bundled app is served from its own address (dsc://app/) instead of file://, so storage,
// BroadcastChannel between windows, file pickers and sign-in behave as they do on the web.
protocol.registerSchemesAsPrivileged([{
  scheme: 'dsc',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);
 
const APP_DIR = path.join(__dirname, 'app');
const FILE_EXT = /\.(dscservice|dscitems)$/i;
 
let cfgResult = null;      // { config, warnings, path, created }
let cfg = null;
let policy = null;
let mainWin = null;
let pendingFiles = [];
let rendererReady = false;
let snapper = null;       // hidden page that takes the picture of the audience screen for the cloud remote
let lan = null;           // Wi-Fi remote server (null when turned off in config.json)
 
function defaultConfigFile() {
  const packaged = path.join(process.resourcesPath || '', 'config.default.json');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'config', 'config.default.json');
}
 
function jszipPath() {
  try { return require.resolve('jszip/dist/jszip.min.js'); } catch (e) { return null; }
}
 
// ---------- files opened from Windows (double-click, "Open with", second launch) ----------
function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(a => FILE_EXT.test(a) && fs.existsSync(a));
}
 
function sendFile(p) {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > 200 * 1024 * 1024) { dialog.showErrorBox('File too large', path.basename(p) + ' is larger than 200 MB.'); return; }
    mainWin.webContents.send('file:open', { name: path.basename(p), b64: buf.toString('base64') });
  } catch (e) { log.error(e); dialog.showErrorBox('Could not open the file', String(e.message || e)); }
}
 
function flushFiles() {
  if (!mainWin || !rendererReady) return;
  const list = pendingFiles; pendingFiles = [];
  list.forEach(sendFile);
}
 
function queueFiles(list) {
  pendingFiles.push(...list);
  flushFiles();
}
 
// ---------- security: permissions, downloads of links, CORS for the hosts in config.json ----------
function setupSession() {
  const ses = session.defaultSession;
 
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || wc.getURL();
    const ok = isPermissionAllowed(cfg, policy, permission, url);
    if (!ok) log.warn('Refused permission "' + permission + '" for ' + url);
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = (details && details.requestingUrl) || requestingOrigin || '';
    return isPermissionAllowed(cfg, policy, permission, url);
  });
 
  // "Share a screen or window": use the system picker where there is one, else the first screen.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] })
      .then(sources => callback(sources.length ? { video: sources[0] } : {}))
      .catch(e => { log.error(e); callback({}); });
  }, { useSystemPicker: true });
 
  // Offline copy of JSZip (used when saving a whole service as one file).
  const jz = cfg.offlineLibraries ? jszipPath() : null;
  if (jz) {
    ses.webRequest.onBeforeRequest({ urls: ['https://cdnjs.cloudflare.com/ajax/libs/jszip/*'] }, (details, callback) => {
      callback({ redirectURL: 'dsc://app/vendor/jszip.min.js' });
    });
  }
 
  // The bundled app runs from dsc://app, so a few web services need CORS headers added to answer it.
  const ALLOW_HEADERS = 'authorization,content-type,accept,x-requested-with,x-firebase-gmpid';
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!policy.needsCors(details.url)) return callback({});
    const headers = {};
    Object.keys(details.responseHeaders || {}).forEach(k => { if (!/^access-control-allow-/i.test(k)) headers[k] = details.responseHeaders[k]; });
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,PATCH,DELETE,OPTIONS'];
    headers['Access-Control-Allow-Headers'] = [ALLOW_HEADERS];
    const out = { responseHeaders: headers };
    if (details.method === 'OPTIONS') out.statusLine = 'HTTP/1.1 204 No Content';
    callback(out);
  });
}
 
function setupProtocol() {
  const vendor = {};
  const jz = jszipPath();
  if (jz) vendor['vendor/jszip.min.js'] = jz;
  protocol.handle('dsc', async req => {
    try {
      const u = new URL(req.url);
      if (u.host !== 'app') return new Response('Not found', { status: 404 });
      const file = resolveAppFile(APP_DIR, decodeURIComponent(u.pathname), vendor);
      if (!file) return new Response('Not found', { status: 404 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': mimeFor(file), 'cache-control': 'no-cache' } });
    } catch (e) {
      if (e && e.code === 'ENOENT') return new Response('Not found', { status: 404 });
      log.error(e); return new Response('Error', { status: 500 });
    }
  });
}
 
// ---------- windows ----------
function popupOptions() {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
    }
  };
}
 
 
// ---------- output windows: keep them on the screen the user picked ----------
// Electron/Windows quirks this works around:
//  - a window opened with left/top for a second monitor is sized with the FIRST monitor's DPI scale,
//    so it overshoots the screen (lyrics cut off) until its bounds are applied a second time;
//  - going fullscreen picks the display the window is *on*, which can still be the main one.
function displayFromOptions(o) {
  if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return null;
  const w = o.width || 800, h = o.height || 600;
  return screen.getDisplayNearestPoint({ x: Math.round(o.x + w / 2), y: Math.round(o.y + h / 2) });
}
 
// Move a window onto a display (twice, for the DPI quirk) and optionally make it fullscreen there.
function placeOnDisplay(win, display, goFull) {
  if (!win || win.isDestroyed() || !display) return;
  const b = display.bounds;
  const apply = () => {
    if (win.isDestroyed()) return;
    win.setBounds(b); win.setBounds(b);
    if (goFull) setTimeout(() => { if (!win.isDestroyed()) win.setFullScreen(true); }, 150);
  };
  if (win.isFullScreen()) { win.once('leave-full-screen', apply); win.setFullScreen(false); }
  else apply();
}
 
function trackOutputWindow(win, display) {
  let target = display;          // the display this window is meant to live on
  let fixing = false;
  const remember = () => { if (!win.isDestroyed() && !win.isFullScreen() && !fixing) target = screen.getDisplayMatching(win.getBounds()); };
  win.on('moved', remember);
 
  // If it went fullscreen on the wrong display, put it back on the right one.
  win.on('enter-full-screen', () => {
    if (fixing || !target || win.isDestroyed()) return;
    const cur = screen.getDisplayMatching(win.getBounds());
    if (cur.id === target.id) return;
    fixing = true;
    log.info('Output window went fullscreen on display ' + cur.id + ', moving it to display ' + target.id);
    win.once('leave-full-screen', () => {
      if (win.isDestroyed()) return;
      win.setBounds(target.bounds); win.setBounds(target.bounds);
      setTimeout(() => { if (!win.isDestroyed()) win.setFullScreen(true); fixing = false; }, 150);
    });
    win.setFullScreen(false);
  });
 
  // Fix the DPI overshoot as soon as the window is on screen.
  win.once('ready-to-show', () => {
    const o = win.__dscOpts;
    if (o && typeof o.x === 'number') { const b = { x: o.x, y: o.y, width: o.width || 800, height: o.height || 600 }; win.setBounds(b); win.setBounds(b); }
  });
}
 
function guardWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    const d = policy.windowOpen(url);
    if (d === 'allow') return popupOptions();
    if (d === 'external') shell.openExternal(url).catch(e => log.error(e));
    else log.warn('Blocked window to ' + url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (win, details) => {
    try {
      const opts = (details && details.options) || {};
      win.__dscOpts = opts;
      const d = displayFromOptions(opts);
      win.__dscName = (details && details.frameName) || '';
      if (d) {
        trackOutputWindow(win, d);
        // Output / stage windows sent to a chosen screen go fullscreen there by themselves.
        const isOut = /#(output|stage|layout)/.test((details && details.url) || '');
        const w = opts.width || 0, h = opts.height || 0, wa = d.workArea;
        const fillsScreen = Math.abs(w - wa.width) <= 40 && Math.abs(h - wa.height) <= 40;
        const notMain = d.id !== screen.getPrimaryDisplay().id;
        if (isOut && (notMain || fillsScreen)) win.once('ready-to-show', () => placeOnDisplay(win, d, true));
      }
    } catch (e) { log.warn('Output window tracking: ' + e.message); }
  });
  wc.on('will-navigate', (e, url) => {
    const d = policy.navigate(url);
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external') shell.openExternal(url).catch(err => log.error(err));
  });
}
 
const TITLE_H = 32;
let customBar = false;
 
function createMain() {
  const w = cfg.window;
  customBar = !!w.customTitleBar && process.platform === 'win32';
  mainWin = new BrowserWindow({
    width: w.width, height: w.height, minWidth: 900, minHeight: 600,
    show: false, title: 'Disciples PreCenter', backgroundColor: w.backgroundColor,
    autoHideMenuBar: !w.menuBar,
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Own slim title strip: Windows still draws the minimize / maximize / close buttons for us.
    ...(customBar ? { titleBarStyle: 'hidden', titleBarOverlay: { color: w.backgroundColor, symbolColor: '#ffffff', height: TITLE_H } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: customBar ? ['--dsc-titlebar=' + TITLE_H] : [],
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, spellcheck: false, devTools: !!cfg.devTools
    }
  });
 
  mainWin.on('enter-full-screen', () => mainWin.webContents.send('win:fullscreen', true));
  mainWin.on('leave-full-screen', () => mainWin.webContents.send('win:fullscreen', false));
  mainWin.once('ready-to-show', () => { if (w.maximized) mainWin.maximize(); mainWin.show(); });
  mainWin.webContents.on('did-finish-load', () => {
    // give the app a moment to start (and the sign-in gate to appear) before handing it files
    setTimeout(() => { rendererReady = true; flushFiles(); }, 2500);
  });
  mainWin.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    log.error('Page failed to load (' + code + ' ' + desc + '): ' + url);
    if (url !== policy.localUrl()) {
      dialog.showMessageBoxSync(mainWin, { type: 'warning', message: 'Could not open ' + url, detail: 'The built-in copy of PreCenter will open instead.' });
      mainWin.loadURL(policy.localUrl());
    }
  });
  mainWin.webContents.on('render-process-gone', (_e, d) => log.error('Renderer gone: ' + d.reason));
  mainWin.on('closed', () => { ndi.stopAll(); if (snapper) snapper.close(); if (lan) lan.stop(); mainWin = null; app.quit(); });
  mainWin.loadURL(policy.startUrl());
}
 
// Turn NDI on or off from the app: rewrites the "ndi" line in config.json (comments stay) and applies it now.
function setNdi(on, withDialog) {
  on = !!on;
  try {
    const file = cfgResult.path;
    let text = fs.readFileSync(file, 'utf8');
    const line = '"ndi": { "enabled": ' + (on ? 'true' : 'false') + ' }';
    if (/"ndi"\s*:\s*\{[^}]*\}/.test(text)) text = text.replace(/"ndi"\s*:\s*\{[^}]*\}/, line);
    else text = text.replace(/\}\s*$/, '  ,' + line + '\n}\n');
    fs.writeFileSync(file, text);
  } catch (e) {
    log.error(e);
    dialog.showErrorBox('Could not save the NDI setting', String(e.message || e));
    buildMenu();
    return { enabled: !!cfg.ndi.enabled, available: ndiSender.available(), error: String(e.message || e) };
  }
  cfg.ndi.enabled = on;
  if (!on) { try { ndi.stopAll(); } catch (e) { log.error(e); } }
  buildMenu();
  if (mainWin) mainWin.webContents.send('ndi:enabled', on);
  const available = ndiSender.available();
  if (withDialog && mainWin) {
    dialog.showMessageBox(mainWin, on
      ? (available
        ? { type: 'info', message: 'NDI is on', detail: 'Set a screen\'s output to NDI under Screens. If a screen is already set to NDI, switch it off and on once to start sending.' }
        : { type: 'warning', message: 'NDI is on, but the NDI add-on is missing', detail: 'This build does not include the NDI add-on yet, so nothing can be sent. See README.md, "Turning on NDI".' })
      : { type: 'info', message: 'NDI is off', detail: 'Screens set to NDI stop sending.' });
  }
  return { enabled: on, available };
}
 
function buildMenu() {
  const tmpl = [
    { label: '&File', submenu: [
      { label: 'Open settings file (config.json)', click: () => shell.openPath(cfgResult.path) },
      { label: 'Show data folder', click: () => shell.openPath(app.getPath('userData')) },
      { label: 'NDI video output (needs the NDI add-on)', type: 'checkbox', checked: !!cfg.ndi.enabled, click: mi => setNdi(mi.checked, true) },
      { type: 'separator' },
      { role: 'quit', label: 'Quit' }
    ] },
    { label: '&View', submenu: [
      { role: 'reload', label: 'Reload' },
      { role: 'togglefullscreen', label: 'Full screen' },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ...(cfg.devTools ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])
    ] },
    { label: '&Help', submenu: [
      { label: 'Open the Disciples site', click: () => shell.openExternal(cfg.siteUrl) },
      { label: 'About', click: showAbout }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
}
 
function aboutText() {
  return [
    'Version ' + app.getVersion(),
    'Electron ' + process.versions.electron + ', Chromium ' + process.versions.chrome,
    '',
    'Settings file: ' + cfgResult.path,
    'Log file: ' + (log.path || '(none)'),
    'Mode: ' + cfg.mode + (cfg.mode === 'remote' ? ' (' + cfg.startUrl + ')' : ''),
    'NDI: ' + (cfg.ndi.enabled ? (ndiSender.available() ? 'on' : 'on, but the NDI add-on is missing') : 'off')
  ].join('\n');
}
 
function showAbout() {
  dialog.showMessageBox(mainWin, { type: 'info', title: 'About', message: 'Disciples PreCenter', detail: aboutText() });
}
 
// ---------- IPC from the page ----------
// ---------- Wi-Fi remote: phones on the same network, no internet ----------
const builtInPage = () => path.join(__dirname, 'lan', 'remote.html');
const customPage = () => path.join(app.getPath('userData'), 'lan', 'remote.html');      // a file you put there yourself wins
let lanPage = null;                                                                       // rebuilds remote.auto.html from Harmony
// The page OBS shows for "Broadcast full screen" is the app itself (its audience screen). In remote mode that is the hosted page,
// kept for 10 minutes; if it cannot be reached (or in bundled mode) the copy inside the program is used.
let bAppCache = { at: 0, html: '' };
async function broadcastAppHtml() {
  if (cfg.mode === 'remote' && cfg.startUrl) {
    if (bAppCache.html && Date.now() - bAppCache.at < 10 * 60 * 1000) return bAppCache.html;
    try {
      const r = await net.fetch(cfg.startUrl, { headers: { 'cache-control': 'no-cache' } });
      const t = r.ok ? await r.text() : '';
      if (t.length > 200 * 1024 && /<head/i.test(t)) { bAppCache = { at: Date.now(), html: t }; return t; }
    } catch (e) { log.warn('Broadcast page: hosted app not reachable, using the copy inside the program (' + e.message + ')'); }
  }
  return fs.promises.readFile(path.join(APP_DIR, 'index.html'), 'utf8');
}
function setupLan() {
  const fromMain = e => mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents;
  const toPage = (ch, ...a) => { try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, ...a); } catch (e) { /* closing */ } };
  ipcMain.handle('lan:info', e => (fromMain(e) && lan) ? lan.info() : { running: false, port: 0, pin: '', urls: [], clients: 0 });
  ipcMain.handle('lan:pageInfo', e => {
    if (!fromMain(e)) return null;
    const c = customPage();
    const i = lanPage ? lanPage.info() : { auto: false, at: 0, from: '', last: null };
    return { custom: fs.existsSync(c), auto: i.auto, at: i.at, from: i.from, last: i.last, enabled: !!lanPage, folder: path.dirname(c), file: c };
  });
  ipcMain.handle('lan:updatePage', async e => {
    if (!fromMain(e)) return null;
    if (!lanPage) return { status: 'invalid', message: 'Automatic phone page updates are turned off in config.json.' };
    return lanPage.check();
  });
  ipcMain.handle('lan:openPageFolder', e => {
    if (!fromMain(e)) return false;
    const dir = path.dirname(customPage());
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { /* shown below if it matters */ }
    return shell.openPath(dir).then(r => !r, () => false);
  });
  ipcMain.handle('lan:newPin', e => { if (fromMain(e) && lan) { lan.newPin(); return lan.info(); } return null; });
  // OBS links: the full-screen picture (same messages the audience window gets) and the lyrics / Bible overlay
  ipcMain.handle('lan:newBkey', e => { if (fromMain(e) && lan) { lan.newKey(); return lan.info(); } return null; });
  ipcMain.on('lan:bframe', (e, json) => { if (lan && fromMain(e) && typeof json === 'string') lan.bFrame(json); });
  ipcMain.on('lan:bov', (e, json) => { if (!lan || !fromMain(e) || typeof json !== 'string' || json.length > 200000) return; try { lan.bOverlay(JSON.parse(json)); } catch (err) { /* ignore */ } });
  ipcMain.on('lan:bstyle', (e, json) => { if (!lan || !fromMain(e) || typeof json !== 'string' || json.length > 200000) return; try { lan.bStyle(JSON.parse(json)); } catch (err) { /* ignore */ } });
  ipcMain.handle('lan:media', (e, key, data, type) => {
    if (!lan || !fromMain(e) || !data) return false;
    try { return lan.putMedia(String(key), Buffer.from(data), String(type || '')); } catch (err) { return false; }
  });
  // Picture of the real audience screen for the cloud remote (see lib/snapper.js). Empty text when it cannot be made.
  ipcMain.handle('lan:snap', async e => {
    if (!lan || !fromMain(e)) return '';
    if (!snapper) snapper = snapperLib.create({ BrowserWindow, log, url: () => { const i = lan.info(); return (i.running && i.port && i.bcast && i.bcast.key) ? 'http://127.0.0.1:' + i.port + '/broadcast/full?k=' + i.bcast.key + '&n=0&p=1&lite=1' : ''; } });
    try { return await snapper.capture(); } catch (err) { return ''; }
  });
  ipcMain.on('lan:state', (e, json) => {
    if (!lan || !fromMain(e) || typeof json !== 'string' || json.length > 2 * 1024 * 1024) return;
    try { lan.setState(JSON.parse(json)); } catch (err) { /* bad state: ignore */ }
  });
  if (!cfg.lan || !cfg.lan.enabled) return;
  lan = lanServer.create({
    port: cfg.lan.port,
    dir: app.getPath('userData'),
    // A remote.html in the app's data folder (lan/remote.html) wins over the one built into the app, so a new phone page is a file copy, not a rebuild.
    pageFile: () => { const c = customPage(); if (fs.existsSync(c)) return c; return lanPage && fs.existsSync(lanPage.autoFile) ? lanPage.autoFile : builtInPage(); },
    onCommand: c => toPage('lan:cmd', c),
    onClients: n => toPage('lan:clients', n),
    appHtml: broadcastAppHtml,
    overlayFile: path.join(__dirname, 'lan', 'overlay.html'),
    shimFile: path.join(__dirname, 'lan', 'bcast-shim.js'),
    onBHello: () => toPage('lan:bhello'),
    onBClients: n => toPage('lan:bclients', n)
  });
  if (cfg.lan.autoUpdatePage) {
    lanPage = lanPageLib.create({
      dir: app.getPath('userData'), templateFile: path.join(__dirname, 'lan', 'template.html'), log,
      url: cfg.lan.pageUrl || cfg.siteUrl, fetchFn: (u, o) => net.fetch(u, o)
    });
    setTimeout(() => lanPage.check().catch(() => {}), 4000);
    setInterval(() => lanPage.check().catch(() => {}), 30 * 60 * 1000).unref();
  }
  lan.start().then(p => log.info('Wi-Fi remote listening on port ' + p)).catch(err => { log.error('Wi-Fi remote could not start: ' + err.message); lan = null; });
}

function setupIpc() {
  // Song folder: every library song is copied here as a readable .txt and a .json (see the Song database panel). Only the main window may use it.
  const songsDir = () => path.join(app.getPath('documents'), 'Disciples PreCenter Songs');
  const isMainWin = e => !!mainWin && e.sender === mainWin.webContents;
  ipcMain.handle('songs:save', async (e, gid, title, json, text) => {
    if (!isMainWin(e) || !/^[0-9a-f-]{36}$/i.test(String(gid)) || typeof json !== 'string' || typeof text !== 'string' || json.length > 3 * 1024 * 1024) return false;
    try {
      const dir = songsDir(), tag = '[' + String(gid).slice(0, 8) + ']';
      await fs.promises.mkdir(dir, { recursive: true });
      const name = (String(title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled') + ' ' + tag;
      for (const f of await fs.promises.readdir(dir)) { if (f.includes(tag) && !f.startsWith(name + '.')) await fs.promises.unlink(path.join(dir, f)).catch(() => {}); }   // the song was renamed
      await fs.promises.writeFile(path.join(dir, name + '.txt'), String(title || 'Untitled') + '\n\n' + text, 'utf8');
      await fs.promises.writeFile(path.join(dir, name + '.json'), json, 'utf8');
      return true;
    } catch (err) { log.warn('Songs folder: ' + err.message); return false; }
  });
  // Google sign-in: the person's own browser does it (Google refuses embedded windows) and answers on this computer.
  const google = oauth.create({ openExternal: u => shell.openExternal(u), log });
  ipcMain.handle('auth:google', async (e, url) => {
    if (!isMainWin(e)) return { error: 'Not allowed.' };
    const res = await google.signIn(String(url));
    if (mainWin && res.code) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
    return res;
  });
  ipcMain.handle('songs:open', e => { if (!isMainWin(e)) return false; const d = songsDir(); return fs.promises.mkdir(d, { recursive: true }).then(() => shell.openPath(d)).then(r => !r, () => false); });
  setupLan();
  // Saving a service: the page streams the file to us and the person picks where in the system Save window.
  const winOf = sender => BrowserWindow.fromWebContents(sender) || mainWin;
  saveBridge.create(ipcMain, {
    showSaveDialog: (sender, o) => dialog.showSaveDialog(winOf(sender), o),
    showOpenDialog: (sender, o) => dialog.showOpenDialog(winOf(sender), o),
    dir: app.getPath('userData'),
    documents: app.getPath('documents')
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), configPath: cfgResult.path, dataPath: app.getPath('userData'),
    mode: cfg.mode, ndiEnabled: !!cfg.ndi.enabled, ndiAvailable: ndiSender.available()
  }));
  ipcMain.on('win:overlay', (e, o) => {
    if (!customBar || !mainWin || e.sender !== mainWin.webContents) return;
    const ok = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
    if (!o || !ok(o.color) || !ok(o.symbolColor)) return;
    try { mainWin.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: TITLE_H }); } catch (err) { log.warn('Title bar colors: ' + err.message); }
  });
  ipcMain.handle('display:list', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id, name: d.label || ('Display ' + (i + 1)), primary: d.id === primary,
      bounds: d.bounds, scaleFactor: d.scaleFactor
    }));
  });
  // Called from the output window: send THIS window to a display and make it fullscreen there.
  ipcMain.handle('display:send', (e, displayId, fullscreen) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const d = screen.getAllDisplays().find(x => x.id === displayId);
    if (!win || !d) return false;
    placeOnDisplay(win, d, fullscreen !== false);
    return true;
  });
  // Called from the main window: send an already-open output/stage window (by its window name) to the display at a point.
  ipcMain.handle('display:sendNamed', (e, name, x, y) => {
    const win = BrowserWindow.getAllWindows().find(w => w !== mainWin && w.__dscName === String(name) && !w.isDestroyed());
    if (!win || typeof x !== 'number' || typeof y !== 'number') return false;
    placeOnDisplay(win, screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }), true);
    return true;
  });
  ipcMain.handle('app:setNdi', (_e, on) => setNdi(on, false));
  ipcMain.handle('app:openConfig', () => shell.openPath(cfgResult.path));
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:gpu:get', () => {
    let status = null; try { status = app.getGPUFeatureStatus(); } catch (e) { /* not available */ }
    return { gpu: gpuOn, status };
  });
  ipcMain.handle('app:gpu:set', (_e, on) => {
    try { fs.writeFileSync(gpuFile, JSON.stringify({ gpu: !!on })); } catch (e) { log.warn('Could not save graphics setting: ' + e.message); return false; }
    app.relaunch(); app.exit(0);
    return true;
  });
  ipcMain.handle('ndi:sync', async (_e, list) => {
    const cfgs = Array.isArray(list) ? list : [];
    if (cfgs.length && !cfg.ndi.enabled) throw new Error('NDI is turned off. Turn it on from File > NDI video output (or Help > NDI output in the app).');
    if (cfgs.length && !ndiSender.available()) throw new Error('The NDI add-on is not installed (see README: Turning on NDI).');
    return ndi.sync(cfgs);
  });
}
 
// ---------- start ----------
process.on('uncaughtException', e => { try { log.error(e); } catch (x) { /* ignore */ } });
process.on('unhandledRejection', e => { try { log.error(e); } catch (x) { /* ignore */ } });
 
cfgResult = loadConfig(app.getPath('userData'), defaultConfigFile());
cfg = cfgResult.config;
policy = createUrlPolicy(cfg);
log.init(app.getPath('userData'));
// Graphics: the Profile > Advanced > Graphics choice is saved in graphics.json. It must be applied before the app is ready.
const gpuFile = path.join(app.getPath('userData'), 'graphics.json');
let gpuOn = true;
try { gpuOn = JSON.parse(fs.readFileSync(gpuFile, 'utf8')).gpu !== false; } catch (e) { /* no file yet: GPU on */ }
if (!gpuOn) app.disableHardwareAcceleration();
 
if (cfg.singleInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
    queueFiles(filesFromArgv(argv));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); queueFiles([p]); });
 
  app.whenReady().then(() => {
    log.info('Starting Disciples PreCenter ' + app.getVersion() + ' (' + cfg.mode + ')');
    cfgResult.warnings.forEach(w => log.warn(w));
    setupProtocol();
    setupSession();
    setupIpc();
    app.on('web-contents-created', (_e, wc) => guardWebContents(wc));
    ndi.init({ baseUrl: policy.startUrl(), notify: s => { if (mainWin) mainWin.webContents.send('ndi:status', s); } });
    buildMenu();
    pendingFiles = filesFromArgv(process.argv);
    createMain();
    if (cfg.autoUpdate) appUpdate.start({ app, log, notify: info => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:ready', info); } });
    if (cfgResult.warnings.length) {
      dialog.showMessageBox(mainWin, {
        type: 'warning', message: 'Some settings were not used',
        detail: cfgResult.warnings.join('\n') + '\n\nSettings file:\n' + cfgResult.path
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
}
