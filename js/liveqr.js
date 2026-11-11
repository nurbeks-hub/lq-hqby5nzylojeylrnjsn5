// LIVE QR core — a QR encoder written from scratch, plus the solver that lets a picture live inside
// a fully valid symbol. Runs unchanged in node (film) and in the browser (live site).
//
// Idea. A QR symbol of version V, level L carries K data codewords and E error-correction codewords,
// split into Reed–Solomon blocks. The link needs ~30 codewords. Everything after the terminator is
// padding that no scanner ever looks at, so those bytes are ours. Reed–Solomon is an MDS code: in a
// block of n codewords with n-k check bytes, ANY k positions can be chosen freely and the remaining
// n-k are then uniquely determined. So for every block we pick WHICH n-k codewords the math gets
// (the ones under the border frame), set all the others to whatever the picture needs, and solve a
// (n-k)x(n-k) linear system over GF(256) for the rest. The result is an error-free codeword:
// all syndromes are zero, the scanner's whole error budget is still untouched.
(function (root) {
  'use strict';

  // ---------- GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D), alpha = 2 ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const ginv = a => EXP[255 - LOG[a]];

  // ---------- tables for error-correction levels L, M, Q, H (ISO/IEC 18004) ----------
  const ECC = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function alignPos(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17, na = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
    const r = new Array(na); r[0] = 6;
    for (let i = na - 1, pos = size - 7; i >= 1; i--, pos -= step) r[i] = pos;
    return r;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];

  // ---------- geometry of one version: function patterns, bit order, block interleave ----------
  function layout(ver, level) {
    level = level || 'L';
    const size = ver * 4 + 17, N = size * size;
    const isFunc = new Uint8Array(N), base = new Uint8Array(N);
    const setF = (x, y, d) => { if (x < 0 || y < 0 || x >= size || y >= size) return; isFunc[y * size + x] = 1; base[y * size + x] = d ? 1 : 0; };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }           // timing
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])                                    // finders + separators
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)); setF(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    const ap = alignPos(ver), na = ap.length;                                                         // alignment
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // format information (15 bits, two copies) — positions; bits depend on the mask
    const fmtPos = [];
    for (let i = 0; i <= 5; i++) fmtPos.push([8, i, i]);
    fmtPos.push([8, 7, 6], [8, 8, 7], [7, 8, 8]);
    for (let i = 9; i < 15; i++) fmtPos.push([14 - i, 8, i]);
    for (let i = 0; i < 8; i++) fmtPos.push([size - 1 - i, 8, i]);
    for (let i = 8; i < 15; i++) fmtPos.push([8, size - 15 + i, i]);
    for (const [x, y] of fmtPos) setF(x, y, 0);
    setF(8, size - 8, 1);                                                                             // dark module
    if (ver >= 7) {                                                                                   // version information
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) { const b = (bits >>> i) & 1, a = size - 11 + i % 3, c = Math.floor(i / 3); setF(a, c, b); setF(c, a, b); }
    }
    const funcDark = [];
    for (let m = 0; m < 8; m++) {
      const data = (LEVEL_BITS[level] << 3) | m;
      let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412, fd = base.slice();
      for (const [x, y, i] of fmtPos) fd[y * size + x] = (bits >>> i) & 1;
      funcDark.push(fd);
    }
    // zigzag order of data modules
    const order = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!isFunc[y * size + x]) order.push(y * size + x);
      }
    }
    const raw = order.length >> 3, nb = BLOCKS[level][ver], ecc = ECC[level][ver];
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    const blockN = [], blockK = [];
    for (let b = 0; b < nb; b++) { const n = shortLen + (b >= nShort ? 1 : 0); blockN.push(n); blockK.push(n - ecc); }
    const cwBlock = new Int16Array(raw), cwPos = new Int16Array(raw);
    let q = 0;
    for (let i = 0; i <= shortLen; i++) for (let b = 0; b < nb; b++) {
      const short = b < nShort;
      if (short && i === shortLen - ecc) continue;
      cwBlock[q] = b; cwPos[q] = (short && i > shortLen - ecc) ? i - 1 : i; q++;
    }
    const maskBit = [];
    for (let m = 0; m < 8; m++) { const mb = new Uint8Array(N); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mb[y * size + x] = MASKS[m](x, y) ? 1 : 0; maskBit.push(mb); }
    return { ver, level, size, N, isFunc, funcDark, order: Int32Array.from(order), raw, nb, ecc, blockN, blockK, cwBlock, cwPos, maskBit,
      dataCodewords: blockK.reduce((a, b) => a + b, 0), alignPos: ap };
  }

  // ---------- payload: byte mode segment + terminator (the only bytes a scanner reads) ----------
  function payloadCodewords(text, ver) {
    const bytes = []; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c > 255) throw new Error('ASCII/Latin-1 only'); bytes.push(c); }
    const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); for (const b of bytes) put(b, 8); put(0, 4);
    while (bits.length % 8) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
    return out;
  }

  // ---------- Reed–Solomon: classic systematic encoder (used for the plain reference symbol) ----------
  function rsGenerator(deg) {
    const g = new Uint8Array(deg); g[deg - 1] = 1; let rootv = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { g[j] = gmul(g[j], rootv); if (j + 1 < deg) g[j] ^= g[j + 1]; } rootv = gmul(rootv, 2); }
    return g;
  }
  function rsRemainder(data, g) {
    const r = new Uint8Array(g.length);
    for (const b of data) { const f = b ^ r[0]; r.copyWithin(0, 1); r[r.length - 1] = 0; for (let i = 0; i < r.length; i++) r[i] ^= gmul(g[i], f); }
    return r;
  }
  // syndromes S_i = c(alpha^i), i = 0..ecc-1; all zero <=> valid codeword
  function syndromesZero(cw, ecc) {
    const n = cw.length;
    for (let i = 0; i < ecc; i++) { let s = 0; const a = EXP[i]; for (let j = 0; j < n; j++) s = gmul(s, a) ^ cw[j]; if (s) return false; }
    return true;
  }

  // ---------- plan: which codewords the math gets, and the solver matrices ----------
  // importance: Float32Array(N), higher = more important to control. fixedCount: payload codewords.
  function plan(L, importance, fixedCount) {
    const { raw, nb, ecc, blockN, blockK, cwBlock, cwPos, order } = L;
    const cwImp = new Float32Array(raw), cwSum = new Float32Array(raw);
    for (let q = 0; q < raw; q++) { let mx = -1e9, s = 0; for (let j = 0; j < 8; j++) { const v = importance[order[q * 8 + j]]; if (v > mx) mx = v; s += v; } cwImp[q] = mx; cwSum[q] = s; }
    const qOf = []; for (let b = 0; b < nb; b++) qOf.push(new Int32Array(blockN[b]));
    for (let q = 0; q < raw; q++) qOf[cwBlock[q]][cwPos[q]] = q;
    const cls = new Uint8Array(raw);                      // 0 free (picture), 1 payload, 2 forced (math)
    const payQ = new Int32Array(fixedCount);              // payload codewords fill the data part of block 0, then block 1, ...
    { let b = 0, p = 0; for (let i = 0; i < fixedCount; i++) { while (p >= blockK[b]) { b++; p = 0; if (b >= nb) throw new Error('payload too long'); } payQ[i] = qOf[b][p]; cls[qOf[b][p]] = 1; p++; } }
    const blocks = [];
    for (let b = 0; b < nb; b++) {
      const n = blockN[b], cand = [];
      for (let p = 0; p < n; p++) { const q = qOf[b][p]; if (cls[q] !== 1) cand.push(p); }
      cand.sort((p1, p2) => (cwImp[qOf[b][p1]] - cwImp[qOf[b][p2]]) || (cwSum[qOf[b][p1]] - cwSum[qOf[b][p2]]));
      const F = cand.slice(0, ecc).sort((a, c) => a - c), inF = new Uint8Array(n);
      for (const p of F) { inF[p] = 1; cls[qOf[b][p]] = 2; }
      const G = []; for (let p = 0; p < n; p++) if (!inF[p]) G.push(p);
      // parity-check rows H[i][j] = alpha^(i*(n-1-j)); solve H_F * X = H_G  (Gauss–Jordan over GF(256))
      const W = ecc + G.length, A = new Uint8Array(ecc * W);
      for (let i = 0; i < ecc; i++) {
        for (let c = 0; c < ecc; c++) A[i * W + c] = EXP[(i * (n - 1 - F[c])) % 255];
        for (let c = 0; c < G.length; c++) A[i * W + ecc + c] = EXP[(i * (n - 1 - G[c])) % 255];
      }
      for (let c = 0; c < ecc; c++) {
        let piv = c; while (piv < ecc && !A[piv * W + c]) piv++;
        if (piv === ecc) throw new Error('singular');
        if (piv !== c) for (let j = 0; j < W; j++) { const t = A[c * W + j]; A[c * W + j] = A[piv * W + j]; A[piv * W + j] = t; }
        const iv = ginv(A[c * W + c]); for (let j = 0; j < W; j++) A[c * W + j] = gmul(A[c * W + j], iv);
        for (let r = 0; r < ecc; r++) if (r !== c && A[r * W + c]) { const f = A[r * W + c]; for (let j = 0; j < W; j++) A[r * W + j] ^= gmul(A[c * W + j], f); }
      }
      const M = new Uint8Array(ecc * G.length);           // log-domain matrix (255 = zero) for speed
      for (let i = 0; i < ecc; i++) for (let c = 0; c < G.length; c++) { const v = A[i * W + ecc + c]; M[i * G.length + c] = v ? LOG[v] : 255; }
      blocks.push({ n, F: Int16Array.from(F), G: Int16Array.from(G), M, cw: new Uint8Array(n), q: qOf[b] });
    }
    const modClass = new Uint8Array(L.N);                 // per module: 0 free, 1 payload, 2 forced, 3 function
    for (let i = 0; i < L.N; i++) modClass[i] = L.isFunc[i] ? 3 : 0;
    for (let q = 0; q < raw; q++) for (let j = 0; j < 8; j++) modClass[order[q * 8 + j]] = cls[q];
    return { L, blocks, cls, modClass, fixedCount, payQ };
  }

  // ---------- one frame: target module picture -> valid symbol ----------
  // target: Uint8Array(N) wanted colour of every module (1 = dark). payload: Uint8Array of codewords.
  // mask: 0..7, or -1 to pick the mask under which the fixed payload modules disagree least with the picture.
  function encode(P, target, payload, mask, out) {
    const L = P.L, { order, raw, cwBlock, cwPos, maskBit, N } = L;
    if (payload.length !== P.fixedCount) throw new Error('payload length differs from plan');
    if (mask < 0) {
      let best = 1e9;
      for (let m = 0; m < 8; m++) {
        let bad = 0; const mb = maskBit[m];
        for (let p = 0; p < payload.length; p++) { const q = P.payQ[p]; for (let j = 0; j < 8; j++) { const mod = order[q * 8 + j]; if ((((payload[p] >>> (7 - j)) & 1) ^ mb[mod]) !== target[mod]) bad++; } }
        if (bad < best) { best = bad; mask = m; }
      }
    }
    const mb = maskBit[mask];
    for (let q = 0; q < raw; q++) {                        // wanted codewords everywhere
      let v = 0; const o = q * 8;
      for (let j = 0; j < 8; j++) { const mod = order[o + j]; v = (v << 1) | (target[mod] ^ mb[mod]); }
      P.blocks[cwBlock[q]].cw[cwPos[q]] = v;
    }
    for (let p = 0; p < payload.length; p++) { const q = P.payQ[p]; P.blocks[cwBlock[q]].cw[cwPos[q]] = payload[p]; }
    for (const B of P.blocks) {                            // the math's share: cw_F = M * cw_G
      const { F, G, M, cw } = B, gl = G.length;
      for (let i = 0; i < F.length; i++) {
        let s = 0; const row = i * gl;
        for (let c = 0; c < gl; c++) { const v = cw[G[c]], m = M[row + c]; if (v && m !== 255) s ^= EXP[LOG[v] + m]; }
        cw[F[i]] = s;
      }
    }
    out = out || new Uint8Array(N);
    const fd = L.funcDark[mask];
    for (let i = 0; i < N; i++) out[i] = L.isFunc[i] ? fd[i] : mb[i];   // remainder bits = 0 ^ mask
    for (let q = 0; q < raw; q++) { const v = P.blocks[cwBlock[q]].cw[cwPos[q]], o = q * 8; for (let j = 0; j < 8; j++) { const mod = order[o + j]; out[mod] = ((v >>> (7 - j)) & 1) ^ mb[mod]; } }
    return { modules: out, mask };
  }
  function checkSyndromes(P) { let ok = 0; for (const B of P.blocks) if (syndromesZero(B.cw, P.L.ecc)) ok++; return ok; }

  // ---------- plain textbook symbol (pad bytes EC 11, systematic RS) — reference for tests ----------
  function encodePlain(text, ver, mask, level) {
    const L = layout(ver, level), pay = payloadCodewords(text, ver), data = new Uint8Array(L.dataCodewords);
    data.set(pay); for (let i = pay.length, t = 0; i < data.length; i++, t++) data[i] = t % 2 ? 0x11 : 0xEC;
    const g = rsGenerator(L.ecc), cws = []; let off = 0;
    for (let b = 0; b < L.nb; b++) { const d = data.subarray(off, off + L.blockK[b]); off += L.blockK[b]; const c = new Uint8Array(L.blockN[b]); c.set(d); c.set(rsRemainder(d, g), d.length); cws.push(c); }
    const mb = L.maskBit[mask], out = new Uint8Array(L.N), fd = L.funcDark[mask];
    for (let i = 0; i < L.N; i++) out[i] = L.isFunc[i] ? fd[i] : mb[i];
    for (let q = 0; q < L.raw; q++) { const v = cws[L.cwBlock[q]][L.cwPos[q]]; for (let j = 0; j < 8; j++) { const mod = L.order[q * 8 + j]; out[mod] = ((v >>> (7 - j)) & 1) ^ mb[mod]; } }
    return { L, modules: out };
  }


  // ---------- plain symbol with the shortest segment: alphanumeric mode when the text allows it (capitals, digits, " $%*+-./:") ----------
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function isAlnum(text) { if (!text.length) return false; for (let i = 0; i < text.length; i++) if (ALNUM.indexOf(text[i]) < 0) return false; return true; }
  function plainBits(text, ver) {
    const bits = [], put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    if (isAlnum(text)) {
      put(2, 4); put(text.length, ver <= 9 ? 9 : 11);
      for (let i = 0; i + 1 < text.length; i += 2) put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      if (text.length % 2) put(ALNUM.indexOf(text[text.length - 1]), 6);
    } else {
      put(4, 4); put(text.length, ver <= 9 ? 8 : 16);
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c > 255) throw new Error('ASCII/Latin-1 only'); put(c, 8); }
    }
    return bits;
  }
  function fitsPlain(text, ver, level) { return plainBits(text, ver).length <= layout(ver, level).dataCodewords * 8; }
  function encodePlainAuto(text, ver, mask, level) {
    const L = layout(ver, level), bits = plainBits(text, ver), cap = L.dataCodewords * 8;
    if (bits.length > cap) throw new Error('link too long for this code size');
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = new Uint8Array(L.dataCodewords); for (let i = 0; i < bits.length; i++) data[i >> 3] |= bits[i] << (7 - (i & 7));
    for (let i = bits.length >> 3, t = 0; i < data.length; i++, t++) data[i] = t % 2 ? 0x11 : 0xEC;
    const g = rsGenerator(L.ecc), cws = []; let off = 0;
    for (let b = 0; b < L.nb; b++) { const d = data.subarray(off, off + L.blockK[b]); off += L.blockK[b]; const c = new Uint8Array(L.blockN[b]); c.set(d); c.set(rsRemainder(d, g), d.length); cws.push(c); }
    const mb = L.maskBit[mask], out = new Uint8Array(L.N), fd = L.funcDark[mask];
    for (let i = 0; i < L.N; i++) out[i] = L.isFunc[i] ? fd[i] : mb[i];
    for (let q = 0; q < L.raw; q++) { const v = cws[L.cwBlock[q]][L.cwPos[q]]; for (let j = 0; j < 8; j++) { const mod = L.order[q * 8 + j]; out[mod] = ((v >>> (7 - j)) & 1) ^ mb[mod]; } }
    return { L, modules: out };
  }

  // ISO mask penalty (N1..N4) and the best-mask plain symbol
  function penalty(mods, size) {
    let s = 0; const at = (x, y) => mods[y * size + x];
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const c = pass ? at(a, b) : at(b, a), p = pass ? at(a, b - 1) : at(b - 1, a);
        if (c === p) run++; else { if (run >= 5) s += 3 + run - 5; run = 1; }
      }
      if (run >= 5) s += 3 + run - 5;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = at(x, y); if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) s += 3; }
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) {
      let f = true, r = true;
      for (let k = 0; k < 11; k++) { const c = pass ? at(a, b + k) : at(b + k, a); if (c !== p1[k]) f = false; if (c !== p1[10 - k]) r = false; }
      if (f) s += 40; if (r) s += 40;
    }
    let dark = 0; for (let i = 0; i < size * size; i++) dark += mods[i];
    s += Math.floor(Math.abs(dark / (size * size) * 100 - 50) / 5) * 10;
    return s;
  }
  function encodePlainBest(text, ver, level) {
    let best = null;
    for (let m = 0; m < 8; m++) { const r = encodePlain(text, ver, m, level), p = penalty(r.modules, r.L.size); if (!best || p < best.p) best = { p, mask: m, L: r.L, modules: r.modules }; }
    return best;
  }

  // ---------- border-frame importance: the math hides under a frame, the picture gets the middle ----------
  function frameImportance(L) {
    const { size, N } = L, imp = new Float32Array(N);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) imp[y * size + x] = Math.min(x, y, size - 1 - x, size - 1 - y);
    return imp;
  }
  // inset of the clean picture square for a plan built with frameImportance
  function pictureInset(P) {
    const L = P.L, { size } = L; let t = 0;
    for (let i = 0; i < L.N; i++) if (P.modClass[i] === 2) { const x = i % size, y = (i / size) | 0; t = Math.max(t, Math.min(x, y, size - 1 - x, size - 1 - y)); }
    return t + 1;
  }

  const api = { layout, plan, encode, encodePlain, encodePlainAuto, fitsPlain, isAlnum, encodePlainBest, penalty, payloadCodewords, checkSyndromes, frameImportance, pictureInset, syndromesZero, EXP, LOG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiveQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
