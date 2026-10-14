'use strict';
const { app, BrowserWindow, Menu, protocol, session, ipcMain, shell, dialog, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { createUrlPolicy } = require('./lib/urls');
const { isPermissionAllowed } = require('./lib/permissions');
const { mimeFor, resolveAppFile } = require('./lib/files');
const log = require('./lib/log');
const ndi = require('./ndi/manager');
const ndiSender = require('./ndi/sender');

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
        const isOut = /#(output|stage)/.test((details && details.url) || '');
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
  mainWin.on('closed', () => { ndi.stopAll(); mainWin = null; app.quit(); });
  mainWin.loadURL(policy.startUrl());
}

function buildMenu() {
  const tmpl = [
    { label: '&File', submenu: [
      { label: 'Open settings file (config.json)', click: () => shell.openPath(cfgResult.path) },
      { label: 'Show data folder', click: () => shell.openPath(app.getPath('userData')) },
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
function setupIpc() {
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
  ipcMain.handle('app:openConfig', () => shell.openPath(cfgResult.path));
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('ndi:sync', async (_e, list) => {
    const cfgs = Array.isArray(list) ? list : [];
    if (cfgs.length && !cfg.ndi.enabled) throw new Error('NDI is turned off. Set "ndi": { "enabled": true } in config.json (see README).');
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
    if (cfgResult.warnings.length) {
      dialog.showMessageBox(mainWin, {
        type: 'warning', message: 'Some settings were not used',
        detail: cfgResult.warnings.join('\n') + '\n\nSettings file:\n' + cfgResult.path
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
}
