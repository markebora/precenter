'use strict';
// Updates the installed program itself from GitHub Releases (electron-updater).
// - Only for the installed (Setup) version. The portable version and "npm start" are skipped.
// - A new version downloads quietly in the background and installs when the app is CLOSED,
//   so a service is never interrupted.
// - Never throws: if anything goes wrong the current version keeps running.

function isInstalledBuild(app, env) {
  return !!app.isPackaged && !env.PORTABLE_EXECUTABLE_DIR;
}

function start(opts) {
  const app = opts.app;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const env = opts.env || process.env;
  const notify = opts.notify || (() => {});
  const delayMs = opts.delayMs == null ? 20 * 1000 : opts.delayMs;          // wait for the app to settle
  const everyMs = opts.everyMs == null ? 4 * 60 * 60 * 1000 : opts.everyMs; // then re-check every 4 hours

  if (!isInstalledBuild(app, env)) { log.info('Program auto-update is off (portable or not installed).'); return null; }

  let autoUpdater;
  try { autoUpdater = (opts.updater || require('electron-updater')).autoUpdater; }
  catch (e) { log.warn('Program auto-update is unavailable: ' + (e && e.message)); return null; }

  try {
    autoUpdater.logger = {
      info: m => log.info('updater: ' + m), warn: m => log.warn('updater: ' + m),
      error: m => log.warn('updater: ' + m), debug() {}
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('update-available', i => log.info('Update ' + (i && i.version) + ' found, downloading.'));
    autoUpdater.on('update-downloaded', i => {
      log.info('Update ' + (i && i.version) + ' downloaded. It installs when the app is closed.');
      try { notify({ version: i && i.version }); } catch (e) { /* ignore */ }
    });
    autoUpdater.on('error', e => log.warn('Update check failed: ' + (e && e.message)));
  } catch (e) { log.warn('Program auto-update could not start: ' + (e && e.message)); return null; }

  const check = () => {
    try {
      const p = autoUpdater.checkForUpdates();
      if (p && p.catch) p.catch(e => log.warn('Update check failed: ' + (e && e.message)));
    } catch (e) { log.warn('Update check failed: ' + (e && e.message)); }
  };
  const t1 = setTimeout(check, delayMs); if (t1.unref) t1.unref();
  const t2 = setInterval(check, everyMs); if (t2.unref) t2.unref();
  return { check };
}

module.exports = { start, isInstalledBuild };
