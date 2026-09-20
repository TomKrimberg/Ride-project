// audio.js — All sound in RIDE is generated procedurally with the Web Audio API.
// No audio files are shipped, which keeps the PWA tiny and installable instantly.
//
// createAudioEngine() returns a self-contained controller. It must be unlocked by a
// user gesture (browsers block autoplay) — call engine.unlock() on the first
// pointerdown/touchstart in main.js.

export function createAudioEngine() {
  let ctx = null;
  let masterGain = null;
  let muted = localStorage.getItem('ride_muted') === 'true';

  // Engine sound graph
  let engineOsc = null;
  let engineOsc2 = null;
  let engineGain = null;
  let engineFilter = null;
  let engineRunning = false;

  // Wind/tire noise buffer, reused for skids, crashes and ambient
  let noiseBuffer = null;

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    noiseBuffer = buildNoiseBuffer(ctx, 2.0);
  }

  function buildNoiseBuffer(context, duration) {
    const sampleRate = context.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function unlock() {
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
  }

  // --- Engine loop -----------------------------------------------------
  function startEngine() {
    ensureContext();
    if (engineRunning) return;
    engineRunning = true;

    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 55;

    engineOsc2 = ctx.createOscillator();
    engineOsc2.type = 'square';
    engineOsc2.frequency.value = 55 * 1.995; // slight detune for a richer growl
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;

    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 700;
    engineFilter.Q.value = 0.7;

    engineGain = ctx.createGain();
    engineGain.gain.value = 0.0001;

    engineOsc.connect(engineFilter);
    engineOsc2.connect(subGain).connect(engineFilter);
    engineFilter.connect(engineGain).connect(masterGain);

    engineOsc.start();
    engineOsc2.start();
  }

  function stopEngine() {
    if (!engineRunning) return;
    engineRunning = false;
    const now = ctx.currentTime;
    engineGain.gain.setTargetAtTime(0.0001, now, 0.08);
    engineOsc.stop(now + 0.3);
    engineOsc2.stop(now + 0.3);
    engineOsc = engineOsc2 = engineGain = engineFilter = null;
  }

  // speedRatio: 0..1 of top speed, throttle: 0..1
  function updateEngine(speedRatio, throttle) {
    if (!engineRunning || !ctx) return;
    const now = ctx.currentTime;
    const baseFreq = 45 + speedRatio * 220 + throttle * 35;
    engineOsc.frequency.setTargetAtTime(baseFreq, now, 0.06);
    engineOsc2.frequency.setTargetAtTime(baseFreq * 1.995, now, 0.06);
    engineFilter.frequency.setTargetAtTime(400 + speedRatio * 2600, now, 0.08);
    const targetGain = 0.05 + throttle * 0.08 + speedRatio * 0.03;
    engineGain.gain.setTargetAtTime(targetGain, now, 0.15);
  }

  // --- One-shot effects --------------------------------------------------
  function playNoiseBurst({ duration = 0.3, filterType = 'bandpass', freq = 1200, q = 1, gain = 0.4, fadeOut = true }) {
    ensureContext();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(gain, now);
    if (fadeOut) g.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(filter).connect(g).connect(masterGain);
    src.start(now);
    src.stop(now + duration + 0.05);
    return { src, gain: g };
  }

  function playSkid(intensity = 1) {
    playNoiseBurst({
      duration: 0.25,
      filterType: 'bandpass',
      freq: 1800 + Math.random() * 400,
      q: 3,
      gain: Math.min(0.5, 0.15 + intensity * 0.25)
    });
  }

  function playCrash(intensity = 1) {
    ensureContext();
    // Low thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const oscGain = ctx.createGain();
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.35);
    oscGain.gain.setValueAtTime(Math.min(0.9, 0.4 + intensity * 0.3), now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(oscGain).connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.45);
    // Crunch noise layered on top
    playNoiseBurst({ duration: 0.35, filterType: 'lowpass', freq: 900, q: 0.5, gain: Math.min(0.7, 0.3 + intensity * 0.3) });
  }

  function playCoin() {
    ensureContext();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const g = ctx.createGain();
      const start = now + i * 0.06;
      osc.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(g).connect(masterGain);
      osc.start(start);
      osc.stop(start + 0.25);
    });
  }

  function playClick() {
    ensureContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(520, now);
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(g).connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  function playStarChime(starCount) {
    ensureContext();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < starCount; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      const start = now + i * 0.09;
      osc.frequency.setValueAtTime(notes[Math.min(i, notes.length - 1)], start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.connect(g).connect(masterGain);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('ride_muted', String(muted));
    if (masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    return muted;
  }

  function isMuted() {
    return muted;
  }

  return {
    unlock,
    startEngine,
    stopEngine,
    updateEngine,
    playSkid,
    playCrash,
    playCoin,
    playClick,
    playStarChime,
    toggleMute,
    isMuted
  };
}
