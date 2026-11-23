// Chord parsing and transposition. Works in the browser (window.Chords) and in Node (module.exports).
(function (root) {
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Written pitch for each instrument = concert pitch moved up by this interval.
  // letterSteps keeps the spelling correct (e.g. concert Gb°7 -> Eb°7 for alto, not D#°7).
  const INSTRUMENTS = {
    concert: { label: 'Concert', letterSteps: 0, semitones: 0 },
    eb: { label: 'E♭', sub: 'alto, bari', letterSteps: 5, semitones: 9 }, // up a major 6th
    bb: { label: 'B♭', sub: 'tenor, trumpet, clarinet', letterSteps: 1, semitones: 2 } // up a major 2nd
  };

  const NOTE_RE = /^([A-Ga-g])([#b♯♭]?)/;

  const QUALITY_START = /^([0-9\-+^°oøΔ#b♯♭(\/\s*,]|m|M|maj|min|dim|aug|add|sus|alt)/;

  function accValue(a) {
    if (a === '#' || a === '♯') return 1;
    if (a === 'b' || a === '♭') return -1;
    return 0;
  }

  function transposeNote(letter, acc, steps, semis) {
    const li = LETTERS.indexOf(letter.toUpperCase());
    const pc = (((LETTER_PC[li] + acc + semis) % 12) + 12) % 12;
    const ni = (li + steps) % 7;
    let a = pc - LETTER_PC[ni];
    if (a > 6) a -= 12;
    if (a < -6) a += 12;
    if (a === 0) return LETTERS[ni];
    if (a === 1) return LETTERS[ni] + '#';
    if (a === -1) return LETTERS[ni] + 'b';
    // Double sharp/flat: fall back to the simple enharmonic name.
    return (a > 0 ? SHARP_NAMES : FLAT_NAMES)[pc];
  }

  // Splits "Bb-7/F" into { root: "Bb", quality: "-7", bass: "F" }. Returns null for "%", "Break", "N.C." etc.
  function parseChord(sym) {
    if (!sym) return null;
    const s = String(sym).trim();
    const m = s.match(/^([A-G])([#b♯♭]?)(.*)$/);
    if (!m) return null;
    let rest = m[3];
    // Reject words like "Break" or "Fine": what follows the root must look like a chord quality.
    if (rest && !QUALITY_START.test(rest)) return null;
    let bass = null;
    const slash = rest.match(/\/([A-G])([#b♯♭]?)\s*$/);
    if (slash) {
      bass = { letter: slash[1], acc: accValue(slash[2]) };
      rest = rest.slice(0, slash.index);
    }
    return { letter: m[1], acc: accValue(m[2]), quality: rest, bass };
  }

  function transposeChord(sym, instrument) {
    const inst = INSTRUMENTS[instrument] || INSTRUMENTS.concert;
    const p = parseChord(sym);
    if (!p) return sym;
    if (inst.semitones === 0) return sym;
    let out = transposeNote(p.letter, p.acc, inst.letterSteps, inst.semitones) + p.quality;
    if (p.bass) out += '/' + transposeNote(p.bass.letter, p.bass.acc, inst.letterSteps, inst.semitones);
    return out;
  }

  // Moves a chord by any interval: letterSteps keeps the spelling (e.g. 2 steps / 3 semitones = up a minor 3rd).
  function transposeInterval(sym, letterSteps, semitones) {
    const p = parseChord(sym);
    if (!p || (letterSteps % 7 === 0 && semitones % 12 === 0)) return sym;
    const st = ((letterSteps % 7) + 7) % 7, se = ((semitones % 12) + 12) % 12;
    let out = transposeNote(p.letter, p.acc, st, se) + p.quality;
    if (p.bass) out += '/' + transposeNote(p.bass.letter, p.bass.acc, st, se);
    return out;
  }

  function isRepeat(sym) {
    const s = String(sym || '').trim();
    return s === '%' || s === '' || s === '∅' || s === '/' || s === '//' || /^(%|-|\/)+$/.test(s);
  }

  // Turns the cells as shown ("Bb7", "%", "%", ...) into the chord sounding in each bar.
  function resolveBars(cells) {
    const bars = [];
    let last = null;
    for (const c of cells) {
      if (isRepeat(c)) {
        bars.push({ shown: c, chord: last });
      } else {
        bars.push({ shown: c, chord: c });
        last = c;
      }
    }
    return bars;
  }

  // Pretty text for display: b/# on note names become real flat/sharp signs.
  function pretty(sym) {
    if (sym == null) return '';
    const p = parseChord(sym);
    if (!p) return String(sym);
    const n = (l, a) => l + (a === 1 ? '♯' : a === -1 ? '♭' : '');
    let q = p.quality.replace(/b(\d)/g, '♭$1').replace(/#(\d)/g, '♯$1');
    let out = n(p.letter, p.acc) + q;
    if (p.bass) out += '/' + n(p.bass.letter, p.bass.acc);
    return out;
  }

  const api = { INSTRUMENTS, parseChord, transposeChord, transposeInterval, resolveBars, isRepeat, pretty };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Chords = api;
})(typeof window !== 'undefined' ? window : globalThis);
