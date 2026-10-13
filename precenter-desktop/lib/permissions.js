'use strict';
// Which things the page may ask this computer for. Only the app's own windows are ever trusted;
// anything else (an embedded video, a web page) is refused whatever the config says.

const ALIASES = { 'window-placement': 'window-management', 'speaker-selection': 'media' };

function isPermissionAllowed(cfg, urlPolicy, permission, requestingUrl) {
  if (!urlPolicy.isAppUrl(requestingUrl || '')) return false;
  const key = ALIASES[permission] || permission;
  return cfg.permissions[key] === true;
}

module.exports = { isPermissionAllowed };
