'use strict';
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

function mimeFor(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

// Maps a URL path like "/index.html" to a file inside root. Returns null for anything outside root.
// vendor maps special paths (for example "vendor/jszip.min.js") to files that live elsewhere.
function resolveAppFile(root, urlPath, vendor) {
  let rel = String(urlPath || '').replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (vendor && Object.prototype.hasOwnProperty.call(vendor, rel)) return vendor[rel];
  if (rel.indexOf('\0') >= 0) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

module.exports = { mimeFor, resolveAppFile };
