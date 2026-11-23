// Built-in tune library (OpenBook): finds the tune from the video title and works out the video's key.
(function (root) {
  const { Chords } = root;
  const TUNES = root.OpenBookTunes || [];

  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const LETTERS = 'CDEFGAB';
  const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

  const norm = (s) => ' ' + String(s || '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bsaint\b/g, 'st')
    .trim() + ' ';

  // The tune whose name appears in the video title (longest name wins).
  function match(title) {
    const t = norm(title);
    let best = null, bestLen = 0;
    for (const tune of TUNES) {
      for (const n of tune.names) {
        const k = norm(n);
        // Short one-word names ("Four", "Candy") only count at the start of the title, so "Blues in F" style titles don't match by accident.
        const short = k.trim().split(' ').length < 2 || k.length < 10;
        const hit = short ? t.startsWith(k) : t.includes(k);
        if (hit && k.length > bestLen) { best = tune; bestLen = k.length; }
      }
    }
    return best;
  }

  function nameToPc(letter, acc) {
    return (PC[letter.toUpperCase()] + (acc || 0) + 12) % 12;
  }

  // "Autumn Leaves in G minor", "Blue Bossa (Key of Eb)", "in Bb" ... -> { pc, letter, minor|null }
  function keyFromTitle(title) {
    const m = /\b(?:in|key of|key:?)\s+([A-G])\s*(b|#|♭|♯|flat|sharp)?\s*(minor|min|maj(?:or)?|m|-)?(?![a-z0-9#])/i.exec(title || '');
    if (!m) return null;
    const acc = /^(b|♭|flat)$/i.test(m[2] || '') ? -1 : /^(#|♯|sharp)$/i.test(m[2] || '') ? 1 : 0;
    // "in A" could be an English word ("in a minor key"); require a capital letter.
    if (m[1] !== m[1].toUpperCase()) return null;
    const q = (m[3] || '').toLowerCase();
    return { letter: m[1].toUpperCase(), acc, pc: nameToPc(m[1], acc), minor: q === '' ? null : !q.startsWith('maj') };
  }

  // The tune's written key -> { letter, acc, pc, minor }
  function tuneKey(tune) {
    const m = /^([A-G])([#b]?)(m?)$/.exec(tune.key);
    const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return { letter: m[1], acc, pc: nameToPc(m[1], acc), minor: !!m[3] };
  }

  // The 12 keys for a menu, in the tune's mode.
  function keyChoices(tune) {
    const minor = tuneKey(tune).minor;
    return (minor ? MINOR_NAMES : MAJOR_NAMES).map((n, pc) => ({ pc, name: n.replace('b', '♭').replace('#', '♯') + (minor ? ' minor' : ''), spelled: n }));
  }

  // How to move the tune from its written key to a key: { letterSteps, semitones (-6..+5), pc, name }.
  // target = { pc, letter?, acc?, minor? }. A key in the other mode (e.g. "Autumn Leaves in Bb") means its relative minor/major.
  function shiftTo(tune, target) {
    const from = tuneKey(tune);
    let pc = target.pc, letter = target.letter, acc = target.acc;
    if (target.minor != null && target.minor !== from.minor) {
      pc = (pc + (from.minor ? 9 : 3)) % 12;
      letter = null;
    }
    if (!letter) {
      const n = (from.minor ? MINOR_NAMES : MAJOR_NAMES)[pc];
      letter = n[0]; acc = n[1] === 'b' ? -1 : n[1] === '#' ? 1 : 0;
    }
    const letterSteps = (LETTERS.indexOf(letter) - LETTERS.indexOf(from.letter) + 7) % 7;
    let semitones = (pc - from.pc + 12) % 12;
    if (semitones > 5) semitones -= 12;
    const name = letter + (acc === 1 ? '\u266f' : acc === -1 ? '\u266d' : '') + (from.minor ? ' minor' : '');
    return { letterSteps, semitones, pc, name };
  }

  // Chord "shape": root + rough quality, so the same tune in another key can be matched.
  function shape(sym) {
    const p = Chords.parseChord(sym);
    if (!p) return null;
    const q = p.quality.replace(/\s/g, '');
    let cls;
    if (/^(ø|-7b5|m7b5|-7\(b5\)|m7\(b5\))/.test(q)) cls = 'h';
    else if (/^(o|°|dim)/.test(q)) cls = 'd';
    else if (/^(-|m(?!aj)|min)/.test(q)) cls = 'm';
    else if (/^(maj|M|Δ|\^|6|add|$|\/)/.test(q) && !/^(7|9|11|13)/.test(q)) cls = 'M';
    else cls = '7';
    return { pc: nameToPc(p.letter, p.acc), cls };
  }

  // Compares the chords read from the video with the tune's chords. Returns { pc, score } of the best key, or null.
  function detectKey(tune, chartCells) {
    const theirs = (chartCells || []).filter((c) => !Chords.isRepeat(c)).flatMap((c) => String(c).split(/\s+/)).map(shape).filter(Boolean);
    const ours = tune.chords.map(shape).filter(Boolean);
    if (theirs.length < 3) return null;
    const count = (list) => { const m = new Map(); for (const s of list) { const k = s.pc + s.cls; m.set(k, (m.get(k) || 0) + 1); } return m; };
    const mine = count(ours.map((s) => ({ pc: s.pc, cls: s.cls === 'h' ? 'm' : s.cls })));
    const from = tuneKey(tune);
    const scores = [];
    for (let shift = 0; shift < 12; shift++) {
      const moved = count(theirs.map((s) => ({ pc: (s.pc - shift + 12) % 12, cls: s.cls === 'h' ? 'm' : s.cls })));
      let score = 0;
      for (const [k, n] of moved) score += Math.min(n, mine.get(k) || 0);
      scores.push({ shift, score });
    }
    scores.sort((a, b) => b.score - a.score);
    if (scores[0].score < Math.max(4, theirs.length * 0.6) || scores[0].score === scores[1].score) return null;
    return { pc: (from.pc + scores[0].shift) % 12, score: scores[0].score };
  }

  function tempoFromTitle(title) {
    const m = /(\d{2,3})\s*(?:bpm|b\.p\.m)/i.exec(title || '');
    return m ? +m[1] : null;
  }

  root.TuneLibrary = { TUNES, match, keyFromTitle, tuneKey, keyChoices, shiftTo, detectKey, tempoFromTitle };
})(typeof window !== 'undefined' ? window : globalThis);
