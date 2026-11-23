// Sheet-music view: re-engraves the lead sheet (ABC from Claude) for Concert, Eb and Bb,
// and follows along using the tempo plus a tap on beat 1.
(function (root) {
  const { Chords } = root;
  const ABCJS = root.ABCJS;

  // Written = concert + these semitones. Each transposing instrument has two octave choices; we pick the one
  // that keeps the melody closest to the middle of the staff.
  const OCTAVE_CHOICES = { concert: [0], eb: [9, -3], bb: [2, -10] };
  const NO_SHIFT = { letterSteps: 0, semitones: 0 };

  // We transpose chord symbols ourselves (the engraver mis-spells some) and mark them so it leaves them alone.
  function withChordsFor(abc, inst, shift) {
    shift = shift || NO_SHIFT;
    const I = Chords.INSTRUMENTS[inst] || Chords.INSTRUMENTS.concert;
    const lines = abc.split('\n');
    let body = false;
    return lines
      .map((line) => {
        if (!body) {
          if (/^K:/.test(line)) body = true;
          return line;
        }
        if (/^[A-Za-z]:/.test(line) || line.startsWith('%')) return line;
        return line.replace(/"([^"]*)"/g, (m, txt) => {
          if (/^[\^_<>@]/.test(txt)) return m; // already an annotation
          const t = txt.split(/\s+/).map((c) => Chords.pretty(Chords.transposeInterval(c, I.letterSteps + shift.letterSteps, I.semitones + shift.semitones))).join(' ');
          // A zero-width space in front keeps it a normal chord symbol that the engraver won't re-transpose.
          // "6/9" would be read as a bass note, so use a fraction slash for number/number.
          return '"\u200b' + t.replace(/"/g, "'").replace(/(\d)\/(\d)/g, '$1\u2044$2') + '"';
        });
      })
      .join('\n');
  }

  function averagePitch(visualObj) {
    let sum = 0, n = 0;
    for (const line of visualObj.lines || []) for (const st of line.staff || []) for (const v of st.voices || []) for (const el of v) {
      if (el.el_type === 'note' && el.pitches) for (const p of el.pitches) { sum += p.pitch; n++; }
    }
    return n ? sum / n : 6;
  }

  function engrave(target, abc, transpose, staffwidth, perLine) {
    const opts = {
      visualTranspose: transpose,
      add_classes: true,
      staffwidth: Math.max(300, staffwidth),
      paddingleft: 6, paddingright: 6, paddingtop: 4, paddingbottom: 4,
      scale: 1,
      // Hand-lettered "Real Book" font for chords and text (falls back to Helvetica until it has loaded).
      format: { annotationfont: 'PetalumaScript 16', gchordfont: 'PetalumaScript 19', titlefont: 'PetalumaScript 22', composerfont: 'PetalumaScript 13', partsfont: 'PetalumaScript 17', measurefont: 'PetalumaScript 11' }
    };
    if (perLine) opts.wrap = { minSpacing: 1.6, maxSpacing: 2.8, preferredMeasuresPerLine: perLine };
    return ABCJS.renderAbc(target, abc, opts)[0];
  }

  function svgSize(target) {
    const svg = target.querySelector('svg');
    if (!svg) return null;
    const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
    return w && h ? { svg, w, h } : null;
  }

  class NotationView {
    constructor(chart, panelsEl, instruments, meta, shift) {
      this.chart = chart;
      this.qpm = chart.tempo_bpm || readQ(chart.abc) || 120;
      this.t0 = null; // video time of beat 1, bar 1
      this.panels = [];
      this.lastIdx = -1;
      this.mode = 'fit';
      this.view = 'head'; // 'head' = sheet music, 'solo' = chord chart with scales
      this.shift = shift || NO_SHIFT;

      for (const inst of instruments) {
        const section = document.createElement('section');
        section.className = 'pac-npanel pac-' + inst;
        const label = document.createElement('div');
        label.className = 'pac-label';
        label.textContent = meta[inst].label;
        if (meta[inst].sub) { const s = document.createElement('span'); s.className = 'pac-sub'; s.textContent = ' ' + meta[inst].sub; label.append(s); }
        const paper = document.createElement('div');
        paper.className = 'pac-paper';
        const target = document.createElement('div');
        paper.append(target);
        // Big "now / next" chord, readable from the back of the room.
        const strip = document.createElement('div');
        strip.className = 'pac-strip';
        const now = document.createElement('span'); now.className = 'pac-cnow';
        const next = document.createElement('span'); next.className = 'pac-cnext';
        strip.append(now, next);
        // Solo view: the changes as a chord chart, 4 bars to a row, with a scale for each chord.
        const solo = document.createElement('div');
        solo.className = 'pac-solo'; solo.hidden = true;
        const scales = document.createElement('div');
        scales.className = 'pac-scales'; scales.hidden = true;
        section.append(label, strip, paper, solo, scales);
        panelsEl.append(section);
        const pnl = { inst, section, paper, target, now, next, solo, scales };
        const hoverBox = document.createElement('div'); hoverBox.className = 'pac-barhover'; hoverBox.hidden = true;
        paper.style.position = 'relative'; paper.append(hoverBox);
        pnl.hoverBox = hoverBox;
        let raf = 0;
        paper.addEventListener('pointermove', (ev) => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; this.paperHover(pnl, ev); }); });
        paper.addEventListener('pointerleave', () => { hoverBox.hidden = true; });
        paper.addEventListener('pointerdown', (ev) => { if (this.paperClick(pnl, ev)) { this.flashBar(pnl); ev.preventDefault(); ev.stopPropagation(); } });
        this.panels.push(pnl);
      }
      this.prepare();
      this.render();
    }

    // Works out each part's ABC and how far to move its notes (instrument + chosen key, best octave).
    prepare() {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;width:800px';
      document.body.appendChild(probe);
      const concertPitch = averagePitch(engrave(probe, this.chart.abc, 0, 800, 4));
      probe.remove();
      for (const p of this.panels) {
        let transpose = 0, best = Infinity;
        for (const c of OCTAVE_CHOICES[p.inst] || [0]) {
          const semis = c + this.shift.semitones;
          const d = Math.abs(concertPitch + Math.round((semis * 7) / 12) - 6); // 6 = middle line (B4) in abcjs pitch steps
          if (d < best) { best = d; transpose = semis; }
        }
        p.transpose = transpose;
        p.abc = withChordsFor(this.chart.abc, p.inst, this.shift);
      }
    }

    // Moves the whole tune to another key (keeps the sync).
    setShift(shift) {
      this.shift = shift || NO_SHIFT;
      this.prepare();
      this.render();
    }

    // mode 'fit': the whole tune fits the panel with no scrolling (bars per line chosen to fill it best).
    // mode 'scroll': bigger notation that scrolls itself to keep up with the music.
    render() {
      for (const p of this.panels) {
        const W = Math.max(200, p.paper.clientWidth - 10), H = Math.max(150, p.paper.clientHeight - 10);
        if (this.mode === 'fit') {
          let best = null;
          for (const perLine of [3, 4, 5, 6, 8]) {
            engrave(p.target, p.abc, p.transpose, 165 * perLine, perLine);
            const sz = svgSize(p.target);
            if (!sz) continue;
            const scale = Math.min(W / sz.w, H / sz.h);
            if (!best || scale > best.scale) best = { perLine, scale };
          }
          p.vo = engrave(p.target, p.abc, p.transpose, 165 * (best ? best.perLine : 4), best ? best.perLine : 4);
          const sz = svgSize(p.target);
          if (sz) {
            const scale = Math.min(W / sz.w, H / sz.h);
            sz.svg.setAttribute('viewBox', `0 0 ${sz.w} ${sz.h}`);
            sz.svg.style.width = Math.floor(sz.w * scale) + 'px';
            sz.svg.style.height = Math.floor(sz.h * scale) + 'px';
          }
          p.paper.classList.add('pac-fit');
        } else {
          const z = this.zoom || 1;
          p.vo = engrave(p.target, p.abc, p.transpose, W / z - 20, W / z > 900 ? 6 : 4);
          const sz = svgSize(p.target);
          if (sz && z !== 1) {
            sz.svg.setAttribute('viewBox', `0 0 ${sz.w} ${sz.h}`);
            sz.svg.style.width = Math.floor(sz.w * z) + 'px';
            sz.svg.style.height = Math.floor(sz.h * z) + 'px';
          }
          p.paper.classList.remove('pac-fit');
        }
      }
      this.retime();
    }

    // The chord chart for one part, in playing order (repeats written out), one box per bar.
    buildSolo(p) {
      const nBars = this.barsPerChorus();
      const bars = Array.from({ length: nBars }, () => []);
      const starts = [];
      let carry = '';
      const carried = new Array(nBars).fill('');
      p.events.forEach((e, i) => {
        const b = Math.floor((e.milliseconds - this.pickupMs) / this.barMs + 1e-6);
        const c = p.chordAt[i];
        if (b < 0) { if (c) carry = c; return; }
        if (b >= nBars) return;
        if (c && bars[b][bars[b].length - 1] !== c) { bars[b].push(c); (starts[b] = starts[b] || []).push(e.milliseconds); }
      });
      const firstCarry = carry;
      for (let b = 0; b < nBars; b++) {
        if (bars[b].length) carry = bars[b][bars[b].length - 1];
        else carried[b] = carry;
      }
      // Unique chords in order of first appearance, with the bars they're in (for the Scales view).
      p.uniq = new Map();
      if (firstCarry && !bars[0].length) p.uniq.set(firstCarry, [1]);
      bars.forEach((list, b) => { for (const c of list) { if (!p.uniq.has(c)) p.uniq.set(c, []); const a = p.uniq.get(c); if (a[a.length - 1] !== b + 1) a.push(b + 1); } });
      p.scalesBuilt = false;
      p.barLists = bars.map((l, b) => (l.length ? l : carried[b] ? [carried[b]] : []));
      const grid = document.createElement('div');
      grid.className = 'pac-sgrid';
      p.sbars = [];
      for (let b = 0; b < nBars; b++) {
        const box = document.createElement('div');
        box.className = 'pac-sbar' + (bars[b].length > 1 ? ' two' : '');
        const num = document.createElement('span'); num.className = 'pac-snum'; num.textContent = b + 1;
        box.append(num);
        const list = bars[b].length ? bars[b] : carried[b] ? [carried[b]] : [];
        for (const c of list) {
          const cell = document.createElement('div');
          cell.className = 'pac-schord' + (bars[b].length ? '' : ' carry');
          const name = document.createElement('b'); name.textContent = c;
          cell.append(name);
          const sc = scaleFor(c);
          if (sc) { const s2 = document.createElement('small'); s2.textContent = sc; cell.append(s2); }
          box.append(cell);
        }
        // Click a bar (or one of its chords) while it plays: that spot starts now.
        const barStart = this.pickupMs + b * this.barMs;
        box.addEventListener('pointerdown', (ev) => {
          const cell = ev.target.closest('.pac-schord');
          const j = cell ? [...box.querySelectorAll('.pac-schord')].indexOf(cell) : -1;
          const ms = j > 0 && starts[b] && starts[b][j] != null ? starts[b][j] : barStart;
          if (this.clickSync([ms])) ev.preventDefault();
        });
        grid.append(box);
        p.sbars.push(box);
      }
      p.solo.textContent = '';
      p.solo.append(grid);
    }

    setView(view) {
      this.view = view === 'solo' || view === 'scales' ? view : 'head';
      for (const p of this.panels) { p.paper.hidden = this.view !== 'head'; p.solo.hidden = this.view !== 'solo'; p.scales.hidden = this.view !== 'scales'; }
      this.lastIdx = -1; this.lastBar = null;
      if (this.view === 'head') this.render();
      if (this.view === 'scales') this.buildScales();
    }

    // Click-to-sync: "this spot is playing right now". msList = the spot's time(s) in the chart (a note inside
    // repeats has several); picks the one closest to where we are. Only while the video plays.
    clickSync(msList) {
      if (!this.now) return false;
      // Playing or paused, started or not: this spot = the video's time right now.
      const vt = this.now();
      const cur = this.t0 == null ? null : (vt - this.t0) * 1000;
      let best = null;
      for (const ms of msList) {
        const base = ms - this.pickupMs;
        let k = cur == null ? 0 : Math.max(0, Math.round((cur - base) / this.formMs));
        const el = base + k * this.formMs;
        const d = cur == null ? 0 : Math.abs(el - cur);
        if (!best || d < best.d) best = { el, base, d };
      }
      if (!best) return false;
      // Two or more clicks (or Hit on 1 then a click) a few bars apart also set the TEMPO from the video,
      // so it keeps up instead of drifting. Points are kept in bars, so a tempo change doesn't move them.
      let bars = best.el / this.barMs;
      const pts = (this.syncPts || []).filter((q) => vt > q.vt && vt - q.vt < 240);
      const first = pts[0];
      if (first && bars - first.bars >= 4) {
        const barSec = (vt - first.vt) / (bars - first.bars);
        const ratio = (this.barMs / 1000) / barSec;
        // First time: accept a big correction (the book tempo can be far off). After that, ignore a click
        // more than 15% off the tempo we have (a mis-click), so it only refines.
        if (this.clickTempo ? Math.abs(ratio - 1) < 0.15 : ratio > 0.6 && ratio < 1.6) {
          this.clickTempo = true;
          const quartersPerBar = (this.barMs * this.qpm) / 60000;
          this.qpm = (quartersPerBar * 60) / barSec;
          this.retime();
          this.tempoChanged = true;
        }
      }
      pts.push({ bars, vt });
      this.syncPts = pts.slice(-6);
      best.el = bars * this.barMs;
      this.t0 = vt - best.el / 1000;
      this.taps = [{ n: Math.round(best.el / this.barMs), t: vt - ((best.el % this.barMs) / 1000) }];
      this.offsetMs = 0; this.lastIdx = -1; this.lastBar = null;
      const bar = best.base < 0 ? 'the pickup' : 'bar ' + (Math.floor(best.base / this.barMs) + 1);
      if (this.onSync) this.onSync(bar);
      return true;
    }
    // Click anywhere in a bar of the sheet music: that bar's beat 1 is now.
    // (Click right on a chord symbol and that chord's own beat is now.)
    paperClick(p, ev) {
      if (!p.elEvents) return false;
      let n = ev.target;
      while (n && n !== p.paper && !p.elEvents.has(n)) n = n.parentNode;
      let hit = n && n !== p.paper ? n : null;
      if (!hit) hit = this.nearestEl(p, ev.clientX, ev.clientY);
      if (!hit) return false;
      const isChord = hit.classList && hit.classList.contains('abcjs-chord');
      const toBar = (ms) => this.pickupMs + Math.max(0, Math.floor((ms - this.pickupMs) / this.barMs + 1e-6)) * this.barMs;
      const list = p.elEvents.get(hit).map((i) => p.events[i].milliseconds);
      return this.clickSync(isChord ? list : list.map(toBar));
    }
    barOf(ms) { return Math.max(0, Math.floor((ms - this.pickupMs) / this.barMs + 1e-6)); }
    // Hover: a soft gold box over the whole bar under the mouse.
    paperHover(p, ev) {
      if (!p.elEvents || !p.hoverBox) return;
      let n = ev.target;
      while (n && n !== p.paper && !p.elEvents.has(n)) n = n.parentNode;
      const hit = n && n !== p.paper ? n : this.nearestEl(p, ev.clientX, ev.clientY);
      if (!hit) { p.hoverBox.hidden = true; return; }
      const r0 = hit.getBoundingClientRect(), line = (r0.top + r0.bottom) / 2;
      const bar = this.barOf(p.events[p.elEvents.get(hit)[0]].milliseconds);
      let L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
      p.events.forEach((e, i) => {
        if (this.barOf(e.milliseconds) !== bar) return;
        for (const el of e.elements.flat()) {
          const r = el.getBoundingClientRect();
          if (!r.width || Math.abs((r.top + r.bottom) / 2 - line) > 70) continue;
          L = Math.min(L, r.left); R = Math.max(R, r.right); T = Math.min(T, r.top); B = Math.max(B, r.bottom);
        }
      });
      if (!isFinite(L)) { p.hoverBox.hidden = true; return; }
      const pr = p.paper.getBoundingClientRect();
      Object.assign(p.hoverBox.style, { left: (L - pr.left + p.paper.scrollLeft - 6) + 'px', top: (Math.min(T, line - 34) - pr.top + p.paper.scrollTop - 4) + 'px', width: (R - L + 12) + 'px', height: (Math.max(B, line + 34) - Math.min(T, line - 34) + 8) + 'px' });
      p.hoverBox.textContent = ''; p.hoverBox.hidden = false; p.hoverBar = bar;
    }
    flashBar(p) { if (!p.hoverBox || p.hoverBox.hidden) return; p.hoverBox.classList.remove('flash'); void p.hoverBox.offsetWidth; p.hoverBox.classList.add('flash'); }

    // The note/rest nearest to a click on the same line of music (for clicks on empty staff).
    nearestEl(p, x, y) {
      let best = null, bd = Infinity;
      for (const el of p.elEvents.keys()) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const cy = (r.top + r.bottom) / 2;
        if (Math.abs(cy - y) > 70) continue; // same staff line only
        // prefer the note at or before the click (the bar it's in)
        const dx = x >= r.left ? x - r.right : (r.left - x) * 3;
        const d = Math.max(0, dx) + Math.abs(cy - y) * 0.3;
        if (d < bd) { bd = d; best = el; }
      }
      return best;
    }

    // Before syncing, show where "1" is: the first note of bar 1 pulses, with a small "1" above it.
    markTarget() {
      const want = this.t0 == null;
      if (want === this.targetOn) return;
      this.targetOn = want;
      for (const p of this.panels) {
        (p.targetEls || []).forEach((el) => el.classList.remove('pac-target'));
        (p.targetMarks || []).forEach((m) => m.remove());
        p.targetEls = []; p.targetMarks = [];
        if (!want || !p.events) continue;
        const ev = p.events.find((e) => e.milliseconds >= this.pickupMs - 1);
        if (!ev) continue;
        p.targetEls = ev.elements.flat();
        p.targetEls.forEach((el) => el.classList.add('pac-target'));
        const el = p.targetEls[0], svg = el && el.ownerSVGElement;
        if (!svg || !el.getBBox) continue;
        try {
          const bb = el.getBBox();
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', bb.x + bb.width / 2); t.setAttribute('y', Math.max(14, bb.y - 6));
          t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'pac-one');
          t.textContent = '1';
          svg.append(t); p.targetMarks.push(t);
        } catch {}
      }
    }

    // Scales view: a card per chord (built only when shown).
    // Scales view, built only when shown. NOW (big, the chord being played) on top, a slim NEXT line,
    // then the tune map: every bar, 4 to a row; click one to look at it.
    buildScales() {
      for (const p of this.panels) {
        if (p.scalesBuilt && p.scalesW === p.scales.clientWidth) continue;
        p.scales.textContent = '';
        const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
        p.scNowBox = div('sc-now'); p.scNextBox = div('sc-nextline'); p.scMap = div('sc-map');
        p.scBack = document.createElement('button'); p.scBack.type = 'button'; p.scBack.className = 'btn small sc-back'; p.scBack.textContent = 'Back to live'; p.scBack.hidden = true; p.scBack.title = 'Go back to following the chord that\u2019s playing.';
        p.scBack.onclick = () => { p.pinned = null; p.scBack.hidden = true; p.scShown = null; this.lastIdx = -1; if (this.t0 == null) this.showScale(p, this.firstChord(p), null); };
        p.scales.append(p.scNowBox, p.scNextBox, p.scMap);
        p.bigCards = new Map(); p.mapCells = [];
        const grid = div('sc-mapgrid');
        (p.barLists || []).forEach((list, b) => {
          const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'sc-cell';
          const n = document.createElement('span'); n.className = 'sc-cellnum'; n.textContent = b + 1;
          cell.append(n, list.join(' ') || '–');
          cell.addEventListener('pointerdown', (ev) => {
            // Playing: this bar is now. Paused: just look at this bar's scale.
            if (this.isPlaying && this.isPlaying() && this.clickSync([this.pickupMs + b * this.barMs])) { p.pinned = null; p.scBack.hidden = true; return; }
            if (!list.length) return; p.pinned = list[0]; p.scBack.hidden = false; this.showScale(p, list[0], null, true); this.markMap(p, b); });
          grid.append(cell); p.mapCells.push(cell);
        });
        const mh = div('sc-maphead'); const ml = div('sc-label'); ml.textContent = 'Tune map \u00b7 click a bar';
        mh.append(ml, p.scBack);
        p.scMap.append(mh, grid);
        p.scalesBuilt = true; p.scalesW = p.scales.clientWidth;
        p.scShown = null;
        this.showScale(p, p.pinned || this.firstChord(p), null, !!p.pinned);
      }
      this.lastIdx = -1;
    }
    firstChord(p) { return [...(p.uniq || new Map()).keys()][0]; }

    // Fill NOW with one chord's big card; NEXT gets a one-line heads-up.
    showScale(p, now, next, picked, barsAway) {
      if (!p.scNowBox || !now) return;
      if (p.scShown !== now + (picked ? '*' : '')) {
        p.scShown = now + (picked ? '*' : '');
        if (!p.bigCards.has(now)) { const c = scaleCard(now, p.inst, (p.uniq && p.uniq.get(now)) || []); c.rendered = false; p.bigCards.set(now, c); }
        const big = p.bigCards.get(now);
        const lab = document.createElement('div'); lab.className = 'sc-label';
        lab.textContent = picked ? 'Looking at' : this.t0 == null ? 'Bar 1 · waiting for 1' : 'Now';
        p.scNowBox.replaceChildren(lab, big);
        if (!big.rendered && big.renderStaff) { big.renderStaff(Math.max(260, p.scNowBox.clientWidth - 8)); big.rendered = true; }
        big.classList.remove('sc-flash'); void big.offsetWidth; big.classList.add('sc-flash');
      }
      const info = next && scaleInfo(next);
      p.scNextBox.textContent = '';
      if (next && next !== now && info && !picked) {
        const b = document.createElement('b'); b.textContent = next;
        p.scNextBox.append('Next: ', b, ' · ' + info.root + ' ' + info.name + (barsAway ? ' · in ' + barsAway + (barsAway > 1 ? ' bars' : ' bar') : ''));
      } else p.scNextBox.append(' ');
    }
    markMap(p, bar, nextBar) {
      (p.mapCells || []).forEach((c, i) => { c.classList.toggle('on', i === bar); c.classList.toggle('next', i === nextBar); });
    }

    setMode(mode) { this.mode = mode; this.render(); }

    retime() {
      this.clearHighlight();
      for (const p of this.panels) {
        // abcjs counts its own beats (a half note in 2/2, a dotted half in 6/4), but our tempo is in quarter notes.
        const beat = (p.vo.getBeatLength && p.vo.getBeatLength()) || 0.25;
        const tc = new ABCJS.TimingCallbacks(p.vo, { qpm: (this.qpm * 0.25) / beat });
        p.events = tc.noteTimings.filter((e) => e.type === 'event' && e.elements);
        // Which chord is sounding at each event, and the next change after it.
        const byChar = new Map();
        for (const line of p.vo.lines || []) for (const st of line.staff || []) for (const v of st.voices || []) for (const el of v) {
          // Only real chord symbols: text written above/below the staff ("^Verse") is a label, not a chord.
          const chs = (el.chord || []).filter((c) => !c.position || c.position === 'default');
          if (chs.length) byChar.set(el.startChar, chs.map((c) => c.name.replace(/\u200b/g, '')).join(' '));
        }
        p.chordAt = p.events.map((e) => byChar.get(e.startChar) || '');
        // Which events each drawn element (note, rest, chord symbol) belongs to: for click-to-sync.
        p.elEvents = new Map();
        p.events.forEach((e, i) => { for (const el of e.elements.flat()) { if (!p.elEvents.has(el)) p.elEvents.set(el, []); p.elEvents.get(el).push(i); } });
        let cur = '';
        p.chordNow = p.events.map((e) => { const c = byChar.get(e.startChar); if (c) cur = c; return cur; });
        p.chordNext = new Array(p.events.length);
        let nxt = null;
        for (let i = p.events.length - 1; i >= 0; i--) {
          p.chordNext[i] = nxt;
          const c = byChar.get(p.events[i].startChar);
          if (c && (i === 0 || p.chordNow[i - 1] !== c)) nxt = { name: c, ms: p.events[i].milliseconds };
        }
        p.total = Math.max(...tc.noteTimings.map((e) => e.milliseconds)); // includes the final 'end' event
      }
      const first = this.panels[0];
      this.barMs = (first.vo.getBarLength ? first.vo.getBarLength() * 4 : 4) * (60000 / this.qpm);
      // A pickup (anacrusis) is played before bar 1, so the music's clock starts that much before beat 1.
      this.pickupMs = ((first.vo.getPickupLength && first.vo.getPickupLength()) || 0) * 4 * (60000 / this.qpm);
      // One chorus, from beat 1 of bar 1 to beat 1 of the next chorus, in whole bars.
      this.formMs = Math.max(1, Math.round(((first.total || this.barMs) - this.pickupMs) / this.barMs)) * this.barMs;
      for (const p of this.panels) this.buildSolo(p);
      this.lastBar = null;
      if (this.view === 'scales') this.buildScales();
      this.targetOn = null; this.markTarget();
      this.lastIdx = -1;
      this.clearHighlight();
    }

    setTempo(qpm) {
      if (!(qpm > 20 && qpm < 400)) return;
      // Keep the latest tap where it is, so the cursor doesn't jump; older taps no longer fit the new tempo.
      this.qpm = qpm;
      this.retime();
      const last = this.taps && this.taps[this.taps.length - 1];
      if (last) { this.t0 = last.t - (last.n * this.barMs) / 1000; this.taps = [{ n: last.n, t: last.t }]; }
    }

    // Tap on beat 1. First tap = bar 1. Each later tap is matched to the nearest beat 1, and from two
    // taps on the tempo is worked out from them too (a straight-line fit), so it locks in and stops drifting.
    tap(videoTime) {
      this.offsetMs = 0;
      if (this.t0 == null || !this.taps || !this.taps.length) {
        this.t0 = videoTime; this.taps = [{ n: 0, t: videoTime }]; this.syncPts = [{ bars: 0, vt: videoTime }];
        return { started: true };
      }
      const n = Math.round(((videoTime - this.t0) * 1000) / this.barMs);
      const last = this.taps[this.taps.length - 1];
      if (n <= last.n) { // same bar tapped twice (or went back): use the newer tap, restart the count from here
        this.t0 = videoTime - (n * this.barMs) / 1000; this.taps = [{ n, t: videoTime }];
        return { taps: 1 };
      }
      this.taps.push({ n, t: videoTime });
      if (this.taps.length > 8) this.taps.shift();
      const k = this.taps.length;
      const mn = this.taps.reduce((a, x) => a + x.n, 0) / k, mt = this.taps.reduce((a, x) => a + x.t, 0) / k;
      let sxy = 0, sxx = 0;
      for (const x of this.taps) { sxy += (x.n - mn) * (x.t - mt); sxx += (x.n - mn) * (x.n - mn); }
      const barSec = sxx ? sxy / sxx : this.barMs / 1000;
      // Only trust the fitted tempo if it is close to the one we had (a mis-tap shouldn't wreck it).
      if (barSec > 0 && Math.abs(barSec * 1000 - this.barMs) / this.barMs < 0.2) {
        const barQuarters = (this.barMs * this.qpm) / 60000;
        this.qpm = (barQuarters * 60) / barSec;
        this.retime();
        this.t0 = mt - mn * barSec;
      } else {
        this.t0 = videoTime - (n * this.barMs) / 1000;
        this.taps = [{ n, t: videoTime }];
      }
      return { taps: this.taps.length, qpm: this.qpm };
    }

    // Count-in: taps on the last bar of clicks before the melody. Sets the tempo and puts beat 1 of
    // bar 1 one bar after the first tap, so a pickup plays just before it on its own.
    // Put back a sync saved earlier: bar 1 at video time t0, at this tempo.
    restoreSync(t0, qpm) {
      this.qpm = qpm; this.retime();
      this.t0 = t0; this.taps = [{ n: 0, t: t0 }]; this.offsetMs = 0;
    }
    // Tap live: taps on every beat while it plays. Sets the tempo from the taps and keeps your place
    // (the latest tap is lined up with the nearest beat). times = video seconds of recent taps.
    tapTempo(times) {
      if (times.length < 4) return null;
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      const sorted = gaps.slice().sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)];
      const good = gaps.filter((g) => Math.abs(g - med) / med <= 0.25);
      if (!(med > 0.15 && med < 2.5) || good.length < Math.max(2, gaps.length - 1)) return null;
      const beat = good.reduce((a, g) => a + g, 0) / good.length;
      const last = times[times.length - 1];
      if (this.t0 == null) { this.qpm = 60 / beat; this.retime(); return { qpm: this.qpm }; } // not following yet: just the tempo
      const n = Math.round(((last - this.t0) * 1000) / this.beatMs()); // which beat the last tap was (old tempo)
      this.qpm = 60 / beat;
      this.retime();
      this.t0 = last - (n * this.beatMs()) / 1000;
      this.taps = [{ n: Math.round(n / this.beatsPerBar()), t: this.t0 + (Math.round(n / this.beatsPerBar()) * this.barMs) / 1000 }];
      return { qpm: this.qpm };
    }
    // Change the tempo without moving the cursor: the place in the music at video time vt stays put.
    retempoKeep(qpm, vt) {
      if (!(qpm > 20 && qpm < 400)) return;
      if (this.t0 == null) { this.qpm = qpm; this.retime(); return; }
      const bars = ((vt - this.t0) * 1000) / this.barMs;
      this.qpm = qpm; this.retime();
      this.t0 = vt - (bars * this.barMs) / 1000;
      this.syncPts = (this.syncPts || []).map((q) => q); // anchors are in bars, still valid
    }
    beatsPerBar() { return Math.max(1, Math.round(this.barMs / (60000 / this.qpm))); }
    countIn(times) {
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      const sorted = gaps.slice().sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)];
      if (!(med > 0.15 && med < 2.5) || gaps.some((g) => Math.abs(g - med) / med > 0.2)) return null;
      const beats = this.beatsPerBar();
      this.qpm = 60 / med;
      this.retime();
      this.t0 = times[0] + beats * med;
      this.taps = [{ n: 0, t: this.t0 }];
      this.offsetMs = 0;
      return { qpm: this.qpm };
    }
    barsPerChorus() { return Math.round(this.formMs / this.barMs); }

    // Slide the cursor by ms (positive = later in the music). Returns false before the first tap.
    nudge(ms) {
      if (this.t0 == null) return false;
      this.t0 -= ms / 1000;
      for (const x of this.taps || []) x.t -= ms / 1000;
      this.offsetMs = (this.offsetMs || 0) + ms;
      return true;
    }
    beatMs() { return 60000 / this.qpm; }

    reset() { this.t0 = null; this.taps = []; this.syncPts = []; this.clickTempo = false; this.offsetMs = 0; this.clearHighlight(); this.lastIdx = -1; }

    // Bar number (1-based, in playing order) for the status line, or null before the start.
    update(videoTime) {
      this.markTarget();
      if (this.t0 == null) { this.clearHighlight(); this.lastIdx = -1; return null; }
      const elapsed = (videoTime - this.t0) * 1000; // ms since beat 1 of bar 1
      if (elapsed < -this.pickupMs) { this.clearHighlight(); this.lastIdx = -1; return null; }
      // Position in the written music: the pickup comes first, then the form repeats chorus after chorus.
      const inForm = elapsed < 0 ? elapsed : elapsed % this.formMs;
      const ms = this.pickupMs + inForm;
      const barIdx = inForm < 0 ? -1 : Math.floor(inForm / this.barMs);
      if (barIdx !== this.lastBar) {
        for (const p of this.panels) {
          (p.sbars || []).forEach((el) => el.classList.remove('on'));
          const el = p.sbars && p.sbars[barIdx];
          if (el) { el.classList.add('on'); if (this.view === 'solo') scrollIntoPanel(p.solo, el); }
        }
        this.lastBar = barIdx;
      }
      const evs = this.panels[0].events;
      let lo = 0, hi = evs.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (evs[mid].milliseconds <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      if (idx !== this.lastIdx) {
        this.clearHighlight();
        for (const p of this.panels) {
          const ev = p.events[idx];
          if (!ev) continue;
          p.on = ev.elements.flat();
          p.on.forEach((el) => el.classList.add('pac-note-on'));
          scrollIntoPanel(p.paper, p.on[0]);
          p.now.textContent = p.chordNow[idx] || '';
          if (p.scNowBox && this.view === 'scales' && p.chordNow[idx]) {
            const nx = p.chordNext[idx];
            const away = nx ? Math.max(1, Math.round((nx.ms - ms) / this.barMs)) : 0;
            if (!p.pinned) this.showScale(p, p.chordNow[idx], nx && nx.name, false, away);
            const curBar = Math.floor((ms - this.pickupMs) / this.barMs);
            const nb = nx ? Math.floor((nx.ms - this.pickupMs) / this.barMs + 1e-6) % (this.barsPerChorus() || 1) : -1;
            this.markMap(p, curBar, nb !== curBar ? nb : -1);
          }
          const n = p.chordNext[idx];
          p.next.textContent = n ? 'next ' + n.name + ' \u00b7 ' + Math.max(1, Math.round((n.ms - ms) / this.barMs)) + ' bar' + (Math.round((n.ms - ms) / this.barMs) > 1 ? 's' : '') : '';
        }
        this.lastIdx = idx;
      }
      return inForm < 0 ? 'pickup' : Math.floor(inForm / this.barMs) + 1;
    }

    clearHighlight() {
      this.lastBar = null;
      for (const p of this.panels) {
        (p.sbars || []).forEach((el) => el.classList.remove('on'));
        (p.on || []).forEach((el) => el.classList.remove('pac-note-on')); p.on = null;
        if (p.now) { p.now.textContent = (p.chordNow && p.chordNow.find((c) => c)) || ''; p.next.textContent = 'waiting for beat 1'; }
      }
    }
  }

  // A scale to improvise on over a chord, e.g. "D-7" -> "D Dorian". Chord names use ♭ and ♯.
  function scaleFor(chord) {
    const m = /^([A-G][♭♯]?)([^/]*)/.exec(chord || '');
    if (!m) return '';
    const root = m[1];
    const q = m[2].replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s/g, '');
    let name;
    if (/^(-7b5|ø|m7b5|min7b5)/.test(q)) name = 'Locrian';
    else if (/^(o|°|dim)/.test(q)) name = 'Whole-half diminished';
    else if (/^(maj|Δ|\^|M7)/.test(q)) name = /#11/.test(q) ? 'Lydian' : 'Major';
    else if (/^(-|m(?!aj)|min)/.test(q)) name = /^(-|m|min)(6|maj7|Δ)?$/.test(q) || q === '-' ? 'Melodic minor' : 'Dorian';
    else if (/sus/.test(q)) name = 'Mixolydian';
    else if (/^\+$|^aug$/.test(q)) name = 'Whole tone';
    else if (/^(\+?7|9|11|13)/.test(q) || /^\+7/.test(q)) {
      if (/alt|#9|#5b9|#5#9/.test(q)) name = 'Altered';
      else if (/b9/.test(q)) name = 'Half-whole diminished';
      else if (/#5|^\+/.test(q)) name = 'Whole tone';
      else if (/#11|b5/.test(q)) name = 'Lydian dominant';
      else name = 'Mixolydian';
    } else name = 'Major';
    return root + ' ' + name;
  }

  // ---------- chord scales ----------
  // Each scale: semitones above the root, and how many letter names up each note is (so spellings come out
  // right, e.g. B♭ Dorian = B♭ C D♭ E♭ F G A♭). tones = which notes are the chord's 1 3 5 7.
  const SCALES = {
    'Major':                 { semis: [0, 2, 4, 5, 7, 9, 11], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Dorian':                { semis: [0, 2, 3, 5, 7, 9, 10], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Mixolydian':            { semis: [0, 2, 4, 5, 7, 9, 10], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Locrian':               { semis: [0, 1, 3, 5, 6, 8, 10], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Melodic minor':         { semis: [0, 2, 3, 5, 7, 9, 11], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Lydian':                { semis: [0, 2, 4, 6, 7, 9, 11], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    'Lydian dominant':       { semis: [0, 2, 4, 6, 7, 9, 10], letters: [0, 1, 2, 3, 4, 5, 6], tones: [0, 2, 4, 6] },
    // Altered: 1 ♭9 ♯9 3 ♯11 ♭13 ♭7 (C D♭ D♯ E F♯ A♭ B♭); chord tones 1 3 ♭7.
    'Altered':               { semis: [0, 1, 3, 4, 6, 8, 10], letters: [0, 1, 1, 2, 3, 5, 6], tones: [0, 3, 6], deg: ['1', '3', '7'] },
    // Half-whole: 1 ♭9 ♯9 3 ♯11 5 13 ♭7 (C D♭ D♯ E F♯ G A B♭).
    'Half-whole diminished': { semis: [0, 1, 3, 4, 6, 7, 9, 10], letters: [0, 1, 1, 2, 3, 4, 5, 6], tones: [0, 3, 5, 7] },
    // Whole-half: C D E♭ F G♭ A♭ A B; chord tones 1 ♭3 ♭5 °7 (written as A, the 6th letter).
    'Whole-half diminished': { semis: [0, 2, 3, 5, 6, 8, 9, 11], letters: [0, 1, 2, 3, 4, 5, 5, 6], tones: [0, 2, 4, 6] },
    'Whole tone':            { semis: [0, 2, 4, 6, 8, 10], letters: [0, 1, 2, 3, 4, 6], tones: [0, 2, 4, 5] }
  };
  const LET = ['C', 'D', 'E', 'F', 'G', 'A', 'B'], LET_PC = [0, 2, 4, 5, 7, 9, 11];
  const accSym = (a) => a === -2 ? '𝄫' : a === -1 ? '♭' : a === 1 ? '♯' : a === 2 ? '𝄪' : '';

  function scaleInfo(chord) {
    const m = /^([A-G])([♭♯b#]?)([^/]*)/.exec(chord || '');
    if (!m) return null;
    const name = scaleFor(chord).replace(/^\S+\s/, '');
    const acc = /[♭b]/.test(m[2]) ? -1 : /[♯#]/.test(m[2]) ? 1 : 0;
    return { letter: LET.indexOf(m[1]), acc, name, root: m[1] + accSym(acc) };
  }

  // The scale's notes, one octave up from the root: [{ name, letter, acc, octave, midi, tone }]
  function spellScale(info) {
    const sc = SCALES[info.name] || SCALES.Major;
    const rootPc = LET_PC[info.letter] + info.acc;
    const out = [];
    const deg = sc.deg || ['1', '3', '5', '7'];
    sc.semis.concat([12]).forEach((semi, i) => {
      const ls = i < sc.letters.length ? sc.letters[i] : 7;
      const li = (info.letter + ls) % 7;
      const octave = 4 + Math.floor((info.letter + ls) / 7);
      const pc = rootPc + semi;
      let a = pc - (LET_PC[li] + 12 * Math.floor((info.letter + ls) / 7));
      while (a > 6) a -= 12; while (a < -6) a += 12;
      const ti = sc.tones.indexOf(i % sc.semis.length);
      out.push({ name: LET[li] + accSym(a), letter: li, acc: a, octave, midi: 60 + 12 * (octave - 4) + LET_PC[li] + a, tone: i === sc.semis.length ? '1' : ti >= 0 ? deg[ti] : '' });
    });
    return out;
  }

  // ABC for the scale on a staff. Chord tones get their number underneath.
  function scaleAbc(notes) {
    const seen = {};
    const body = notes.map((n) => {
      const k = n.letter + ':' + n.octave;
      let acc = n.acc === 1 ? '^' : n.acc === -1 ? '_' : n.acc === 2 ? '^^' : n.acc === -2 ? '__' : '';
      if (!acc && seen[k] != null && seen[k] !== 0) acc = '=';
      seen[k] = n.acc;
      const L = n.octave >= 5 ? LET[n.letter].toLowerCase() + "'".repeat(n.octave - 5) : LET[n.letter] + ','.repeat(4 - n.octave);
      return (n.tone ? '"_' + n.tone + '"' : '') + acc + L;
    }).join(' ');
    return 'X:1\nL:1/4\nM:none\nK:C\n' + body + ' |]';
  }

  // A soft piano-ish tone (WebAudio). Only starts when someone clicks a play button.
  let actx = null;
  function playMidi(midis, opts) {
    opts = opts || {};
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { return; }
    const step = opts.step || 0.3, t0 = actx.currentTime + 0.05;
    midis.forEach((m, i) => {
      const t = opts.together ? t0 : t0 + i * step, dur = opts.together ? 1.6 : step * 1.6;
      const f = 440 * Math.pow(2, (m - 69) / 12);
      const g = actx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(opts.together ? 0.12 : 0.22, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      g.connect(actx.destination);
      for (const [type, mul, vol] of [['triangle', 1, 1], ['sine', 2, 0.25], ['sine', 3, 0.08]]) {
        const o = actx.createOscillator(), og = actx.createGain();
        o.type = type; o.frequency.value = f * mul; og.gain.value = vol;
        o.connect(og); og.connect(g); o.start(t); o.stop(t + dur + 0.05);
      }
    });
  }

  // One card: chord, scale, the notes on a staff, play buttons. inst = 'concert' | 'eb' | 'bb' (chord already in that part's key).
  function scaleCard(chord, inst, bars) {
    const info = scaleInfo(chord);
    const card = document.createElement('article');
    card.className = 'sc-card';
    card.dataset.chord = chord;
    if (!info) { card.textContent = chord; return card; }
    const notes = spellScale(info);
    const head = document.createElement('div'); head.className = 'sc-head';
    const nm = document.createElement('b'); nm.className = 'sc-chord'; nm.textContent = chord;
    const sn = document.createElement('span'); sn.className = 'sc-name'; sn.textContent = info.root + ' ' + info.name;
    const tag = document.createElement('span'); tag.className = 'sc-tag';
    head.append(nm, sn, tag);
    const staff = document.createElement('div'); staff.className = 'sc-staff';
    const row = document.createElement('div'); row.className = 'sc-notes';
    for (const n of notes.slice(0, -1)) {
      const s = document.createElement('span');
      s.className = n.tone ? 'tone' + (n.tone === '3' || n.tone === '7' ? ' guide' : '') : '';
      s.textContent = n.name;
      if (n.tone) { const d = document.createElement('sub'); d.textContent = n.tone; s.append(d); }
      row.append(s);
    }
    const foot = document.createElement('div'); foot.className = 'sc-foot';
    // Sound at concert pitch, so the class hears what the band will play.
    const shift = (Chords.INSTRUMENTS[inst] || {}).semitones || 0;
    const sounding = notes.map((n) => n.midi - shift);
    const up = sounding.concat(sounding.slice(0, -1).reverse());
    const pb = document.createElement('button'); pb.type = 'button'; pb.className = 'btn small'; pb.textContent = '▶ Scale';
    pb.onclick = () => playMidi(up, { step: 0.28 });
    pb.title = 'Play this scale up and down (at concert pitch).';
    const cb = document.createElement('button'); cb.type = 'button'; cb.className = 'btn small'; cb.textContent = '▶ Chord';
    const sc = SCALES[info.name] || SCALES.Major;
    cb.onclick = () => playMidi(sc.tones.map((i) => sounding[i]), { together: true });
    cb.title = 'Play the chord.';
    foot.append(pb, cb);
    if (bars && bars.length) { const b = document.createElement('span'); b.className = 'sc-bars'; b.textContent = (bars.length > 1 ? 'bars ' : 'bar ') + bars.join(', '); foot.append(b); }
    card.append(head, staff, row, foot);
    card.renderStaff = (width) => {
      ABCJS.renderAbc(staff, scaleAbc(notes), {
        staffwidth: Math.max(220, Math.min(520, width - 24)), scale: 1, add_classes: true, paddingtop: 0, paddingbottom: 0, paddingleft: 4, paddingright: 4,
        format: { annotationfont: 'PetalumaScript 15' }
      });
      // Colour the chord tones; the guide tones (3 and 7) in the accent colour.
      const els = staff.querySelectorAll('.abcjs-note');
      notes.forEach((n, i) => { if (els[i] && n.tone) els[i].classList.add(n.tone === '3' || n.tone === '7' ? 'sc-guide' : 'sc-tone'); });
    };
    return card;
  }

  function readQ(abc) {
    const m = /^Q:\s*(?:\d+\/\d+\s*=\s*)?(\d+)/m.exec(abc || '');
    return m ? +m[1] : null;
  }

  function scrollIntoPanel(container, el) {
    if (!el || !container) return;
    const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < c.top + 40 || r.bottom > c.bottom - 40) {
      container.scrollTop += r.top - c.top - c.height * 0.3;
    }
  }

  const api = { NotationView, withChordsFor, scaleFor, scaleInfo, spellScale, scaleCard, playMidi };
  root.Notation = api;
})(typeof window !== 'undefined' ? window : globalThis);
