'use strict';
// Decides what happens when the page opens a window or navigates somewhere.

const APP_HOST = 'app';

function parse(u) { try { return new URL(u); } catch (e) { return null; } }

function createUrlPolicy(cfg) {
  const remote = cfg.mode === 'remote' ? parse(cfg.startUrl) : null;

  // The bundled copy (dsc://app/...), the hosted copy when mode is "remote", and blank pop-ups
  // that the app fills in itself (identify screens, remote window).
  function isAppUrl(u) {
    if (u === '' || u === 'about:blank') return true;
    const p = parse(u); if (!p) return false;
    if (p.protocol === 'dsc:') return p.host === APP_HOST;
    return !!remote && p.origin === remote.origin;
  }

  // What to do with window.open(url): 'allow' (open an app window), 'external' (system browser) or 'deny'.
  function windowOpen(u) {
    if (isAppUrl(u)) return 'allow';
    return externalOk(u) ? 'external' : 'deny';
  }

  function externalOk(u) {
    const p = parse(u);
    if (!p) return false;
    if (cfg.externalLinks !== 'browser') return false;
    return p.protocol === 'https:' || p.protocol === 'http:' || p.protocol === 'mailto:';
  }

  // Navigation of an existing window: stay inside the app, send everything else out.
  function navigate(u) {
    if (isAppUrl(u)) return 'allow';
    return externalOk(u) ? 'external' : 'deny';
  }

  function startUrl() {
    return remote ? remote.href : 'dsc://' + APP_HOST + '/index.html';
  }

  function localUrl() { return 'dsc://' + APP_HOST + '/index.html'; }

  // Does a response from this address need CORS headers added so the app may read it?
  function needsCors(u) {
    const p = parse(u);
    if (!p || (p.protocol !== 'https:' && p.protocol !== 'http:')) return false;
    const host = p.hostname.toLowerCase();
    return cfg.corsRelaxHosts.some(h => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))));
  }

  return { isAppUrl, windowOpen, navigate, startUrl, localUrl, needsCors };
}

module.exports = { createUrlPolicy };
