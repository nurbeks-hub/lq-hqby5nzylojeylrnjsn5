// Export writers: MP4 (WebCodecs through Mediabunny), GIF (own encoder), PNG sequence (own ZIP writer). All in the browser.
(function (root) {
  'use strict';
  // ---------- ZIP (store only) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  class Zip {
    constructor() { this.parts = []; this.dir = []; this.off = 0; }
    add(name, u8) {
      const nm = new TextEncoder().encode(name), crc = crc32(u8), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true); h.setUint32(14, crc, true); h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true); h.setUint16(26, nm.length, true);
      this.parts.push(h.buffer, nm, u8); this.dir.push({ nm, crc, size: u8.length, off: this.off }); this.off += 30 + nm.length + u8.length;
    }
    blob() {
      const out = this.parts.slice(); let cs = 0;
      for (const e of this.dir) { const d = new DataView(new ArrayBuffer(46)); d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint32(16, e.crc, true); d.setUint32(20, e.size, true); d.setUint32(24, e.size, true); d.setUint16(28, e.nm.length, true); d.setUint32(42, e.off, true); out.push(d.buffer, e.nm); cs += 46 + e.nm.length; }
      const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.dir.length, true); e.setUint16(10, this.dir.length, true); e.setUint32(12, cs, true); e.setUint32(16, this.off, true); out.push(e.buffer);
      return new Blob(out, { type: 'application/zip' });
    }
  }
  // ---------- GIF89a (per-frame palette from the most used colours, LZW) ----------
  class Gif {
    constructor(w, h, fps) { this.w = w; this.h = h; this.delay = Math.round(100 / fps); this.chunks = []; const hd = [71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8, 0x70, 0, 0, 0x21, 0xFF, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0]; this.chunks.push(new Uint8Array(hd)); this.hist = new Uint32Array(32768); this.map = new Int16Array(32768); }
    add(rgba) {
      const { w, h, hist, map } = this, n = w * h; hist.fill(0);
      for (let i = 0; i < n; i++) { const p = i * 4; hist[((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)]++; }
      const used = []; for (let b = 0; b < 32768; b++) if (hist[b]) used.push(b);
      used.sort((a, b) => hist[b] - hist[a]); const pal = used.slice(0, 256), pn = pal.length; map.fill(-1);
      const pr = new Uint8Array(256), pg = new Uint8Array(256), pb = new Uint8Array(256);
      for (let i = 0; i < pn; i++) { const b = pal[i]; map[b] = i; pr[i] = ((b >> 10) & 31) << 3 | 4; pg[i] = ((b >> 5) & 31) << 3 | 4; pb[i] = (b & 31) << 3 | 4; }
      for (let j = 256; j < used.length; j++) { const b = used[j], r = ((b >> 10) & 31) << 3 | 4, g = ((b >> 5) & 31) << 3 | 4, bl = (b & 31) << 3 | 4; let best = 0, bd = 1e9; for (let i = 0; i < pn; i++) { const d = (r - pr[i]) ** 2 * 3 + (g - pg[i]) ** 2 * 6 + (bl - pb[i]) ** 2; if (d < bd) { bd = d; best = i; } } map[b] = best; }
      const idx = new Uint8Array(n); for (let i = 0; i < n; i++) { const p = i * 4; idx[i] = map[((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)]; }
      const ct = new Uint8Array(768); for (let i = 0; i < pn; i++) { ct[i * 3] = pr[i]; ct[i * 3 + 1] = pg[i]; ct[i * 3 + 2] = pb[i]; }
      this.chunks.push(new Uint8Array([0x21, 0xF9, 4, 4, this.delay & 255, this.delay >> 8, 0, 0, 0x2C, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0x87]), ct, this._lzw(idx));
    }
    _lzw(idx) {
      const out = []; let buf = 0, bits = 0, blk = [];
      const emit = (code, size) => { buf |= code << bits; bits += size; while (bits >= 8) { blk.push(buf & 255); buf >>>= 8; bits -= 8; if (blk.length === 255) { out.push(255, ...blk); blk = []; } } };
      const CLEAR = 256, END = 257; let dict = new Map(), next = 258, size = 9; emit(CLEAR, size);
      let cur = idx[0];
      for (let i = 1; i < idx.length; i++) {
        const k = idx[i], key = cur * 256 + k, f = dict.get(key);
        if (f !== undefined) { cur = f; continue; }
        emit(cur, size); 
        if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
        else { emit(CLEAR, size); dict = new Map(); next = 258; size = 9; }
        cur = k;
      }
      emit(cur, size); emit(END, size); if (bits > 0) blk.push(buf & 255); if (blk.length) out.push(blk.length, ...blk); out.push(0);
      const r = new Uint8Array(out.length + 1); r[0] = 8; r.set(out, 1); return r;
    }
    blob() { return new Blob([...this.chunks, new Uint8Array([0x3B])], { type: 'image/gif' }); }
  }
  // ---------- MP4 ----------
  async function mp4Writer(canvas, fps, file, duration) {
    const MB = await import(new URL((root.VQR_BASE || '') + 'vendor/mediabunny.min.mjs', document.baseURI).href);
    let codec = null, fmt = null, ext = 'mp4', mime = 'video/mp4';
    const cfg = { width: canvas.width, height: canvas.height, bitrate: canvas.width >= 1000 ? 16e6 : 9e6 };
    if (await MB.canEncodeVideo('avc', cfg)) { codec = 'avc'; fmt = new MB.Mp4OutputFormat({ fastStart: 'in-memory' }); }
    else if (await MB.canEncodeVideo('vp9', cfg)) { codec = 'vp9'; fmt = new MB.WebMOutputFormat(); ext = 'webm'; mime = 'video/webm'; }
    else throw new Error('this browser cannot encode video — use GIF or PNG');
    const out = new MB.Output({ format: fmt, target: new MB.BufferTarget() });
    const vs = new MB.CanvasSource(canvas, { codec, bitrate: cfg.bitrate, keyFrameInterval: 1 });
    out.addVideoTrack(vs, { frameRate: fps });
    let audio = null, sound = false;
    if (file && codec === 'avc') {                                   // keep the source sound when it can be copied as is
      try {
        const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS }), at = await input.getPrimaryAudioTrack();
        if (at && (at.codec === 'aac' || at.codec === 'opus' || at.codec === 'mp3')) { const as = new MB.EncodedAudioPacketSource(at.codec); out.addAudioTrack(as); audio = { as, at, sink: new MB.EncodedPacketSink(at), cfg: await at.getDecoderConfig() }; }
      } catch (e) { audio = null; }
    }
    await out.start();
    return {
      ext, mime, codec,
      add: (t) => vs.add(t, 1 / fps),
      async finish() {
        if (audio) { try { let first = true; for await (const pk of audio.sink.packets()) { if (pk.timestamp >= duration) break; await audio.as.add(pk, first ? { decoderConfig: audio.cfg } : undefined); first = false; } sound = !first; } catch (e) { sound = false; } }
        await out.finalize(); return { blob: new Blob([out.target.buffer], { type: mime }), sound };
      },
    };
  }
  root.VQRExport = { Zip, Gif, mp4Writer };
})(window);
