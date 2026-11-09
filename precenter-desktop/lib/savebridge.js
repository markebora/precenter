'use strict';
// Saving a file the page builds (a whole service with its backgrounds can be hundreds of MB).
//
// Why this exists: the browser's own file-saving window needs a permission that the app does not hand out,
// so a save could end as an EMPTY file. This goes through the system Save window instead.
//
// What the page can and cannot do:
//  - It can only write into a file the person has just chosen in the system Save window. It never learns
//    a path it did not get from that window, and it cannot read anything.
//  - Data arrives in pieces. It is written to "<name>.saving" and only renamed to the real name when every
//    byte has arrived and the size on disk matches, so a failed or cancelled save never leaves an empty
//    or half-written file behind (and never damages an older file of the same name).

const fs = require('fs');
const path = require('path');

const MAX_OPEN = 3;                    // saves in progress at once (one is normal)
const MAX_CHUNK = 64 * 1024 * 1024;    // one piece; the page sends a few MB at a time

function safeName(n, fallback) {
  let s = String(n == null ? '' : n).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  if (!s) s = fallback;
  return s;
}

// Writes one file in pieces. Pure Node (no Electron), so it can be tested on its own.
class FileSaver {
  constructor() { this.jobs = new Map(); this.seq = 0; }

  async begin(owner, target) {
    if (this.jobs.size >= MAX_OPEN) throw new Error('Too many saves are running at once.');
    const tmp = target + '.saving';
    const fh = await fs.promises.open(tmp, 'w');     // fails here, before anything is built, if the folder cannot be written
    const id = 's' + (++this.seq);
    this.jobs.set(id, { owner, target, tmp, fh, bytes: 0 });
    return id;
  }

  job(owner, id) {
    const j = this.jobs.get(String(id));
    if (!j || j.owner !== owner) throw new Error('That save is not open any more.');
    return j;
  }

  async write(owner, id, chunk) {
    const j = this.job(owner, id);
    if (!(chunk instanceof Uint8Array)) throw new Error('Nothing to write.');
    if (chunk.length > MAX_CHUNK) throw new Error('That piece is too big.');
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let off = 0;
    while (off < buf.length) {
      const r = await j.fh.write(buf, off, buf.length - off);
      if (!r.bytesWritten) throw new Error('The disk did not accept the data (is it full?).');
      off += r.bytesWritten;
    }
    j.bytes += buf.length;
    return j.bytes;
  }

  async end(owner, id) {
    const j = this.job(owner, id);
    this.jobs.delete(String(id));
    try {
      if (j.bytes === 0) throw new Error('Nothing was written, so the file was not created.');
      try { await j.fh.sync(); } catch (e) { /* some drives cannot sync; the size check below still guards the result */ }
      await j.fh.close();
      await fs.promises.rename(j.tmp, j.target);
      const st = await fs.promises.stat(j.target);
      if (st.size !== j.bytes) throw new Error('The file on disk is ' + st.size + ' bytes but ' + j.bytes + ' were sent.');
      return { path: j.target, bytes: j.bytes };
    } catch (e) {
      try { await j.fh.close(); } catch (x) { /* already closed */ }
      try { await fs.promises.unlink(j.tmp); } catch (x) { /* already gone */ }
      throw e;
    }
  }

  async abort(owner, id) {
    const j = this.jobs.get(String(id));
    if (!j || j.owner !== owner) return;
    this.jobs.delete(String(id));
    try { await j.fh.close(); } catch (e) { /* already closed */ }
    try { await fs.promises.unlink(j.tmp); } catch (e) { /* already gone */ }
  }

  async abortOwner(owner) {
    for (const [id, j] of [...this.jobs]) if (j.owner === owner) await this.abort(owner, id);
  }
}

// ipc: { handle(channel, fn) } (Electron's ipcMain).
// deps: { showSaveDialog(sender, opts), showOpenDialog(sender, opts), dir (where the remembered folder is kept), documents }
function create(ipc, deps) {
  const saver = new FileSaver();
  const memo = path.join(deps.dir, 'save-folder.json');
  const dirOk = d => { try { return !!d && fs.statSync(d).isDirectory(); } catch (e) { return false; } };
  const remembered = () => { try { const d = JSON.parse(fs.readFileSync(memo, 'utf8')).dir; return dirOk(d) ? d : ''; } catch (e) { return ''; } };
  const remember = d => { try { fs.mkdirSync(deps.dir, { recursive: true }); fs.writeFileSync(memo, JSON.stringify({ dir: d })); } catch (e) { /* only a convenience */ } };
  const fail = e => ({ ok: false, error: String((e && e.message) || e) });

  // The page asks where to save; the person answers in the system Save window.
  ipc.handle('save:begin', async (e, o) => {
    try {
      o = o || {};
      const name = safeName(o.name, 'service.dscservice');
      const json = /\.json$/i.test(name);
      const r = await deps.showSaveDialog(e.sender, {
        title: String(o.title || 'Save').slice(0, 80),
        defaultPath: path.join(remembered() || deps.documents, name),
        filters: json ? [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }]
                      : [{ name: 'PreCenter service', extensions: ['dscservice'] }, { name: 'All files', extensions: ['*'] }]
      });
      if (!r || r.canceled || !r.filePath) return { canceled: true };
      const id = await saver.begin(e.sender.id, r.filePath);
      remember(path.dirname(r.filePath));
      try { if (!e.sender.__saveCleanup) { e.sender.__saveCleanup = true; e.sender.once('destroyed', () => saver.abortOwner(e.sender.id)); } } catch (er) { /* test doubles */ }
      return { ok: true, id, path: r.filePath, name: path.basename(r.filePath), dir: path.dirname(r.filePath) };
    } catch (er) { return fail(er); }
  });

  ipc.handle('save:write', async (e, id, bytes) => {
    try { await saver.write(e.sender.id, id, bytes); return { ok: true }; } catch (er) { return fail(er); }
  });

  ipc.handle('save:end', async (e, id) => {
    try { const r = await saver.end(e.sender.id, id); return { ok: true, bytes: r.bytes, path: r.path, name: path.basename(r.path), dir: path.dirname(r.path) }; } catch (er) { return fail(er); }
  });

  ipc.handle('save:abort', async (e, id) => { try { await saver.abort(e.sender.id, id); } catch (er) { /* nothing to undo */ } return { ok: true }; });

  // "Choose service save folder": only decides where the Save window opens next time.
  ipc.handle('save:folder', async e => {
    try {
      const r = await deps.showOpenDialog(e.sender, { title: 'Choose the folder for saved services', defaultPath: remembered() || deps.documents, properties: ['openDirectory', 'createDirectory'] });
      if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
      remember(r.filePaths[0]);
      return { ok: true, dir: r.filePaths[0], name: path.basename(r.filePaths[0]) || r.filePaths[0] };
    } catch (er) { return fail(er); }
  });

  return { saver, remembered };
}

module.exports = { create, FileSaver, safeName };
