/* Runs first in the "Broadcast full screen" page (an OBS browser source). The page is the app's own audience screen.
   Instead of a BroadcastChannel to another window, it gets the same messages over a WebSocket from PreCenter. */
(function () {
  var sc = document.currentScript, q = new URL(sc.src).searchParams, K = q.get('k') || '', N = parseInt(q.get('n') || '0', 10) || 0, SOUND = q.get('sound') === '1', PHONE = q.get('p') === '1';
  try { history.replaceState(null, '', location.pathname + location.search + '#output&n=' + N + '&bcast=1'); } catch (e) { location.hash = '#output&n=' + N + '&bcast=1'; }
  if (q.get('lite') === '1') document.addEventListener('DOMContentLoaded', function () { document.body.classList.add('lite'); });
  var st = document.createElement('style'); st.textContent = 'html,body{background:#000;margin:0;overflow:hidden;cursor:none}'; document.head.appendChild(st);
  if (!SOUND) { var play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { try { this.muted = true; } catch (e) { } return play.apply(this, arguments); }; }
  /* the output page asks for a click to go fullscreen: not needed in OBS */
  new MutationObserver(function (ml) { ml.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && n.textContent === 'Click once to go fullscreen') n.remove(); }); }); }).observe(document.documentElement, { childList: true, subtree: true });
  var Real = window.BroadcastChannel, hubs = [], ws = null, tm = 0, open = false;
  function deliver(m) { hubs.forEach(function (b) { try { b.dispatchEvent(new MessageEvent('message', { data: m })); } catch (e) { } }); }
  function Fake(name) {
    if (name !== 'lyrics-presenter') return new Real(name);
    var et = new EventTarget(), o = null;
    et.name = name;
    et.postMessage = function (m) { if (m && m.hello && open) { try { ws.send(JSON.stringify({ t: 'hello' })); } catch (e) { } } };
    et.close = function () { };
    Object.defineProperty(et, 'onmessage', { get: function () { return o; }, set: function (f) { if (o) et.removeEventListener('message', o); o = f; if (f) et.addEventListener('message', f); } });
    hubs.push(et);
    return et;
  }
  window.BroadcastChannel = Fake;
  var files = {};
  function onFrame(m) {
    if (m && m.bcBlob) {
      var b = m.bcBlob;
      if (files[b.name] === b.url) return;
      if (PHONE && b.size > 25 * 1048576) return;   /* a phone preview does not download big videos */
      files[b.name] = b.url;
      fetch(b.url).then(function (r) { return r.blob(); }).then(function (bl) { deliver({ blob: { name: b.name, file: new File([bl], b.name.split('/').pop(), { type: b.type || bl.type }) } }); }).catch(function () { delete files[b.name]; });
      return;
    }
    deliver(m);
  }
  function connect() {
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/bws?m=full&k=' + encodeURIComponent(K) + (PHONE ? '&p=1' : '')); } catch (e) { tm = setTimeout(connect, 2000); return; }
    ws.onopen = function () { open = true; try { ws.send(JSON.stringify({ t: 'hello' })); } catch (e) { } };
    ws.onmessage = function (e) { var j; try { j = JSON.parse(e.data); } catch (x) { return; } if (j && j.t === 'f') onFrame(j.m); };
    ws.onclose = function () { open = false; clearTimeout(tm); tm = setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (x) { } };
  }
  connect();
})();
