'use strict';
// Appends to <data folder>/logs/main.log. Never throws: logging must not stop the app.
const fs = require('fs');
const path = require('path');

let file = null;

function init(dir) {
  try {
    const d = path.join(dir, 'logs');
    fs.mkdirSync(d, { recursive: true });
    file = path.join(d, 'main.log');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, path.join(d, 'main.old.log')); } catch (e) { /* no old log yet */ }
  } catch (e) { file = null; }
}

function write(level, msg) {
  const line = new Date().toISOString() + ' ' + level + ' ' + msg + '\n';
  try { if (file) fs.appendFileSync(file, line); } catch (e) { /* ignore */ }
  try { (level === 'ERROR' ? console.error : console.log)(line.trim()); } catch (e) { /* ignore */ }
}

module.exports = {
  init,
  info: m => write('INFO', m),
  warn: m => write('WARN', m),
  error: m => write('ERROR', m instanceof Error ? (m.stack || m.message) : String(m)),
  get path() { return file; }
};
