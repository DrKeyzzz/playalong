// Auto tempo: listens to the video's sound (Chrome shares this tab's audio) and finds the beat.
// Everything runs on this computer; nothing is recorded or sent.
//  - OnsetState: turns audio into an "onset strength" curve, 100 values a second (kick/bass band,
//    ride/hi-hat band and full band). Same code runs in the AudioWorklet and in offline tests.
//  - estimateTempo: autocorrelation of that curve -> quarter-note BPM (half/double resolved toward a
//    prior tempo from the book or the video title), a confidence, and where the beats fall.
(function (root) {
  class OnsetState {
    constructor(sr) {
      this.sr = sr; this.hop = Math.round(sr / 100);
      const a = (fc) => Math.exp(-2 * Math.PI * fc / sr);
      this.aLow = a(150); this.aHigh = a(2500);
      this.lp = 0; this.lp2 = 0; this.n = 0; this.eL = 0; this.eH = 0; this.eB = 0;
      this.pL = 0; this.pH = 0; this.pB = 0;
    }
    // Feed samples; returns an array of onset values (one per 10 ms hop that finished).
    process(x) {
      const out = [];
      for (let i = 0; i < x.length; i++) {
        const s = x[i];
        this.lp = this.aLow * this.lp + (1 - this.aLow) * s;          // low band (kick, bass)
        this.lp2 = this.aHigh * this.lp2 + (1 - this.aHigh) * s;
        const hi = s - this.lp2;                                       // high band (ride, hats, snare)
        this.eL += this.lp * this.lp; this.eH += hi * hi; this.eB += s * s;
        if (++this.n >= this.hop) {
          const L = Math.log(1e-9 + this.eL / this.n), H = Math.log(1e-9 + this.eH / this.n), B = Math.log(1e-9 + this.eB / this.n);
          const v = Math.max(0, L - this.pL) * 1.0 + Math.max(0, H - this.pH) * 0.8 + Math.max(0, B - this.pB) * 0.5;
          this.pL = L; this.pH = H; this.pB = B;
          out.push(v);
          this.n = 0; this.eL = this.eH = this.eB = 0;
        }
      }
      return out;
    }
  }

  // env: onset values at fps (100). prior: expected quarter-note BPM (or null).
  // Returns { bpm, conf, period, phase } or null. phase = frame index (in env) of a beat near the end.
  function estimateTempo(env, fps, prior) {
    const n = env.length;
    if (n < fps * 4) return null;
    // remove slow trend, keep the peaks
    const x = new Float32Array(n);
    let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n;
    for (let i = 0; i < n; i++) x[i] = Math.max(0, env[i] - mean);
    const minLag = Math.floor(fps * 60 / 260), maxLag = Math.ceil(fps * 60 / 40);
    const acf = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
      let s = 0; for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
      acf[lag] = s / (n - lag);
    }
    // score each lag with its multiples too (a steady beat repeats at 2x and 4x)
    const score = (lag) => {
      const at = (l) => { const i = Math.floor(l), f = l - i; return i + 1 < acf.length ? acf[i] * (1 - f) + acf[i + 1] * f : 0; };
      return at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4);
    };
    let best = -1, bestLag = 0;
    const scores = [];
    for (let lag = Math.max(minLag, Math.floor(fps * 60 / 220)); lag <= Math.min(maxLag, Math.floor(fps * 60 / 45)); lag++) {
      const sc = score(lag); scores.push(sc);
      if (sc > best) { best = sc; bestLag = lag; }
    }
    if (!bestLag || best <= 0) return null;
    // refine with a parabola around the peak
    const y0 = score(bestLag - 1), y1 = best, y2 = score(bestLag + 1);
    const d = (y0 - 2 * y1 + y2) ? 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) : 0;
    let period = bestLag + Math.max(-0.5, Math.min(0.5, d));
    let bpm = 60 * fps / period;
    // confidence: how much the peak stands out
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - avg) * (b - avg), 0) / scores.length) || 1e-9;
    const conf = Math.max(0, Math.min(1, ((best - avg) / sd - 1.5) / 3));
    // half / double (and 3:2 for swing feel): pick the quarter-note tempo nearest the prior
    const target = prior && prior > 30 ? prior : 120;
    let bestB = bpm, bd = Infinity;
    for (const m of [0.5, 2 / 3, 1, 1.5, 2]) {
      const b = bpm * m; if (b < 40 || b > 280) continue;
      const dist = Math.abs(Math.log(b / target)) + (m === 1 ? 0 : 0.08);
      if (dist < bd) { bd = dist; bestB = b; }
    }
    bpm = bestB; period = 60 * fps / bpm;
    // fine-tune the period: try small changes and keep the one whose beat grid lines up best with the onsets
    const comb = (P) => {
      let bestS = -1;
      for (let ph = 0; ph < P; ph += 1) {
        let s = 0, k = 0;
        for (let t = n - 1 - ph; t >= 0; t -= P, k++) { const i = Math.round(t); s += x[i] + 0.5 * ((x[i - 1] || 0) + (x[i + 1] || 0)); }
        if (s > bestS) bestS = s;
      }
      return bestS;
    };
    let bestP = period, bestC = -1;
    for (let f = -0.03; f <= 0.0301; f += 0.0025) { const P = period * (1 + f); const c = comb(P); if (c > bestC) { bestC = c; bestP = P; } }
    period = bestP; bpm = 60 * fps / period;
    // phase: the offset that lines up best with the onsets over the last few seconds
    const win = Math.min(n, Math.round(fps * 6));
    let bp = 0, bs = -1;
    for (let ph = 0; ph < period; ph++) {
      let s = 0;
      for (let t = n - 1 - ph; t >= n - win; t -= period) { const i = Math.round(t); s += x[i] + 0.5 * ((x[i - 1] || 0) + (x[i + 1] || 0)); }
      if (s > bs) { bs = s; bp = ph; }
    }
    return { bpm, conf, period, phase: n - 1 - bp };
  }

  // ---------- live: AudioWorklet on the shared tab audio ----------
  const WORKLET = `${OnsetState.toString()}
    class OnsetProc extends AudioWorkletProcessor {
      constructor() { super(); this.st = new OnsetState(sampleRate); this.frames = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          const out = this.st.process(ch);
          this.frames += ch.length;
          if (out.length) this.port.postMessage({ v: out, end: (currentFrame + ch.length) / sampleRate });
        }
        return true;
      }
    }
    registerProcessor('onset-proc', OnsetProc);`;

  class Listener {
    // stream: MediaStream with an audio track. opts.prior() -> expected BPM; opts.onEstimate(est) every ~0.5 s.
    constructor(stream, opts) { this.stream = stream; this.opts = opts || {}; this.env = []; this.times = []; }
    async start() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'onset-proc');
      this.src.connect(this.node); // not connected to the speakers: you hear the video itself, not a copy
      this.node.port.onmessage = (e) => {
        const { v, end } = e.data;
        for (let i = 0; i < v.length; i++) { this.env.push(v[i]); this.times.push(end - (v.length - i) * 0.01); }
        const keep = 1200; // 12 s
        if (this.env.length > keep) { this.env.splice(0, this.env.length - keep); this.times.splice(0, this.times.length - keep); }
      };
      this.timer = setInterval(() => {
        // last 9 s: long enough to be steady, short enough to follow a band that speeds up
        const off = Math.max(0, this.env.length - 900);
        const est = estimateTempo(this.env.slice(off), 100, this.opts.prior ? this.opts.prior() : null);
        if (est) est.phase += off;
        if (est && this.opts.onEstimate) {
          // the beat's time on the audio clock, and the audio clock "now"
          const idx = Math.max(0, Math.min(this.times.length - 1, Math.round(est.phase)));
          est.beatAudioTime = this.times[idx] + (est.phase - idx) * 0.01;
          est.audioNow = this.ctx.currentTime;
          this.opts.onEstimate(est);
        }
      }, 500);
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }
    stop() { clearInterval(this.timer); try { this.src.disconnect(); this.node.disconnect(); } catch {} try { this.ctx.close(); } catch {} }
  }

  // ---------- one tab share, used by both "Read the chart" and Auto tempo ----------
  const TabShare = {
    stream: null, users: new Set(),
    async get(user, wantAudio) {
      if (this.stream && this.stream.active && (!wantAudio || this.stream.getAudioTracks().length)) { this.users.add(user); return this.stream; }
      if (this.stream) this.stop();
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 5 },
        audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'include'
      });
      this.stream = s; this.users = new Set([user]);
      s.getVideoTracks()[0].addEventListener('ended', () => this.stop());
      return s;
    },
    release(user) { this.users.delete(user); if (!this.users.size) this.stop(); },
    stop() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; this.users.clear(); if (this.onStop) this.onStop(); }
  };

  const api = { OnsetState, estimateTempo, Listener, TabShare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoTempo = api;
})(typeof window !== 'undefined' ? window : globalThis);
