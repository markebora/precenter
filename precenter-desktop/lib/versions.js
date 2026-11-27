'use strict';
// Small helpers for showing versions: the release tag of the program (v1.0.5) and the version of the page (index.html).
const fs = require('fs');
const path = require('path');

// The release tag is always "v" + the app version (the build workflow tags releases that way).
function tagFor(version) {
  const v = String(version || '').trim().replace(/^v/i, '');
  return v ? 'v' + v : '';
}

// Remembers which page version was running last time, so a change can be announced once.
// Returns { previous, changed }. "changed" is false the very first time (nothing to compare with).
function recordPageVersion(dir, version) {
  const file = path.join(dir, 'page-version.json');
  let previous = '';
  try { previous = String(JSON.parse(fs.readFileSync(file, 'utf8')).version || ''); } catch (e) { /* first run */ }
  if (previous !== version) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version, seenAt: new Date().toISOString() }));
    } catch (e) { /* not critical */ }
  }
  return { previous, changed: !!previous && previous !== version };
}

module.exports = { tagFor, recordPageVersion };
