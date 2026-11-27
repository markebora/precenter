'use strict';
// Google sign-in for the desktop app. Opens Supabase's sign-in page in the system browser and waits
// on this computer only (127.0.0.1) for the one-time code. The code is useless without the secret the
// page keeps (PKCE), so nothing else on the computer can use it.
const http = require('http');

const PORT = 53682;   // must match the Redirect URL added in Supabase: http://127.0.0.1:53682/**
const AUTHORIZE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/auth\/v1\/authorize\?/i;

function page(title, text) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PreCenter</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f13;color:#f4f4f6;font:16px system-ui,sans-serif;text-align:center">' +
    '<div><h1>' + title + '</h1><p>' + text + '</p></div>';
}

function create(opts) {
  const port = opts.port == null ? PORT : opts.port;
  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  const log = opts.log || { warn() {} };
  let cancel = null;   // ends the sign-in that is waiting now

  async function signIn(url) {
    if (!AUTHORIZE.test(url)) return { error: 'That sign-in address is not allowed.' };
    if (cancel) await cancel({ error: 'A newer sign-in was started.' });
    return new Promise(resolve => {
      let done = false, timer = null;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error_description') || u.searchParams.get('error');
        if (u.pathname !== '/callback' || (!code && !err)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
        res.end(code ? page('Signed in', 'You can close this tab and go back to PreCenter.')
          : page('Sign-in did not finish', 'Close this tab and try again in PreCenter.'),
          () => finish(code ? { code } : { error: 'Google sign-in did not finish: ' + String(err).slice(0, 200) }));
      });
      function finish(result) {
        if (done) return Promise.resolve();
        done = true; cancel = null; clearTimeout(timer);
        const closed = new Promise(r => server.close(() => r()));
        if (server.closeAllConnections) server.closeAllConnections();
        resolve(result);
        return closed;
      }
      server.on('error', e => {
        log.warn('Google sign-in: ' + e.message);
        finish({ error: e.code === 'EADDRINUSE' ? 'Another program is using port ' + port + '. Close other copies of PreCenter and try again.' : 'Could not start sign-in.' });
      });
      server.listen(port, '127.0.0.1', () => {
        cancel = finish;
        timer = setTimeout(() => finish({ error: 'Sign-in timed out. Try again.' }), timeoutMs);
        const back = 'http://127.0.0.1:' + server.address().port + '/callback';
        Promise.resolve(opts.openExternal(url + '&redirect_to=' + encodeURIComponent(back)))
          .catch(e => { log.warn('Google sign-in: ' + e.message); finish({ error: 'Could not open your web browser.' }); });
      });
    });
  }
  return { signIn };
}

module.exports = { create, PORT };
