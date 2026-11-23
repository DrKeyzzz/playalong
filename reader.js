// "Read the chart from the video": grab each page of a chart shown in a play-along video, then have
// Claude read all the pages into one chord chart (and the melody, if it's written out).
// The page can't see inside the YouTube player, so Chrome is asked to share this tab; frames are
// cropped to the player. Pages can also come from pasted screenshots, images or a PDF.
(function (root) {
  const W = 64, H = 36;

  // A page's "ink map": where the dark marks (notes, chords, lines) are, on a coarse grid.
  // Coloured highlights that move across the bars aren't ink, so they don't make it look like a new page.
  const GW = 128, GH = 72;
  function signature(src, sx, sy, sw, sh) {
    const c = document.createElement('canvas'); c.width = GW * 2; c.height = GH * 2;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    // Ink = dark on a light page, or light on a dark page (some videos use white-on-black charts).
    let lum = 0; for (let i = 0; i < d.length; i += 4) lum += d[i] + d[i + 1] + d[i + 2];
    const darkPage = lum / (d.length / 4) / 3 < 110;
    const out = new Float32Array(GW * GH);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const k = (y * c.width + x) * 4, r = d[k], gg = d[k + 1], b = d[k + 2];
      const ink = darkPage ? Math.min(r, gg, b) > 170 : Math.max(r, gg, b) < 110;
      if (ink) out[(y >> 1) * GW + (x >> 1)] += 0.25;
    }
    return out;
  }
  // 0 = the same marks, 1 = completely different.
  const diff = (a, b) => { let s = 0, t = 0; for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); t += a[i] + b[i]; } return t ? s / t : 0; };
  // Hardly any ink (a black screen, a title card): not a chart page.
  const blank = (sig) => { let t = 0; for (const v of sig) t += v; return t / sig.length < 0.01; };

  class PageCollector {
    constructor(onChange) { this.pages = []; this.prev = null; this.stableCount = 0; this.onChange = onChange || (() => {}); this.STABLE = 0.08; this.NEW = 0.2; }
    // One sample of the video (every 0.5 s). Keeps it as a page once it has held still for 1 s and isn't a page we have.
    feed(src, sx, sy, sw, sh) {
      const sig = signature(src, sx, sy, sw, sh);
      const still = this.prev && diff(sig, this.prev) < this.STABLE;
      this.prev = sig;
      this.stableCount = still ? this.stableCount + 1 : 0;
      if (this.stableCount < 2 || blank(sig)) return false;
      if (this.pages.some((p) => diff(sig, p.sig) < this.NEW)) return false;
      this.add(src, sx, sy, sw, sh, sig);
      return true;
    }
    // Keep a full-size JPEG of this frame as a page.
    add(src, sx, sy, sw, sh, sig) {
      sw = sw || src.videoWidth || src.naturalWidth || src.width; sh = sh || src.videoHeight || src.naturalHeight || src.height; sx = sx || 0; sy = sy || 0;
      const scale = Math.min(1, 1600 / sw);
      const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
      c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const page = { url: c.toDataURL('image/jpeg', 0.85), sig: sig || signature(src, sx, sy, sw, sh), w: c.width, h: c.height };
      this.pages.push(page);
      this.onChange(this.pages);
      return page;
    }
    remove(i) { this.pages.splice(i, 1); this.onChange(this.pages); }
  }

  // Share this tab and watch the YouTube player's area. rectFn() = the player's rectangle on the page.
  async function startTabCapture(collector, rectFn, onState) {
    // One shared tab capture for both this and Auto tempo.
    const stream = await root.AutoTempo.TabShare.get('reader', false);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play();
    const crop = () => {
      const r = rectFn();
      const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight; // the share is the tab's viewport, maybe scaled
      return [Math.max(0, r.left * sx), Math.max(0, r.top * sy), Math.max(1, r.width * sx), Math.max(1, r.height * sy)];
    };
    const timer = setInterval(() => {
      if (!video.videoWidth) return;
      const r = rectFn(); if (!r.width || !r.height) return;
      collector.feed(video, ...crop());
    }, 500);
    const stop = () => { clearInterval(timer); video.srcObject = null; root.AutoTempo.TabShare.release('reader'); if (onState) onState('stopped'); };
    stream.getVideoTracks()[0].addEventListener('ended', stop);
    return { stop, grab: () => { if (video.videoWidth) collector.add(video, ...crop()); } };
  }

  // PDF pages -> images (pdf.js, loaded only when needed).
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = PDFJS;
      s.onload = () => { root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(root.pdfjsLib); };
      s.onerror = () => rej(new Error('Couldn\u2019t load the PDF reader (no internet?)'));
      document.head.append(s);
    });
  }
  async function addPdf(collector, file) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let i = 1; i <= Math.min(pdf.numPages, 12); i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1600 / page.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      collector.add(c);
    }
  }
  function addImageFile(collector, file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { collector.add(img); URL.revokeObjectURL(img.src); res(); };
      img.onerror = () => rej(new Error('Not an image'));
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- reading with Claude ----------
  const PROMPT = `These images are consecutive pages of ONE chart shown in a play-along video (or scanned pages). Combine them in reading order. Ignore any page that repeats an earlier page, and anything that isn't music (title cards, logos).

Return ONLY a JSON object, no other text:
{
  "title": string,
  "time": "4/4" | "3/4" | "6/8" | "2/4" | "5/4" | "12/8" | "2/2",
  "key_root": one of C Db D Eb E F F# Gb G Ab A Bb B C#,   // concert key
  "key_minor": boolean,
  "tempo": number or null,          // only if written on the chart
  "chart_text": string,             // the chord chart in PLAY ORDER, format below
  "melody_abc": string or null,     // only if a melody is notated
  "unclear": [string]               // anything you weren't sure about, with bar numbers
}

chart_text format (one line per 4 bars is fine):
[Section name] on its own line when the chart names a section (Intro, A, Verse, Chorus...).
| C | Am7 | Dm7 G7 | C |   one bar between bar lines, one or two chords per bar.
Write chords like: C  Cmaj7  Cm7  C7  Cm7b5  Cdim7  C7b9  C7#11  C7sus4  C6  Cm6  C/E  F#m7  Bbmaj7.
Resolve % (repeat) signs to the actual chord. Write out repeats, 1st/2nd endings, D.S., D.C., Coda and Fine in the order they are played, so the bars are exactly what is played from start to end.

melody_abc: ABC v2.1 with X:, M:, L:, K: (K: is the written key, the same as the concert key), exact pitches and rhythms, chords in double quotes above the notes, repeat signs and endings as written. Use rests (z) where something can't be read.`;

  async function readWithClaude(pages, key) {
    const content = [];
    pages.forEach((p, i) => {
      content.push({ type: 'text', text: 'Page ' + (i + 1) + ':' });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.url.split(',')[1] } });
    });
    content.push({ type: 'text', text: PROMPT });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 32000, messages: [{ role: 'user', content }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude didn\u2019t send back a chart.');
    return JSON.parse(m[0]);
  }

  // Claude's answer -> a chart record for the editor.
  function toRecord(res) {
    const meters = ['4/4', '3/4', '6/8', '2/4', '5/4', '12/8', '2/2'];
    return {
      title: String(res.title || 'My chart').slice(0, 80),
      meter: meters.includes(res.time) ? res.time : '4/4',
      root: /^[A-G][b#]?$/.test(res.key_root || '') ? res.key_root : undefined,
      minor: !!res.key_minor,
      tempo: +res.tempo > 20 ? Math.round(+res.tempo) : undefined,
      text: String(res.chart_text || ''),
      melodyAbc: res.melody_abc && /K:/.test(res.melody_abc) ? String(res.melody_abc) : undefined,
      unclear: Array.isArray(res.unclear) ? res.unclear.map(String).slice(0, 20) : []
    };
  }

  root.ChartReader = { PageCollector, signature, diff, startTabCapture, addPdf, addImageFile, readWithClaude, toRecord, PROMPT };
})(typeof window !== 'undefined' ? window : globalThis);
