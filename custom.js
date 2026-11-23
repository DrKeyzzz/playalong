// "Make your own chart": chord charts typed by hand, for songs that aren't in the book.
// A chart is turned into ABC (chords over rests), so everything chord-based works: Solos, Scales,
// the Key menu, the big now/next chord, and all the syncing. Saved in this browser only.
(function (root) {
  const { Chords } = root;
  const METERS = { '4/4': [4, '1/4'], '3/4': [3, '1/4'], '2/4': [2, '1/4'], '5/4': [5, '1/4'], '6/8': [6, '1/8'], '12/8': [12, '1/8'], '2/2': [4, '1/4'] };
  const isRepeatTok = (t) => t === '%' || t === '/' || t === '-' || t === '–';

  // Text -> bars. Lines like "| A | Bm7 | C#m7 Bm7 | % |", optional "[Verse]" lines, and "x4" after a line to repeat it.
  function parse(text) {
    const bars = [], errors = [];
    let label = null;
    String(text || '').split(/\r?\n/).forEach((raw, ln) => {
      let line = raw.trim();
      if (!line) return;
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) { label = sec[1].trim(); return; }
      let times = 1;
      const rep = /(?:\|\s*)?[x×]\s*(\d+)\s*$/i.exec(line);
      if (rep) { times = Math.min(16, Math.max(1, +rep[1])); line = line.slice(0, rep.index).trim(); }
      let segs = line.split('|');
      if (segs.length && !segs[0].trim()) segs = segs.slice(1);
      if (segs.length && !segs[segs.length - 1].trim()) segs = segs.slice(0, -1);
      const lineBars = [];
      segs.forEach((seg) => {
        if (seg === '') return; // "||": just a double bar line
        const toks = seg.trim().split(/\s+/).filter(Boolean);
        const chords = [], bad = [];
        for (const t of toks) {
          if (isRepeatTok(t)) continue;
          if (Chords.parseChord(t)) chords.push(t); else { bad.push(t); errors.push({ line: ln + 1, token: t }); }
        }
        lineBars.push({ chords, bad, toks });
      });
      for (let k = 0; k < times; k++) lineBars.forEach((b, i) => bars.push({ chords: b.chords.slice(), bad: k ? [] : b.bad, toks: b.toks, label: k === 0 && i === 0 ? label : null }));
      label = null;
    });
    return { bars, errors };
  }

  // Bars -> ABC: each bar is rests with the chord symbols on them (one, two or more chords split the bar).
  function toAbc(rec) {
    const [beats, unit] = METERS[rec.meter] || METERS['4/4'];
    const { bars } = parse(rec.text);
    const body = bars.map((b) => {
      const n = Math.max(1, b.chords.length);
      const lens = [];
      for (let i = 0; i < n; i++) lens.push(Math.floor(beats / n) + (i < beats % n ? 1 : 0));
      const lab = b.label ? '"^' + b.label.replace(/"/g, "'") + '"' : '';
      if (!b.chords.length) return lab + 'z' + beats;
      return b.chords.map((c, i) => (i === 0 ? lab : '') + '"' + c.replace(/"/g, '') + '"z' + lens[i]).join(' ');
    });
    const lines = [];
    for (let i = 0; i < body.length; i += 4) lines.push(body.slice(i, i + 4).join(' | ') + ' |');
    return 'X:1\nT:' + (rec.title || 'My chart') + '\nM:' + (rec.meter || '4/4') + '\nL:' + unit + '\nK:C\n' + (lines.join('\n') || 'z' + beats + ' |') + ']';
  }

  // Guess the key from the first chord (root, and minor if it's a minor chord).
  function guessKey(text) {
    const first = parse(text).bars.find((b) => b.chords.length);
    const p = first && Chords.parseChord(first.chords[0]);
    if (!p) return { root: 'C', minor: false };
    const root = p.letter + (p.acc === 1 ? '#' : p.acc === -1 ? 'b' : '');
    return { root, minor: /^(-|m(?!aj)|min)/.test(p.quality) };
  }

  function toTune(rec) {
    const { bars } = parse(rec.text);
    return {
      id: rec.id, title: rec.title || 'My chart', composer: 'My chart', custom: true,
      key: (rec.root || 'C') + (rec.minor ? 'm' : ''), tempo: +rec.tempo || 100,
      names: [rec.title || 'My chart'], chords: bars.flatMap((b) => b.chords),
      // A melody read from the chart (ABC) is used as is; otherwise chords over rests.
      abc: rec.melodyAbc ? (/^X:/m.test(rec.melodyAbc) ? rec.melodyAbc : 'X:1\n' + rec.melodyAbc) : toAbc(rec),
      melody: !!rec.melodyAbc
    };
  }

  const PREFIX = 'custom:';
  function all() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(PREFIX)) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch {} } } } catch {}
    return out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  function save(rec) {
    if (!rec.id) rec.id = 'my_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rec.saved = Date.now();
    try { localStorage.setItem(PREFIX + rec.id, JSON.stringify(rec)); } catch {}
    return rec;
  }
  function get(id) { try { return JSON.parse(localStorage.getItem(PREFIX + id)); } catch { return null; } }
  function exportJson() { return JSON.stringify({ type: 'play-along-charts', version: 1, charts: all() }, null, 1); }
  function importJson(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.charts || [];
    let n = 0;
    for (const rec of list) { if (rec && rec.text != null && rec.id && /^my_[\w]+$/.test(rec.id)) { save(rec); n++; } }
    return n;
  }

  root.CustomCharts = { METERS, parse, toAbc, toTune, guessKey, all, save, get, exportJson, importJson };
})(typeof window !== 'undefined' ? window : globalThis);
