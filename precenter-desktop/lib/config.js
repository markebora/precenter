'use strict';
// Loads the editable config.json. Lines starting with // are notes and are ignored.
// A missing file is created from the default copy. A broken file never crashes the app:
// the defaults are used for that run and the problem is reported.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  mode: 'local',
  startUrl: '',
  siteUrl: 'https://worship-chords-rho.vercel.app',
  window: { width: 1500, height: 900, maximized: true, menuBar: false, backgroundColor: '#0e0f13' },
  permissions: {
    media: true, midi: true, midiSysex: false, 'clipboard-read': true, 'clipboard-sanitized-write': true,
    'window-management': true, fullscreen: true, 'display-capture': true, notifications: false, geolocation: false
  },
  corsRelaxHosts: ['worship-chords-rho.vercel.app', 'bible-api.com', 'api.planningcenteronline.com'],
  externalLinks: 'browser',
  offlineLibraries: true,
  singleInstance: true,
  devTools: false,
  ndi: { enabled: false }
};

// Removes // and /* */ comments but leaves text inside "strings" alone (so https:// survives).
function stripComments(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n === undefined ? '' : n; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1'); // forgive a trailing comma
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over, warn, trail) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isObj(over)) return out;
  for (const k of Object.keys(over)) {
    const where = trail ? trail + '.' + k : k;
    if (!(k in base) && !(trail === 'permissions')) { warn.push('Unknown setting "' + where + '" was ignored.'); continue; }
    const b = base[k], o = over[k];
    if (isObj(b)) out[k] = merge(b, o, warn, where);
    else if (Array.isArray(b)) {
      if (Array.isArray(o) && o.every(x => typeof x === 'string')) out[k] = o;
      else warn.push('"' + where + '" must be a list of text. The default was used.');
    } else if (typeof b === typeof o) out[k] = o;
    else if (trail === 'permissions' && typeof o === 'boolean') out[k] = o;
    else warn.push('"' + where + '" must be ' + (typeof b === 'boolean' ? 'true or false' : typeof b === 'number' ? 'a number' : 'text') + '. The default was used.');
  }
  return out;
}

function validate(cfg, warn) {
  if (!['local', 'remote'].includes(cfg.mode)) { warn.push('"mode" must be "local" or "remote". "local" was used.'); cfg.mode = 'local'; }
  if (!['browser', 'block'].includes(cfg.externalLinks)) { warn.push('"externalLinks" must be "browser" or "block". "browser" was used.'); cfg.externalLinks = 'browser'; }
  if (cfg.mode === 'remote') {
    let ok = false;
    try { const u = new URL(cfg.startUrl); ok = u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)); } catch (e) { /* not a URL */ }
    if (!ok) { warn.push('"startUrl" must be a full https:// address when mode is "remote". The built-in copy was used.'); cfg.mode = 'local'; }
  }
  cfg.window.width = Math.max(600, Math.round(cfg.window.width));
  cfg.window.height = Math.max(400, Math.round(cfg.window.height));
  cfg.corsRelaxHosts = cfg.corsRelaxHosts.map(h => h.trim().toLowerCase()).filter(Boolean);
  return cfg;
}

function parseText(text) {
  const warnings = [];
  let user;
  try { user = JSON.parse(stripComments(text)); } catch (e) { return { config: validate(merge(DEFAULTS, {}, warnings, ''), warnings), warnings, error: e.message }; }
  const config = validate(merge(DEFAULTS, user, warnings, ''), warnings);
  return { config, warnings, error: '' };
}

function loadConfig(dir, defaultFile) {
  const file = path.join(dir, 'config.json');
  let created = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) { fs.copyFileSync(defaultFile, file); created = true; }
  } catch (e) {
    const r = parseText('{}'); r.warnings.push('Could not create ' + file + ': ' + e.message); r.path = file; r.created = false; return r;
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { const r = parseText('{}'); r.warnings.push('Could not read ' + file + ': ' + e.message); r.path = file; r.created = created; return r; }
  const r = parseText(text.replace(/^\uFEFF/, ''));
  r.path = file; r.created = created;
  if (r.error) r.warnings.unshift('config.json has a mistake (' + r.error + '). The default settings were used for this run.');
  return r;
}

module.exports = { DEFAULTS, stripComments, parseText, loadConfig };
