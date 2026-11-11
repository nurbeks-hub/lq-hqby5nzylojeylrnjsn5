// VIDEO QR core — turns a square RGBA frame into a valid, scannable QR symbol that still shows the picture.
// Pure CPU, no DOM: the same file runs in node (research harness) and in the browser (the tool).
// Depends on LiveQR (liveqr.js): the from-scratch encoder + Reed–Solomon solver that makes every frame error-free.
//
// Two steps per frame:
//   solve(src)  picture -> wanted module colours -> valid symbol (the picture is the data)
//   paint(src, out)  draws the symbol: every module gets a "mark" (the part a scanner needs) and a
//                    "surround" (the part of the module the picture may keep).
(function (root) {
  'use strict';
  const Q = root.LiveQR || (typeof require !== 'undefined' ? require('./liveqr.js') : null);

  const DEF = {
    ver: 6, level: 'L', text: 'https://higgsfield.ai', quiet: 3,
    shape: 'square',      // square | circle | round | liquid
    dot: 1,               // share of the module width the mark takes (square, circle)
    k: 0,                 // how far the surround is pulled toward the mark colour (0 = pure picture)
    kc: 0,                // the same pull, but only where the picture disagrees with the module (dark picture under a light module, or the reverse)
    color: 'color',       // color | mono | marks | duo | neon | pixel
    dHi: 0.28, lLo: 0.72, // dark marks are never brighter than dHi, light marks never darker than lLo
    dither: 0.38, balance: 0.5, hyst: 0.05, smooth: 0.2,
    maxDark: 1,           // cap on the share of dark modules (dark footage otherwise makes an almost black code that scanners lose)
    round: 1, gap: 0, levels: 5, glow: 0.55, wobble: 0.1,
    ink: [16, 16, 18], paper: [255, 255, 255], brand: [209, 254, 23],
    gray: 0, neon2: 0, pixSat: 0, margin: 0.2, drop: 0, minVer: 2,   // margin / drop / minVer: the 'minimal' look (see _mplan)
    //   // per-look switches (listed here so that changing the look resets them)
    logo: null,           // { x, y, w, h } in module units (inside the symbol): region whose picture is a logo
    finder: 'solid',      // solid | soft  (soft keeps picture colour in the finder's light ring)
    quietFill: 'picture', // picture | paper  (quiet zone: light version of the picture, or plain paper)
  };

  const luma = (r, g, b) => (r * 0.299 + g * 0.587 + b * 0.114) / 255;

  class Encoder {
    constructor(o) { this.o = Object.assign({}, DEF, o || {}); this._pk = ''; this._gk = ''; this.lo = 0.1; this.hi = 0.9; this.med = null; this.info = {}; this.fresh = true; }
    set(o) { Object.assign(this.o, o); return this; }

    _plan() {
      if (this.o.color === 'minimal') return this._mplan();
      const o = this.o, key = o.ver + '|' + o.level + '|' + o.text + '|' + o.quiet;
      if (key === this._pk) return; this._pk = key; this._gk = '';
      const L = this.L = Q.layout(o.ver, o.level); this.pay = Q.payloadCodewords(o.text, o.ver);
      if (this.pay.length > L.dataCodewords) throw new Error('link too long for this code size');
      this.P = Q.plan(L, Q.frameImportance(L), this.pay.length);
      const n = this.n = L.size, N = L.N, tot = this.tot = n + 2 * o.quiet;
      this.target = new Uint8Array(N); this.mods = new Uint8Array(N); this.fresh = true;
      this.cell = new Float32Array(tot * tot * 3); this.cellN = new Float32Array(tot * tot); this.cellY = new Float32Array(tot * tot);
      let free = 0; for (let i = 0; i < N; i++) if (this.P.modClass[i] === 0) free++;
      this.freeShare = free / N; this.inset = Q.pictureInset(this.P);
      // static blue-ish noise for the dither (white noise, high-passed and re-ranked; fixed in time -> no flicker)
      const bn = this.bn = new Float32Array(N); let s = 1234567;
      for (let i = 0; i < N; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; bn[i] = (s >>> 8) / 16777216; }
      const t = new Float32Array(N), idx = new Int32Array(N);
      for (let it = 0; it < 6; it++) {
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a += bn[((y + dy + n) % n) * n + (x + dx + n) % n]; t[y * n + x] = bn[y * n + x] - a / 9; }
        for (let i = 0; i < N; i++) idx[i] = i; idx.sort((p, q) => t[p] - t[q]); for (let i = 0; i < N; i++) bn[idx[i]] = (i + 0.5) / N;
      }
    }

    _geom(O) {
      const key = O + '|' + this._pk; if (key === this._gk) return; this._gk = key;
      const tot = this.tot, q = this.o.quiet, px = this.px = O / tot;
      const ci = this.ci = new Int16Array(O), cf = this.cf = new Float32Array(O);   // cell index on the tot grid, position inside the cell (-0.5..0.5)
      for (let x = 0; x < O; x++) { const f = (x + 0.5) / px; let c = Math.floor(f); if (c >= tot) c = tot - 1; ci[x] = c; cf[x] = f - c - 0.5; }
      this.O = O; this.q = q;
    }

    // ================= the 'minimal' look =================
    // A plain small symbol (capitals in alphanumeric mode when the link allows it) drawn as few dots as measured to be safe:
    //  - finder squares, their white separators and the alignment square stay solid; format dots are always drawn;
    //  - timing lines and the dark module are never drawn;
    //  - a data dot is drawn only where the picture does not already have the right tone (by `margin`);
    //  - on top of that the `drop` most expensive codewords are left to error correction.
    _mplan() {
      const o = this.o, key = 'M|' + o.level + '|' + o.text + '|' + o.quiet + '|' + o.minVer;
      if (key === this._pk) { o.ver = this.mVer; return; } this._pk = key; this._gk = '';
      let ver = Math.max(1, o.minVer || 2); while (ver < 40 && !Q.fitsPlain(o.text, ver, o.level)) ver++;
      if (!Q.fitsPlain(o.text, ver, o.level)) throw new Error('link too long for this code size');
      o.ver = this.mVer = ver; const L = this.L = Q.layout(ver, o.level), n = this.n = L.size, N = L.N; this.tot = n + 2 * o.quiet;
      this.mSyms = []; for (let m = 0; m < 8; m++) this.mSyms.push(Q.encodePlainAuto(o.text, ver, m, o.level).modules);
      this.mMask = -1; this.mods = this.mSyms[0]; this.fresh = true; this.inset = 0; this.P = null;
      const kind = this.mKind = new Uint8Array(N);       // 0 data, 1 solid (finder zone, alignment), 2 format (always a dot), 3 never drawn (timing, dark module)
      const inF = (x, y) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = y * n + x; if (!L.isFunc[i]) continue; kind[i] = inF(x, y) ? 1 : (x === 6 || y === 6) ? 3 : 2; }
      for (const ay of L.alignPos) for (const ax of L.alignPos) { if (inF(ax, ay)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) kind[(ay + dy) * n + ax + dx] = 1; }
      kind[(n - 8) * n + 8] = 3;
      const cw = this.mCw = new Int16Array(N).fill(-1); for (let q = 0; q < L.raw; q++) for (let j = 0; j < 8; j++) cw[L.order[q * 8 + j]] = q;
      this.mDraw = new Uint8Array(N); this.mY = new Float32Array(N); this.freeShare = 0.5; this.mDots = 0;
    }
    _msolve(src, O) {
      this._mplan(); const o = this.o, n = this.n, N = n * n, tot = this.tot, q = o.quiet, px = O / tot, Y = this.mY, kind = this.mKind;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {          // mean luminance of the central half of every cell
        const x0 = Math.floor((q + x + 0.25) * px), x1 = Math.max(x0 + 1, Math.floor((q + x + 0.75) * px)), y0 = Math.floor((q + y + 0.25) * px), y1 = Math.max(y0 + 1, Math.floor((q + y + 0.75) * px));
        let a = 0, c = 0; for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { const p = (yy * O + xx) * 4; a += src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114; c++; }
        Y[y * n + x] = a / (c * 255);
      }
      if (this.mMask < 0 || this.fresh) {                               // the mask that agrees with this frame most; kept until the link or look changes
        let best = -1, bm = 0; for (let m = 0; m < 8; m++) { const s = this.mSyms[m]; let a = 0; for (let i = 0; i < N; i++) if (!kind[i] && (Y[i] < 0.5) === (s[i] === 1)) a++; if (a > best) { best = a; bm = m; } }
        this.mMask = bm; this.mods = this.mSyms[bm]; this.mDraw.fill(0);
      }
      const mods = this.mods, draw = this.mDraw, mg = o.margin, hy = 0.03, cwN = new Int16Array(this.L.raw); let dots = 0;
      for (let i = 0; i < N; i++) {
        if (kind[i] === 1 || kind[i] === 3) { draw[i] = 0; continue; }
        if (kind[i] === 2) { draw[i] = 1; dots++; continue; }
        const m = draw[i] ? mg + hy : mg - hy, ok = mods[i] ? Y[i] < 0.5 - m : Y[i] > 0.5 + m;      // a little hysteresis so dots do not flicker
        draw[i] = ok ? 0 : 1; if (draw[i]) { dots++; if (this.mCw[i] >= 0) cwN[this.mCw[i]]++; }
      }
      if (o.drop > 0) {
        const idx = Array.from(cwN.keys()).sort((a, b) => cwN[b] - cwN[a]).slice(0, o.drop), gone = new Uint8Array(this.L.raw); for (const k of idx) gone[k] = 1;
        for (let i = 0; i < N; i++) if (draw[i] && this.mCw[i] >= 0 && gone[this.mCw[i]]) { draw[i] = 0; dots--; }
      }
      this.mDots = dots; this.freeShare = 1 - (dots + 3 * 64 + (this.L.alignPos.length ? 25 : 0)) / N; this.fresh = false;
      this.info = { dots, cells: N, mask: this.mMask };
    }
    _mpaint(src, out, O) {
      if (!this.mDraw || this.mMask < 0) this._msolve(src, O);
      const o = this.o, n = this.n, tot = this.tot, q = o.quiet, px = O / tot, mods = this.mods, kind = this.mKind, draw = this.mDraw, ink = o.ink, paper = o.paper;
      out.set(src);
      const e = Math.round(q * px);                                    // quiet zone: plain paper
      for (let y = 0; y < O; y++) { const edge = y < e || y >= O - e; for (let x = 0; x < O; x++) if (edge || x < e || x >= O - e) { const p = (y * O + x) * 4; out[p] = paper[0]; out[p + 1] = paper[1]; out[p + 2] = paper[2]; out[p + 3] = 255; } }
      const rad = o.dot * px / 2;
      for (let my = 0; my < n; my++) for (let mx = 0; mx < n; mx++) {
        const i = my * n + mx, c = mods[i] ? ink : paper;
        if (kind[i] === 1) {                                            // solid square
          const x0 = Math.round((q + mx) * px), x1 = Math.round((q + mx + 1) * px), y0 = Math.round((q + my) * px), y1 = Math.round((q + my + 1) * px);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * O + x) * 4; out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; }
        } else if (draw[i]) {                                           // round dot, anti-aliased
          const cx = (q + mx + 0.5) * px, cy = (q + my + 0.5) * px, x0 = Math.max(0, Math.floor(cx - rad - 1)), x1 = Math.min(O - 1, Math.ceil(cx + rad + 1)), y0 = Math.max(0, Math.floor(cy - rad - 1)), y1 = Math.min(O - 1, Math.ceil(cy + rad + 1));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), a = d <= rad - 0.5 ? 1 : d >= rad + 0.5 ? 0 : rad + 0.5 - d; if (a <= 0) continue;
            const p = (y * O + x) * 4; out[p] += (c[0] - out[p]) * a; out[p + 1] += (c[1] - out[p + 1]) * a; out[p + 2] += (c[2] - out[p + 2]) * a;
          }
        }
      }
    }

    // ---- step 1: picture -> valid symbol ----
    solve(src, O) {
      if (this.o.color === 'minimal') return this._msolve(src, O);
      this._plan(); this._geom(O);
      const o = this.o, n = this.n, N = n * n, tot = this.tot, q = this.q, ci = this.ci, cell = this.cell, cellN = this.cellN, cellY = this.cellY;
      cell.fill(0); cellN.fill(0);
      for (let y = 0; y < O; y++) { const row = ci[y] * tot, yo = y * O * 4; for (let x = 0; x < O; x++) { const c = row + ci[x], p = yo + x * 4, c3 = c * 3; cell[c3] += src[p]; cell[c3 + 1] += src[p + 1]; cell[c3 + 2] += src[p + 2]; cellN[c]++; } }
      for (let c = 0; c < tot * tot; c++) { const k = 1 / Math.max(1, cellN[c]), c3 = c * 3; cell[c3] *= k; cell[c3 + 1] *= k; cell[c3 + 2] *= k; cellY[c] = luma(cell[c3], cell[c3 + 1], cell[c3 + 2]); }
      const hist = new Uint32Array(64);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hist[Math.min(63, (cellY[(y + q) * tot + x + q] * 64) | 0)]++;
      let acc = 0, lo = 0, hi = 1, med = 0.5;
      for (let b = 0; b < 64; b++) { const pa = acc; acc += hist[b]; if (pa < N * 0.04 && acc >= N * 0.04) lo = b / 64; if (pa < N * 0.5 && acc >= N * 0.5) med = (b + 0.5) / 64; if (pa < N * 0.96 && acc >= N * 0.96) hi = (b + 1) / 64; }
      const a = this.fresh ? 1 : o.smooth; this.lo += (lo - this.lo) * a; this.hi += (hi - this.hi) * a; this.med = this.med == null ? med : this.med + (med - this.med) * a;
      const sc = 1 / Math.max(this.hi - this.lo, 0.08); let mid = 0.5 * (1 - o.balance) + o.balance * (this.med - this.lo) * sc;
      if (o.maxDark < 1) {                                                     // threshold never above the maxDark quantile of this frame
        let acc2 = 0, yq = 1; for (let b = 0; b < 64; b++) { acc2 += hist[b]; if (acc2 >= N * o.maxDark) { yq = (b + 0.5) / 64; break; } }
        this.yq = this.yq == null || this.fresh ? yq : this.yq + (yq - this.yq) * Math.max(a, 0.35); mid = Math.min(mid, (this.yq - this.lo) * sc);
      }
      const tg = this.target, bn = this.bn, amp = o.dither, hy = this.fresh ? 0 : o.hyst, lg = o.logo; let dark = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, Y = cellY[(y + q) * tot + x + q]; let v;
        if (lg && x >= lg.x && x < lg.x + lg.w && y >= lg.y && y < lg.y + lg.h) v = Y < 0.5 ? 1 : 0;      // logo: what a scanner will read there
        else { const d = (Y - this.lo) * sc - (mid + (bn[i] - 0.5) * amp); v = (hy > 0 && Math.abs(d) < hy) ? tg[i] : (d < 0 ? 1 : 0); }
        tg[i] = v; dark += v;
      }
      const r = Q.encode(this.P, tg, this.pay, -1, this.mods); this.fresh = false;
      let diff = 0; for (let i = 0; i < N; i++) if (this.mods[i] !== tg[i]) diff++;
      this.info = { ver: o.ver, level: o.level, n, mask: r.mask, dark: dark / N, forcedDiff: diff / N, freeShare: this.freeShare, inset: this.inset, px: this.px };
      return this.info;
    }

    // ---- step 2: draw ----
    paint(src, out, O, t) {
      if (this.o.color === 'minimal') return this._mpaint(src, out, O);
      const o = this.o, n = this.n, tot = this.tot, q = this.q, px = this.px, ci = this.ci, cf = this.cf, mods = this.mods, L = this.L, P = this.P;
      const isFunc = L.isFunc, cls = P.modClass, cell = this.cell, cellY = this.cellY;
      const shape = o.shape, mode = o.color, dHi = o.dHi, lLo = o.lLo, kS = o.k, kC = o.kc, lg = o.logo;
      const ink = o.ink, paper = o.paper, br = o.brand, brY = luma(br[0], br[1], br[2]);
      const half = Math.min(0.5, o.dot / 2), rad = o.dot / 2, aa = 1 / px;                 // module units
      const gapPx = o.gap, lev = o.levels, glow = o.glow, time = t || 0;
      // duo: brand colour is the light one if it is light enough, otherwise it becomes the dark one
      const duoLight = brY >= 0.5;
      const m = (x, y) => (x < 0 || y < 0 || x >= n || y >= n) ? 0 : mods[y * n + x];
      // neon glow: blurred map of light cells on the tot grid
      let gl = null;
      if (mode === 'neon' && glow > 0) {
        gl = this._gl && this._gl.length === tot * tot ? this._gl : (this._gl = new Float32Array(tot * tot)); const tmp = this._gt && this._gt.length === tot * tot ? this._gt : (this._gt = new Float32Array(tot * tot));
        for (let y = 0; y < tot; y++) for (let x = 0; x < tot; x++) { const mx = x - q, my = y - q; gl[y * tot + x] = (mx < 0 || my < 0 || mx >= n || my >= n) ? 1 : 1 - mods[my * n + mx]; }
        for (let pass = 0; pass < 2; pass++) {
          for (let y = 0; y < tot; y++) for (let x = 0; x < tot; x++) { const a = gl[y * tot + Math.max(0, x - 1)], b = gl[y * tot + x], c = gl[y * tot + Math.min(tot - 1, x + 1)]; tmp[y * tot + x] = (a + 2 * b + c) * 0.25; }
          for (let y = 0; y < tot; y++) for (let x = 0; x < tot; x++) { const a = tmp[Math.max(0, y - 1) * tot + x], b = tmp[y * tot + x], c = tmp[Math.min(tot - 1, y + 1) * tot + x]; gl[y * tot + x] = (a + 2 * b + c) * 0.25; }
        }
      }
      let R = 0, G = 0, B = 0;                                                             // colour registers (avoid allocations)
      const recolor = (r, g, b, Y, Yt) => {                                                // same hue, new luma
        if (Y < 0.004) { R = G = B = Yt * 255; return; }
        const s = Yt / Y; r *= s; g *= s; b *= s; const mx = Math.max(r, g, b);
        if (mx > 255) { const y8 = Yt * 255, k = (255 - y8) / Math.max(mx - y8, 1e-3); r = y8 + k * (r - y8); g = y8 + k * (g - y8); b = y8 + k * (b - y8); }
        R = r; G = g; B = b;
      };
      const kneeD = dHi * 0.6, kneeL = 1 - (1 - lLo) * 0.6;
      const toneD = (Y) => Y <= kneeD ? Y : kneeD + (Y - kneeD) * (dHi - kneeD) / (1 - kneeD);
      const toneL = (Y) => Y >= kneeL ? Y : kneeL - (kneeL - Y) * (kneeL - lLo) / kneeL;
      const markColor = (dark, r, g, b, Y) => {                                            // colour of a dark / light mark over picture colour (r,g,b)
        if (mode === 'mono' || mode === 'marks') { const c = dark ? ink : paper; R = c[0]; G = c[1]; B = c[2]; return; }
        if (mode === 'duo') {
          if (duoLight) { if (dark) { const f = Y * 0.35; R = ink[0] + (br[0] * 0.3 - ink[0]) * f; G = ink[1] + (br[1] * 0.3 - ink[1]) * f; B = ink[2] + (br[2] * 0.3 - ink[2]) * f; } else { const f = Math.max(0, Y - 0.35) * 0.9; R = br[0] + (255 - br[0]) * f; G = br[1] + (255 - br[1]) * f; B = br[2] + (255 - br[2]) * f; } }
          else { if (dark) { const f = 0.75 + Y * 0.5; R = Math.min(255, br[0] * f); G = Math.min(255, br[1] * f); B = Math.min(255, br[2] * f); const y2 = luma(R, G, B); if (y2 > dHi) { const s = dHi / y2; R *= s; G *= s; B *= s; } } else { const f = 0.86 + 0.14 * Y; R = 255 * f; G = 255 * f; B = 255 * f; } }
          return;
        }
        if (mode === 'neon') {
          if (dark) { const s = Math.min(0.22, dHi * 0.5 / Math.max(Y, 0.05)); R = r * s; G = g * s; B = b * s; }
          else if (o.neon2) {                                                              // LED colours: the picture's own hue where it has one, a cyan–pink–lime ramp by brightness where it is grey
            const mx3 = Math.max(r, g, b), mn3 = Math.min(r, g, b), ch = mx3 > 8 ? (mx3 - mn3) / mx3 : 0, w = Math.min(1, ch * 2.6);
            let pr, pg, pb; if (Y < 0.5) { const u = Y * 2; pr = 40 + 215 * u; pg = 225 - 85 * u; pb = 255 - 35 * u; } else { const u = (Y - 0.5) * 2; pr = 255 - 46 * u; pg = 140 + 114 * u; pb = 220 - 197 * u; }
            const y8 = Y * 255; let r2 = y8 + (r - y8) * 2.2, g2 = y8 + (g - y8) * 2.2, b2 = y8 + (b - y8) * 2.2; r2 = r2 < 0 ? 0 : r2; g2 = g2 < 0 ? 0 : g2; b2 = b2 < 0 ? 0 : b2;
            r2 = pr + (r2 - pr) * w; g2 = pg + (g2 - pg) * w; b2 = pb + (b2 - pb) * w;
            recolor(r2, g2, b2, Math.max(luma(r2, g2, b2), 0.004), Math.max(0.66, Math.min(0.9, 0.56 + Y * 0.4)));
          }
          else { const y8 = Y * 255, sat = 1.7; let r2 = y8 + (r - y8) * sat, g2 = y8 + (g - y8) * sat, b2 = y8 + (b - y8) * sat; r2 = r2 < 0 ? 0 : r2; g2 = g2 < 0 ? 0 : g2; b2 = b2 < 0 ? 0 : b2; const y2 = Math.max(luma(r2, g2, b2), 0.004); recolor(r2, g2, b2, y2, Math.max(lLo + 0.06, Math.min(0.97, 0.55 + Y * 0.5))); }
          return;
        }
        recolor(r, g, b, Y, dark ? toneD(Y) : toneL(Y));                                   // color, pixel
      };
      const post = (v) => Math.round(v / 255 * (lev - 1)) / (lev - 1) * 255;
      const lx0 = lg ? lg.x : 0, ly0 = lg ? lg.y : 0, lx1 = lg ? lg.x + lg.w : 0, ly1 = lg ? lg.y + lg.h : 0;
      for (let y = 0; y < O; y++) {
        const cy = ci[y], my = cy - q, v = cf[y], yo = y * O * 4;
        for (let x = 0; x < O; x++) {
          const cx = ci[x], mx = cx - q, u = cf[x], p = yo + x * 4;
          let r = src[p], g = src[p + 1], b = src[p + 2];
          if (o.gray) { const y8 = r * 0.299 + g * 0.587 + b * 0.114; r = g = b = y8; }   // monochrome picture
          if (mode === 'pixel') { const c3 = (cy * tot + cx) * 3; r = post(cell[c3]); g = post(cell[c3 + 1]); b = post(cell[c3 + 2]); const y8 = r * 0.299 + g * 0.587 + b * 0.114, k = o.pixSat || 1.7; r = Math.min(255, Math.max(0, y8 + (r - y8) * k)); g = Math.min(255, Math.max(0, y8 + (g - y8) * k)); b = Math.min(255, Math.max(0, y8 + (b - y8) * k)); }
          const Y = luma(r, g, b);
          const inside = mx >= 0 && my >= 0 && mx < n && my < n;
          let d = 0, fn = 0;
          if (!inside) {                                                                   // quiet zone: light, same family as the picture
            if (!(mode === 'neon' && o.neon2)) {
              if (o.quietFill === 'paper' && mode !== 'duo' && mode !== 'neon') { R = paper[0]; G = paper[1]; B = paper[2]; }
              else { markColor(0, r, g, b, Y); if (mode === 'marks') recolor(r, g, b, Y, toneL(Y)); }
              out[p] = R; out[p + 1] = G; out[p + 2] = B; out[p + 3] = 255; continue;
            }                                                                              // LED wall: the quiet zone is a ring of lit LEDs
          } else { const i = my * n + mx; d = mods[i]; fn = isFunc[i]; }
          let wM = 1;                                                                      // weight of the mark at this pixel
          let dk = d;                                                                      // is this pixel's mark dark
          if (fn && shape !== 'liquid' && shape !== 'round') wM = 1;
          else if (shape === 'square') { const ax = Math.abs(u), ay = Math.abs(v); const a1 = Math.min(1, Math.max(0, (half - ax) * px + 0.5)), a2 = Math.min(1, Math.max(0, (half - ay) * px + 0.5)); wM = half >= 0.5 ? 1 : a1 * a2; }
          else if (shape === 'circle') { const dist = Math.sqrt(u * u + v * v); wM = Math.min(1, Math.max(0, (rad - dist) * px + 0.5)); }
          else if (shape === 'round') {                                                    // connected rounded dark shapes on light ground
            if (d) {
              const cxn = u < 0 ? m(mx - 1, my) : m(mx + 1, my), cyn = v < 0 ? m(mx, my - 1) : m(mx, my + 1);
              if (!cxn && !cyn) { const rr = 0.42 * o.round, hs = 0.5 - 0.05 * o.round, dx = Math.abs(u) - hs + rr, dy = Math.abs(v) - hs + rr; const sd = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0) - rr; const cov = Math.min(1, Math.max(0, 0.5 - sd * px)); if (cov < 1) { dk = 2; wM = cov; } }
            }
          } else if (shape === 'liquid' && fn) { dk = 2; wM = d ? 1 : 0;                   // finder, timing and alignment patterns stay crisp squares
          } else if (shape === 'liquid') {                                                 // smooth field through module centres, thresholded
            const x0 = u < 0 ? mx - 1 : mx, y0 = v < 0 ? my - 1 : my, fx = u < 0 ? u + 1 : u, fy = v < 0 ? v + 1 : v;
            const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
            const f = (m(x0, y0) * (1 - sx) + m(x0 + 1, y0) * sx) * (1 - sy) + (m(x0, y0 + 1) * (1 - sx) + m(x0 + 1, y0 + 1) * sx) * sy;
            const thr = 0.5 + (fn ? 0 : o.wobble * Math.sin(0.55 * (mx + u) + 1.7 * time) * Math.sin(0.47 * (my + v) - 1.3 * time + 1.1));
            const cov = Math.min(1, Math.max(0, 0.5 + (f - thr) * px * 0.9)); dk = 2; wM = cov;
          }
          // logo region: the picture there is the logo itself; marks only where the solver had to disagree
          if (lg && mx >= lx0 && mx < lx1 && my >= ly0 && my < ly1 && shape !== 'liquid') {
            const cY = cellY[cy * tot + cx]; if ((d && cY < 0.4) || (!d && cY > 0.6)) { out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255; continue; }
          }
          if (dk === 2) {                                                                  // two-tone pixel: wM = dark coverage
            markColor(1, r, g, b, Y); const dR = R, dG = G, dB = B; markColor(0, r, g, b, Y);
            R += (dR - R) * wM; G += (dG - G) * wM; B += (dB - B) * wM;
          } else {
            if (fn && mode === 'neon' && o.neon2) { if (d) { R = 8; G = 8; B = 12; } else { R = 246; G = 246; B = 238; } }   // LED wall: finder, timing and alignment patterns in plain white on black
            else if (fn && o.finder === 'solid' && (mode === 'color' || mode === 'marks' || mode === 'pixel')) { if (d) { R = ink[0]; G = ink[1]; B = ink[2]; } else { recolor(r, g, b, Y, Math.max(toneL(Y), 0.86)); } }
            else markColor(d, r, g, b, Y);
            if (wM < 1) {                                                                  // surround: the picture, optionally pulled toward the mark
              let sr = r, sg = g, sb = b;
              if (mode === 'mono') { const c = d ? paper : paper; sr = c[0]; sg = c[1]; sb = c[2]; }
              else if (mode === 'neon') { const f = o.neon2 ? 0.035 : 0.1; sr = r * f + 4; sg = g * f + 4; sb = b * f + 6; }
              else if (mode === 'duo') { const mR = R, mG = G, mB = B; markColor(0, r, g, b, Y); sr = R; sg = G; sb = B; R = mR; G = mG; B = mB; }
              if (mode === 'color' || mode === 'marks' || mode === 'pixel') {
                if (kS > 0) { sr += (R - sr) * kS; sg += (G - sg) * kS; sb += (B - sb) * kS; }
                if (kC > 0) { const need = d ? Y - dHi : lLo - Y; if (need > 0) { const mR = R, mG = G, mB = B; recolor(r, g, b, Y, d ? Y - need * kC : Y + need * kC); const f = 1 - kS; sr += (R - r) * f; sg += (G - g) * f; sb += (B - b) * f; R = mR; G = mG; B = mB; } }
              }
              R = sr + (R - sr) * wM; G = sg + (G - sg) * wM; B = sb + (B - sb) * wM;
            }
          }
          if (gapPx > 0 && !fn) { const e = (0.5 - Math.max(Math.abs(u), Math.abs(v))) * px; if (e < gapPx) { const f = d ? 1 : 0.93; R *= f; G *= f; B *= f; } }
          if (gl) {                                                                        // add glow of the neighbouring light cells
            const gx = (x + 0.5) / px - 0.5, gy = (y + 0.5) / px - 0.5, x0 = Math.max(0, Math.min(tot - 2, Math.floor(gx))), y0 = Math.max(0, Math.min(tot - 2, Math.floor(gy))), fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
            const gv = (gl[y0 * tot + x0] * (1 - fx) + gl[y0 * tot + x0 + 1] * fx) * (1 - fy) + (gl[(y0 + 1) * tot + x0] * (1 - fx) + gl[(y0 + 1) * tot + x0 + 1] * fx) * fy;
            const cur = luma(R, G, B); if (cur < dHi) { const add = Math.min(glow * gv * 0.3, dHi * 0.8 - cur); if (add > 0) { const c3 = (cy * tot + cx) * 3, cyv = Math.max(cellY[cy * tot + cx], 0.05), s = add / cyv; R += cell[c3] * s; G += cell[c3 + 1] * s; B += cell[c3 + 2] * s; } }
          }
          out[p] = R; out[p + 1] = G; out[p + 2] = B; out[p + 3] = 255;
        }
      }
      return this.info;
    }
    render(src, out, O, t) { this.solve(src, O); return this.paint(src, out, O, t); }
  }

  // smallest version (>= minVer) whose first block can hold the link at this level
  function minVersion(text, level, minVer) {
    if (minVer === 'plain') { for (let v = 1; v <= 40; v++) if (Q.fitsPlain(text, v, level)) return v; return -1; }
    for (let v = Math.max(1, minVer || 1); v <= 40; v++) { const L = Q.layout(v, level), pay = Q.payloadCodewords(text, v); if (pay.length <= L.dataCodewords) return v; }
    return -1;
  }

  const api = { Encoder, DEF, minVersion, luma };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
