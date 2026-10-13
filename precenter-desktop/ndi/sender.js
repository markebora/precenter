'use strict';
// The ONLY file that talks to an NDI library for Node. To use another binding, change this file only.
// NDI is OFF in this build. See README.md ("Turning on NDI") before enabling it in config.json.
// The constant and method names below follow the "grandiose" family of bindings and are UNVERIFIED:
// check them against the version you install.
let lib = null, loadError = null;
try { lib = require('grandiose'); } catch (e) { loadError = e; }

const available = () => !!lib;
const why = () => (loadError ? String(loadError.message || loadError) : '');

async function create(name) {
  if (!lib) throw new Error('The NDI add-on is not installed (' + why() + ')');
  const s = await lib.send({ name, clockVideo: false, clockAudio: false });
  return {
    video(frame) { return s.video(frame); },
    destroy() { try { s.destroy(); } catch (e) { /* already gone */ } }
  };
}

function fourCC(alpha) {
  return alpha ? (lib.FOURCC_VIDEO_TYPE_BGRA !== undefined ? lib.FOURCC_VIDEO_TYPE_BGRA : lib.FOURCC_BGRA)
               : (lib.FOURCC_VIDEO_TYPE_BGRX !== undefined ? lib.FOURCC_VIDEO_TYPE_BGRX : lib.FOURCC_BGRX);
}

function frameFrom(bitmap, w, h, fps, alpha) {
  return {
    xres: w, yres: h,
    frameRateN: fps * 1000, frameRateD: 1000,
    pictureAspectRatio: w / h,
    frameFormatType: lib.FORMAT_TYPE_PROGRESSIVE !== undefined ? lib.FORMAT_TYPE_PROGRESSIVE : 1,
    lineStrideBytes: w * 4,
    fourCC: fourCC(alpha),
    data: bitmap
  };
}

module.exports = { available, why, create, frameFrom };
