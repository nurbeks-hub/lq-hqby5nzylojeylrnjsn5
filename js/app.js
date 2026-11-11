// LIVE QR studio — page logic. Video -> square frame -> VQR core -> canvas; the page scans its own output all the time.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const video = $('v'), cv = $('qr'), ctx = cv.getContext('2d');
  const O = 720, BASE = window.VQR_BASE || '', FILM = !!window.__FILM;   // FILM: frame-stepped capture for the demo recording
  const srcC = document.createElement('canvas'); srcC.width = srcC.height = O; const sctx = srcC.getContext('2d', { willReadFrequently: true });
  const out = new ImageData(O, O);
  const SAMPLES = [['market', BASE + 'samples/market.mp4'], ['anime', BASE + 'samples/anime.mp4'], ['night', BASE + 'samples/night.mp4'], ['orbit', BASE + 'samples/orbit.mp4']];
  const S = { look: 'halftone', step: null, text: '', touched: false, brand: [209, 254, 23], logo: null, file: null, name: '', fmt: 'mp4', size: 720, fps: 24, busy: false, showSrc: false, err: '' };
  const enc = new VQR.Encoder({});
  const lookOf = (id) => LOOKS.find((l) => l.id === id);

  // ---------- link ----------
  const DEFAULT_LINK = 'https://higgsfield.ai';
  function normLink(raw) {
    let t = raw.trim(); if (!t) return { text: '', note: 'type the link this code should open (up to 300 characters; shorter = more picture)', bad: true, soft: true };
    if (/^\+?[\d\s().-]{7,20}$/.test(t)) t = 'tel:' + t.replace(/[^\d+]/g, '');
    if (/\s/.test(t)) return { text: '', note: 'a link cannot contain spaces', bad: true };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = 'https://' + t;
    let u; try { u = new URL(t); } catch (e) { return { text: '', note: 'this does not look like a link', bad: true }; }
    if (!['http:', 'https:', 'mailto:', 'tel:', 'sms:'].includes(u.protocol)) return { text: '', note: 'only web links (https://…), mailto: or tel: can go in the code', bad: true };
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !/\.[a-z0-9-]{2,}$/i.test(u.hostname) && u.hostname !== 'localhost') return { text: '', note: 'keep typing: the address needs a domain, like name.com', bad: true, soft: true };
    const href = u.href.replace(/^(https?:\/\/[^/]+)\/$/, '$1');                       // international names become punycode, paths are percent-encoded
    if (/[^\x20-\x7E]/.test(href)) return { text: '', note: 'this link has characters a QR code cannot carry', bad: true };
    if (href.length > 300) return { text: '', note: 'too long: ' + href.length + ' characters, 300 at most — use a short link', bad: true };
    const show = href.length > 44 ? href.slice(0, 43) + '…' : href;
    return { text: href, note: 'will open <b>' + esc(show) + '</b> · ' + href.length + ' of 300 characters' };
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- options for the encoder from look + step + link ----------
  function optsFor(lookId, step, text) {
    const L = lookOf(lookId), st = L.steps[step == null ? L.rule : step], o = Object.assign({}, VQR.DEF, L.base, st, { text, level: st.level || L.base.level || 'L' });
    if (o.color === 'minimal') { o.text = capsLink(text); return o; }   // the minimal look plans its own (smallest) code size
    o.ver = Math.max(o.ver, VQR.minVersion(text, o.level, 1));
    if (lookId === 'brand') o.brand = S.brand;
    return o;
  }
  // A link with nothing after the domain can be written in capitals: the code then fits the smallest tested grid (25 × 25).
  // Scheme and host are case-insensitive, so it is the same address; anything with a path is left exactly as typed.
  function capsLink(t) {
    try { const u = new URL(t); if (/^https?:$/.test(u.protocol) && u.pathname === '/' && !u.search && !u.hash && !u.username && !/[^\x21-\x7e]/.test(u.host)) return (u.protocol + '//' + u.host).toUpperCase(); } catch (e) { }
    return t;
  }
  function logoRect(o) {                          // module rect of the centre logo, odd-aligned so it sits on whole modules
    const n = o.ver * 4 + 17; let w = Math.round(n * (o.logoShare || 0)); if (w < 3) return null; if ((n - w) % 2) w++;
    return { x: (n - w) / 2, y: (n - w) / 2, w, h: w };
  }
  function applyOpts() {
    const o = optsFor(S.look, S.step, S.text || DEFAULT_LINK);
    o.logo = (S.look === 'brand') ? logoRect(o) : null;
    enc.set(o); enc.fresh = true; scan.reset(); spec();
  }
  // draws the brand plate (and the user's logo, if any) into a source canvas before the solver sees it
  function drawLogo(c2, size, e) {
    const lg = e.o.logo; if (!lg) return; const tot = e.n + 2 * e.o.quiet, px = size / tot, x = (lg.x + e.o.quiet) * px, y = (lg.y + e.o.quiet) * px, w = lg.w * px;
    const b = S.brand, by = VQR.luma(b[0], b[1], b[2]), ink = '#101012', col = 'rgb(' + b.join(',') + ')';
    c2.fillStyle = '#fff'; c2.fillRect(x, y, w, w);                       // one light module of air around the plate, so code shapes never touch it
    const x1 = x + px, y1 = y + px, w1 = w - 2 * px; c2.fillStyle = by >= 0.5 ? ink : '#fff'; c2.fillRect(x1, y1, w1, w1);
    if (S.logo) { const iw = S.logo.width, ih = S.logo.height, k = Math.min(w1 * 0.8 / iw, w1 * 0.8 / ih); c2.drawImage(S.logo, x1 + (w1 - iw * k) / 2, y1 + (w1 - ih * k) / 2, iw * k, ih * k); }
    else { c2.fillStyle = by >= 0.5 ? col : ink; const u = w1 / 9; for (const [gx, gy, gw, gh] of [[2, 2, 2, 2], [5, 2, 2, 2], [2, 5, 2, 2], [5, 5, 1, 1], [6, 6, 1, 1]]) c2.fillRect(x1 + gx * u, y1 + gy * u, gw * u, gh * u); }
  }
  function drawSource(c2, size) {                 // centre-crop "cover" of the current video frame
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return false; const s = Math.min(vw, vh);
    c2.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, size, size); return true;
  }

  // ---------- live loop ----------
  // The code pattern is renewed on every second video frame (the picture between the marks keeps the full frame rate):
  // a phone exposure that straddles two different codes reads nothing, so fewer code changes = more readable camera frames.
  const HOLD = 2; let holdN = 0, painted = false;
  let frames = 0, tFps = performance.now(), lastT = -1, tPaint = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    if (S.busy || document.hidden) return;
    const animated = enc.o.shape === 'liquid', newFrame = video.currentTime !== lastT;
    if (!newFrame && !(animated && now - tPaint > 33) && !enc.fresh) return;
    renderNow(now, newFrame);
  }
  function renderNow(now, newFrame) {
    if (!drawSource(sctx, O)) return;
    lastT = video.currentTime; tPaint = now;
    try {
      enc._plan(); drawLogo(sctx, O, enc);
      const src = sctx.getImageData(0, 0, O, O).data;
      if (!S.text && S.touched && !S.soft) { ctx.drawImage(srcC, 0, 0); ctx.fillStyle = 'rgba(10,10,11,.72)'; ctx.fillRect(0, 0, O, O); ctx.fillStyle = '#D1FE17'; ctx.font = '700 30px "Space Mono", ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.fillText('no link yet', O / 2, O / 2 - 8); ctx.fillStyle = '#E9E9E4'; ctx.font = '18px ui-monospace, Menlo, monospace'; ctx.fillText('fix the link in step 02 to get a code', O / 2, O / 2 + 28); }
      else if (S.showSrc) { ctx.drawImage(srcC, 0, 0); }
      else { if (enc.fresh || (newFrame && (enc.o.color === 'minimal' || ++holdN % HOLD === 0))) enc.solve(src, O); enc.paint(src, out.data, O, now / 1000); ctx.putImageData(out, 0, 0); }
      S.err = '';
    } catch (e) { S.err = e.message; }
    if (!painted && !S.err) { painted = true; scan.reset(); }
    frames++; if (now - tFps > 1000) { $('hfps').textContent = Math.round(frames * 1000 / (now - tFps)) + ' fps'; frames = 0; tFps = now; }
    if (!video.paused && video.duration) { $('seek').value = Math.round(video.currentTime / video.duration * 1000); $('tc').textContent = video.currentTime.toFixed(1) + ' / ' + video.duration.toFixed(1) + ' s'; }
  }

  // ---------- the page scans itself ----------
  const scan = (function () {
    const SIZES = [[720, 0], [300, 40], [180, 30]], hist = [[], [], []], c = document.createElement('canvas'), c2 = c.getContext('2d', { willReadFrequently: true });
    let det = null, kind = 'jsQR', i = 0, busy = false, lastText = '';
    if ('BarcodeDetector' in window) { try { det = new BarcodeDetector({ formats: ['qr_code'] }); kind = 'BarcodeDetector'; } catch (e) { det = null; } }
    async function read(canvas) {
      if (det) { try { const r = await det.detect(canvas); return r.length ? r[0].rawValue : null; } catch (e) { det = null; kind = 'jsQR'; } }
      const w = canvas.width, h = canvas.height, d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h), r = jsQR(d.data, w, h, { inversionAttempts: 'dontInvert' });
      return r ? r.data : null;
    }
    async function step() {
      if (busy || S.busy || S.showSrc || document.hidden || !video.videoWidth || !painted) return; busy = true;
      const k = i++ % 3, [sz, pad] = SIZES[k]; c.width = c.height = sz + 2 * pad; c2.fillStyle = '#101012'; c2.fillRect(0, 0, c.width, c.height);
      c2.imageSmoothingQuality = 'high'; c2.drawImage(cv, pad, pad, sz, sz);
      let t = null; try { t = await read(c); } catch (e) { t = null; }
      const ok = t === enc.o.text; if (t) lastText = t; hist[k].push(ok ? 1 : 0); if (hist[k].length > (FILM ? 14 : 30)) hist[k].shift(); busy = false; show();
    }
    function show() {
      const rate = hist.map((h) => h.length ? h.reduce((a, b) => a + b, 0) / h.length : null);
      const noLink = !S.text && S.touched && !S.soft, typing = !S.text && S.soft;
      rate.forEach((r, k) => { if (noLink || typing) r = null; const m = $('m' + k); m.querySelector('b').textContent = r == null || hist[k].length < 3 ? '—' : Math.round(r * 100) + '%'; const bar = m.querySelector('i'); bar.style.setProperty('--w', (r || 0) * 100 + '%'); bar.style.setProperty('--c', r == null || r >= 0.9 ? 'var(--lime)' : r >= 0.5 ? '#FFC83D' : 'var(--bad)'); });
      { const Lm = lookOf(S.look), cs = S.step == null ? Lm.rule : S.step, mm = Lm.notes && Lm.notes[cs] && /(\d+)% in the phone model/.exec(Lm.notes[cs]), m3 = $('m3'); if (m3) { const pv = mm && !noLink && !typing ? +mm[1] / 100 : null; m3.querySelector('b').textContent = pv == null ? '—' : Math.round(pv * 100) + '%'; const bar = m3.querySelector('i'); bar.style.setProperty('--w', (pv || 0) * 100 + '%'); bar.style.setProperty('--c', pv == null || pv >= 0.9 ? 'var(--lime)' : pv >= 0.6 ? '#FFC83D' : 'var(--bad)'); } }
      const v = $('verdict'); if (noLink) { v.dataset.s = 'bad'; $('vword').textContent = 'NO LINK'; $('vtext').textContent = 'the link in step 02 is not valid yet — nothing to scan'; return; }
      if (typing) { v.dataset.s = 'wait'; $('vword').textContent = 'WAIT'; $('vtext').textContent = 'keep typing the link…'; return; }
      if (hist[0].length < 1) { v.dataset.s = 'wait'; $('vword').textContent = 'WAIT'; $('vtext').textContent = 'scanning…'; return; }
      const got = rate.filter((r) => r != null), worst = Math.min(...got), best = Math.max(...got);
      const Lk = lookOf(S.look), curStep = S.step == null ? Lk.rule : S.step, under = curStep < Lk.rule;   // steps left of the tested default failed the phone-camera test, whatever this page reads
      const enough = hist.every((h) => h.length >= 6) || FILM;
      const live = S.err ? 'bad' : (worst >= 0.8 || !enough) ? 'ok' : best >= 0.5 ? 'mid' : 'bad', s = live === 'ok' && under ? 'mid' : live;
      v.dataset.s = s; $('vword').textContent = s === 'ok' ? 'SCANS' : s === 'mid' ? 'RISKY' : 'NO SCAN';
      const shown = !S.text ? 'sample link — type yours in step 02' : enc.o.text.length > 40 ? enc.o.text.slice(0, 39) + '…' : enc.o.text; $('vtext').title = enc.o.text;
      $('vtext').textContent = S.err ? S.err : s === 'ok' ? '→ ' + shown : s === 'mid' ? (live === 'ok' ? 'reads here, but this step failed the phone test below — move step 04 right' : 'this video reads ' + Math.round(worst * 100) + '% at the ' + ['full', 'small', 'tiny'][rate.indexOf(worst)] + ' size — fine up close; for small or far codes move step 04 right') : 'scanners lose it — move step 04 toward safe';
      $('scanhint').innerHTML = '<b>live:</b> the page shrinks its code to three sizes and scans it; SCANS = each reads 8+ of 10 frames.<br><b>phone test (lab):</b> our stored result for this look and step with a simulated phone camera.';
    }
    if (!FILM) setInterval(step, 110);
    return { step, reset() { hist.forEach((h) => { h.length = 0; }); show(); }, read, get kind() { return kind; } };
  })();

  // ---------- look tiles (each tile is the real encoder on the current frame) ----------
  const tiles = []; let tileStep = () => {};
  function buildLooks() {
    const box = $('looks');
    LOOKS.forEach((L) => {
      const b = document.createElement('button'); b.className = 'look'; b.dataset.id = L.id; b.innerHTML = '<canvas width="132" height="132"></canvas><span>' + L.name + '</span>'; box.appendChild(b);
      b.onclick = () => { S.look = L.id; S.step = null; applyOpts(); ui(); };
      tiles.push({ L, c: b.querySelector('canvas'), e: new VQR.Encoder({}) });
    });
    const tc = document.createElement('canvas'); tc.width = tc.height = 132; const t2 = tc.getContext('2d', { willReadFrequently: true }), img = new ImageData(132, 132); let k = 0;
    tileStep = () => {
      if (S.busy || document.hidden || !video.videoWidth) return; const T = tiles[k++ % tiles.length];
      try {
        const o = optsFor(T.L.id, null, 'https://x.co'); o.ver = Math.min(o.ver, 4); o.quiet = 2; o.logo = T.L.id === 'brand' ? logoRect(o) : null; T.e.set(o); T.e.fresh = true; T.e._plan();
        drawSource(t2, 132); if (o.logo) { const keep = enc; drawLogo(t2, 132, T.e); }
        const d = t2.getImageData(0, 0, 132, 132).data; T.e.render(d, img.data, 132, performance.now() / 1000); T.c.getContext('2d').putImageData(img, 0, 0);
      } catch (e) { /* tile preview only */ }
    };
    if (!FILM) setInterval(tileStep, 140);
  }
  function buildSteps() {
    const box = $('steps'); box.innerHTML = '';
    const L = lookOf(S.look), cur = S.step == null ? L.rule : S.step;
    for (let i = 0; i < 5; i++) { const b = document.createElement('button'); b.textContent = i === 0 ? '1 pic' : i === 4 ? '5 safe' : String(i + 1); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', i === cur); b.setAttribute('aria-label', 'step ' + (i + 1) + ' of 5' + (i === L.rule ? ', tested default' : '')); if (i === cur) b.className = 'on'; if (i === L.rule) b.classList.add('rule'); b.onclick = () => { S.step = i; applyOpts(); ui(); }; box.appendChild(b); }
    const ph = (L.notes && L.notes[cur] && /(\d+)% in the phone model/.exec(L.notes[cur])) ? +/(\d+)% in the phone model/.exec(L.notes[cur])[1] : null;
    const mini = L.base.color === 'minimal', longLink = !mini && enc.o && enc.o.ver > (L.steps[cur].ver || 0);
    $('stephint').innerHTML = (cur === L.rule ? '<span class="ok">●</span> tested default for this look: the most picture that every scanner still read' + (ph != null ? '. In our phone-camera test ' + ph + '% of frames were read.' : '.')
      : cur < L.rule ? 'more picture than the tested default' + (ph != null ? '. In our phone-camera test only ' + ph + '% of frames were read.' : '. It can scan here and still fail on a phone.')
      : 'less picture, more margin for small, far or printed codes' + (ph != null ? '. Phone-camera test: ' + ph + '% of frames read.' : '.'))
      + (mini ? (enc.o.ver > 2 ? ' <span class="bad">Long link:</span> the grid grew to ' + enc.n + ' × ' + enc.n + ' — a link with nothing after the domain keeps it 25 × 25.' : enc.o.text !== (S.text || DEFAULT_LINK) ? ' The link is written in capitals to keep the grid at 25 × 25 — same address; check that your phone opens it.' : '') : enc.freeShare < 0.38 || longLink ? ' <span class="bad">Long link:</span> it takes most of the code, only ' + Math.round(enc.freeShare * 100) + '% is left for the picture — a short link looks better.' : '');
  }
  function ui() {
    document.querySelectorAll('.look').forEach((b) => b.classList.toggle('on', b.dataset.id === S.look));
    $('brandopts').hidden = S.look !== 'brand'; try { enc._plan(); } catch (e) { /* shown elsewhere */ } buildSteps();
    document.querySelectorAll('#fmt .btn').forEach((b) => b.classList.toggle('on', b.dataset.f === S.fmt));
    const gif = S.fmt === 'gif'; document.querySelectorAll('#size button').forEach((b) => { const v = +b.dataset.s; b.textContent = gif ? (v === 720 ? '360' : '480') : v; b.classList.toggle('on', v === S.size); });
    document.querySelectorAll('#fps button').forEach((b) => { const v = +b.dataset.s; b.textContent = gif ? (v === 24 ? '10' : '15') : v; b.classList.toggle('on', v === S.fps); });
    $('go').classList.toggle('off', !S.text && !S.busy);
    if (!S.busy) $('go').textContent = !S.text ? (S.touched ? 'fix the link to export' : 'type your link to export') : 'export ' + (S.fmt === 'png' ? 'PNG sequence' : S.fmt.toUpperCase());
  }
  setInterval(() => { if (enc.o.color === 'minimal' && !S.busy) spec(); }, 1000);   // the minimal look's dot count follows the picture
  function spec() {
    try { enc._plan(); } catch (e) { S.err = e.message; return; }
    const o = enc.o, n = enc.n, rows = o.color === 'minimal' ? [['grid', n + ' × ' + n + ' cells'], ['dots drawn', (enc.info.dots || '—') + ' of ' + n * n + ' cells, each ' + Math.round(o.dot * 100) + '% of its cell'], ['code changes', 'never — only the dots follow the picture'], ['link as written', o.text], ['error correction', 'level ' + o.level]] : [['grid', n + ' × ' + n + ' squares'], ['picture share', Math.round(enc.freeShare * 100) + '% of the code'], ['code changes', 'every 2nd frame'], ['link length', o.text.length + ' characters'], ['error correction', 'level ' + o.level + ', left untouched']];
    $('spec').innerHTML = rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + esc(String(r[1])) + '</dd>').join('');
  }

  // ---------- video in ----------
  function loadVideo(url, name, file) {
    S.file = file || null; S.name = name; video.src = url; video.loop = true; video.muted = true;
    video.onloadedmetadata = () => { $('exphint').className = 'hint'; $('exphint').textContent = expNote(); $('fname').textContent = name; if (file) document.querySelectorAll('#samples button').forEach((b) => b.classList.remove('on')); $('fmeta').textContent = video.videoWidth + '×' + video.videoHeight + ' · ' + video.duration.toFixed(1) + ' s' + (video.duration > 30 ? ' · export takes the first 30 s' : ''); enc.fresh = true; scan.reset(); if (!FILM) video.play().catch(() => {}); $('play').textContent = 'pause'; };
    video.onerror = () => { $('fname').textContent = 'this file cannot be played here'; $('fmeta').textContent = 'try mp4 (H.264) or webm'; };
  }
  // Samples are downloaded whole first (two tries), so the old video keeps playing until the new one is ready
  // and a stalled or deferred network load can never leave a blank thumbnail under the wrong label.
  const sampleBlob = {}; let sampleReq = 0, sampleOn = 0;
  async function loadSample(i) {
    const [n, u] = SAMPLES[i], req = ++sampleReq, mark = (k) => document.querySelectorAll('#samples button').forEach((x, j) => x.classList.toggle('on', j === k));
    mark(i); $('fname').textContent = 'loading ' + n + '…';
    for (let attempt = 0; attempt < 2 && !sampleBlob[i]; attempt++) {
      try { const r = await fetch(u, { cache: attempt ? 'reload' : 'default' }); if (!r.ok) throw new Error(r.status); const bl = await r.blob(); if (bl.size < 1000) throw new Error('empty'); sampleBlob[i] = URL.createObjectURL(new Blob([bl], { type: 'video/mp4' })); } catch (e) { }
    }
    if (req !== sampleReq) return;
    if (!sampleBlob[i]) { mark(S.file ? -1 : sampleOn); $('fname').textContent = S.name || 'drop a video here'; $('fmeta').textContent = 'could not load "' + n + '" — check the connection and click again'; return; }
    sampleOn = i; loadVideo(sampleBlob[i], n + ' (sample)', null);
  }
  function takeFile(f) { if (!f) return; sampleReq++; if (!/^video\//.test(f.type) && !/\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name)) { $('fname').textContent = 'that is not a video'; $('fmeta').textContent = 'drop an mp4, mov or webm'; return; } document.querySelectorAll('#samples button').forEach((b) => b.classList.remove('on')); loadVideo(URL.createObjectURL(f), f.name, f); }
  $('file').onchange = (e) => takeFile(e.target.files[0]);
  let dragN = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; document.body.classList.add('drag'); });
  addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drag'); } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; document.body.classList.remove('drag'); takeFile(e.dataTransfer.files[0]); });
  SAMPLES.forEach(([n, u], i) => { const b = document.createElement('button'); b.textContent = n; b.onclick = () => loadSample(i); $('samples').appendChild(b); if (i === 0) b.classList.add('on'); });

  // ---------- controls ----------
  let linkT = 0; const linkNow = () => { const r = normLink($('link').value); const empty = !$('link').value.trim(); $('linkhint').innerHTML = r.bad ? (r.soft ? r.note : '<span class="bad">' + r.note + '</span>') : (r.note || '&nbsp;'); S.text = r.text; S.touched = !empty; S.soft = !!r.soft && !empty; applyOpts(); ui(); };
  $('link').addEventListener('input', () => { clearTimeout(linkT); if (FILM || $('link').value.length < 80) linkNow(); else linkT = setTimeout(linkNow, 180); });
  $('play').onclick = () => { if (video.paused) { video.play(); $('play').textContent = 'pause'; } else { video.pause(); $('play').textContent = 'play'; } };
  $('seek').oninput = () => { if (video.duration) { video.currentTime = $('seek').value / 1000 * video.duration; $('tc').textContent = video.currentTime.toFixed(1) + ' / ' + video.duration.toFixed(1) + ' s'; } };
  addEventListener('keydown', (e) => { if (e.code === 'Space' && !/^(INPUT|BUTTON|TEXTAREA|SUMMARY)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('play').click(); } });
  const cmp = $('cmp'); const src = (v) => { S.showSrc = v; enc.fresh = true; };
  cmp.onpointerdown = () => src(true); cmp.onpointerup = cmp.onpointerleave = () => src(false);
  cmp.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') src(true); }; cmp.onkeyup = () => src(false);
  $('bcolor').oninput = (e) => { const h = e.target.value; S.brand = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); applyOpts(); };
  $('blogo').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const im = new Image(); im.onload = () => { S.logo = im; $('blogoT').textContent = 'logo ✓'; enc.fresh = true; }; im.src = URL.createObjectURL(f); };
  const expNote = () => S.fmt === 'png' ? 'a zip of PNG frames — large: roughly ' + Math.max(1, Math.round(Math.min(video.duration || 4, 30) * S.fps * (S.size === 1080 ? 1.3 : 0.6))) + ' MB' : S.fmt === 'gif' ? 'GIF: small and silent — 360 or 480 px, 10 or 15 fps, first 8 s' : 'every exported frame is scanned before it is written · MP4 keeps the sound, if the video has one';
  document.querySelectorAll('#fmt .btn').forEach((b) => b.onclick = () => { S.fmt = b.dataset.f; if (!S.busy) { $('exphint').className = 'hint'; $('exphint').textContent = expNote(); } ui(); });
  document.querySelectorAll('#size button').forEach((b) => b.onclick = () => { S.size = +b.dataset.s; ui(); });
  document.querySelectorAll('#fps button').forEach((b) => b.onclick = () => { S.fps = +b.dataset.s; ui(); });
  const save = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); };
  const stem = () => 'liveqr-' + S.look + '-' + (S.name || 'video').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  $('still').onclick = () => cv.toBlob((b) => save(b, stem() + '.png'), 'image/png');

  // ---------- export: offline, frame by frame, every frame scanned ----------
  const seekTo = (t) => new Promise((res) => { if (Math.abs(video.currentTime - t) < 1e-3) return res(); const done = () => { video.removeEventListener('seeked', done); res(); }; video.addEventListener('seeked', done); video.currentTime = t; setTimeout(done, 2500); });
  async function runExport() {
    if (S.busy) { S.cancel = true; return; }
    if (!video.videoWidth) { $('exphint').innerHTML = '<span class="bad">add a video first</span>'; return; }
    if (!S.text) { $('exphint').innerHTML = '<span class="bad">' + (S.touched ? 'fix the link in step 02 first' : 'type your own link in step 02 first — the code now carries a sample link') + '</span>'; $('link').focus(); $('link').select(); return; }
    const gif = S.fmt === 'gif', size = gif ? (S.size === 720 ? 360 : 480) : S.size, fps = gif ? (S.fps === 24 ? 10 : 15) : S.fps;
    const dur = Math.min(video.duration, gif ? 8 : 30), total = Math.max(1, Math.round(dur * fps));
    S.busy = true; S.cancel = false; const wasPaused = video.paused, t0 = video.currentTime; video.pause();
    $('go').textContent = 'cancel'; $('exphint').className = 'hint'; $('prog').hidden = false; $('bar').style.width = '0';
    const ec = document.createElement('canvas'); ec.width = ec.height = size; const e2 = ec.getContext('2d', { willReadFrequently: true });
    const sc = document.createElement('canvas'); sc.width = sc.height = size; const s2 = sc.getContext('2d', { willReadFrequently: true });
    const vc = document.createElement('canvas'); vc.width = vc.height = 360; const v2 = vc.getContext('2d', { willReadFrequently: true });
    const e = new VQR.Encoder(Object.assign({}, enc.o)), img = new ImageData(size, size); let ok = 0, n = 0, res = null;
    try {
      let W = null; const zip = S.fmt === 'png' ? new VQRExport.Zip() : null, g = gif ? new VQRExport.Gif(size, size, fps) : null;
      if (S.fmt === 'mp4') W = await VQRExport.mp4Writer(ec, fps, S.file, dur);
      for (let i = 0; i < total && !S.cancel; i++) {
        await seekTo(Math.min(i / fps, Math.max(0, video.duration - 0.001)));
        drawSource(s2, size); e._plan(); drawLogo(s2, size, e);
        const d = s2.getImageData(0, 0, size, size).data; if (i % HOLD === 0 || e.o.color === 'minimal') e.solve(d, size); e.paint(d, img.data, size, i / fps); e2.putImageData(img, 0, 0);
        v2.fillStyle = '#101012'; v2.fillRect(0, 0, 360, 360); v2.drawImage(ec, 30, 30, 300, 300);
        let t = null; try { t = await scan.read(vc); } catch (x) { t = null; } if (t === e.o.text) ok++; n++;
        if (W) await W.add(i / fps); else if (g) g.add(img.data); else zip.add('frame_' + String(i + 1).padStart(4, '0') + '.png', new Uint8Array(await (await new Promise((r) => ec.toBlob(r, 'image/png'))).arrayBuffer()));
        if (window.__filmGate) await window.__filmGate(i, total);
        if (i % 3 === 0) { $('bar').style.width = (i + 1) / total * 100 + '%'; $('exphint').innerHTML = 'frame <b>' + (i + 1) + ' / ' + total + '</b> · scanned ok <b>' + ok + '</b>'; ctx.drawImage(ec, 0, 0, O, O); await new Promise((r) => setTimeout(r, 0)); }
      }
      if (!S.cancel) {
        if (W) { const r = await W.finish(); save(r.blob, stem() + '-' + size + 'p' + fps + '.' + W.ext); res = W.ext.toUpperCase() + (r.sound ? ' with the source sound' : ' (this video has no sound)'); }
        else if (g) { save(g.blob(), stem() + '-' + size + 'p' + fps + '.gif'); res = 'GIF'; }
        else { save(zip.blob(), stem() + '-' + size + 'p' + fps + '-png.zip'); res = 'PNG sequence (zip)'; }
      }
      $('bar').style.width = '100%';
      $('exphint').className = S.cancel ? 'hint' : 'hint done';
    $('exphint').innerHTML = S.cancel ? 'cancelled' : '<strong class="' + (ok === n ? 'ok' : 'bad') + '">' + (ok === n ? '✓ ' : '! ') + ok + ' of ' + n + ' frames scanned OK</strong>saved ' + res + ' · ' + size + ' px, ' + fps + ' fps' + (ok < n ? ' — move step 04 right for a safer code' : '');
    } catch (x) { $('exphint').innerHTML = '<span class="bad">export failed: ' + esc(x.message || String(x)) + '</span>'; }
    S.busy = false; ui(); setTimeout(() => { $('prog').hidden = true; }, 1200);
    video.currentTime = t0; if (!wasPaused) video.play().catch(() => {}); enc.fresh = true;
  }
  $('go').onclick = runExport;

  // ---------- start ----------
  $('link').value = ''; $('link').placeholder = DEFAULT_LINK + '  ← sample, type yours'; buildLooks(); applyOpts(); ui();
  if (FILM) loadVideo(SAMPLES[0][1], SAMPLES[0][0] + ' (sample)', null); else loadSample(0);
  if (!FILM) requestAnimationFrame(tick);
  // frame-stepped drive (demo recording): one call = seek, render, self-scan at one size, refresh one look tile
  const film = { async frame(t, now) { if (!S.busy) { if (video.duration) await seekTo(t % (video.duration - 0.05)); renderNow(now * 1000, true); await scan.step(); tileStep(); $('hfps').textContent = '30 fps'; if (video.duration) { $('seek').value = Math.round(video.currentTime / video.duration * 1000); $('tc').textContent = video.currentTime.toFixed(1) + ' / ' + video.duration.toFixed(1) + ' s'; } } } };
  window.__vqr = { S, enc, scan, applyOpts, ui, runExport, optsFor, film, takeFile };   // for automated checks
})();
