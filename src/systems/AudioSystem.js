/**
 * AudioSystem — procedurally synthesised immersive audio.
 *
 * All sounds are generated with the Web Audio API — zero external files.
 * The AudioContext is created on the first user gesture (Play button) to
 * satisfy browser autoplay policy.
 *
 * Ambient sounds
 *   • Ocean waves — low-pass filtered noise with a slow swell LFO
 *   • Wind        — bandpass noise whose pitch shifts with player speed
 *
 * One-shot SFX (distance-attenuated)
 *   • Cannon boom     — sub-bass thump + noise crack + sawtooth snap
 *   • Ship creak      — narrow bandpass noise burst, periodic while moving
 *   • Ship explosion  — deep frequency sweep + long noise burst
 */

import EventEmitter from '../utils/EventEmitter.js';

export class AudioSystem {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;

    /** @type {GainNode|null} */
    this._masterGain = null;
    /** @type {GainNode|null} */
    this._ambGain    = null;
    /** @type {GainNode|null} */
    this._sfxGain    = null;

    // Wind gain node reference so we can modulate it each frame
    this._windGain = null;

    // Per-frame creak timer
    this._creakTimer = 0;

    /** @type {import('./ShipSystem.js').Ship|null} */
    this._playerShip = null;

    // Volume settings 0..1  (mirrored from settings sliders)
    this._masterVol = 0.8;
    this._sfxVol    = 0.8;

    this._started = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Must be called from inside a user-gesture handler (e.g. Play button).
   * Creates the AudioContext, starts ambient loops and registers event hooks.
   */
  start() {
    if (this._started) return;
    this._started = true;

    this._ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Resume in case browser suspended it immediately
    if (this._ctx.state === 'suspended') this._ctx.resume();

    // ── Master gain → destination
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = this._masterVol;
    this._masterGain.connect(this._ctx.destination);

    // ── Ambient sub-bus (waves + wind feed into this)
    this._ambGain = this._ctx.createGain();
    this._ambGain.gain.value = 0.55;
    this._ambGain.connect(this._masterGain);

    // ── SFX sub-bus (cannon, creak, explosion feed into this)
    this._sfxGain = this._ctx.createGain();
    this._sfxGain.gain.value = this._sfxVol;
    this._sfxGain.connect(this._masterGain);

    this._startWaves();
    this._startWind();
    this._bindEvents();
  }

  /** Reference to the player ship so SFX can distance-attenuate. */
  setPlayerShip(ship) {
    this._playerShip = ship;
  }

  /**
   * Apply volume settings from the settings panel sliders.
   * @param {number} master  0..1
   * @param {number} sfx     0..1
   */
  setVolumes(master, sfx) {
    this._masterVol = master;
    this._sfxVol    = sfx;
    if (!this._ctx) return;
    const t = this._ctx.currentTime;
    this._masterGain?.gain.setTargetAtTime(master, t, 0.08);
    this._sfxGain?.gain.setTargetAtTime(sfx,    t, 0.08);
  }

  /** Play book-flipping/parchment-rustle sound effect. */
  playPageTurn() {
    this._playPageTurn();
  }

  /**
   * Call every frame from the game loop.
   * Drives the ship-creak timer and wind-volume dynamics.
   * @param {number} delta  seconds since last frame
   */
  update(delta) {
    if (!this._ctx || !this._playerShip) return;

    const speed = this._playerShip.velocity?.length() ?? 0;

    // ── Ship creak — play periodically whenever the ship is moving
    if (speed > 0.8) {
      this._creakTimer -= delta;
      if (this._creakTimer <= 0) {
        this._playCreak();
        this._creakTimer = 4 + Math.random() * 5; // every 4–9 s
      }
    }

    // ── Wind volume rises with ship speed (calm at rest, howling at full sail)
    if (this._windGain) {
      const targetVol = 0.10 + Math.min(speed * 0.035, 0.40);
      this._windGain.gain.setTargetAtTime(targetVol, this._ctx.currentTime, 0.6);
    }
  }

  // ── Private: event binding ────────────────────────────────────────────────

  _bindEvents() {
    EventEmitter.on('combat:fired', ({ ship }) => {
      this._playCannonBoom(ship);
    });

    EventEmitter.on('ship:destroyed', ({ ship }) => {
      const pos = ship?.group?.position;
      if (pos) this._playExplosion(pos);
    });

    // Loot / chest collected — bright chime
    EventEmitter.on('loot:collected', () => this._playCollect());
    EventEmitter.on('chest:collected', () => this._playCollect());

    // Island captured — triumphant chord
    EventEmitter.on('island:captured', () => this._playCapture());

    // Player ship struck by cannonball — hull thud
    EventEmitter.on('ship:hit', ({ ship }) => {
      if (ship?.faction === 'PLAYER') {
        this._playHullHit(ship.group.position);
      }
    });
  }

  // ── Private: SFX helpers ────────────────────────────────────────────────────

  /** Procedural page-turn / parchment rustle sound for the Journal. */
  _playPageTurn() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const dur  = 0.28;
    const nBuf = this._makeNoiseBuf(dur);
    const src  = ctx.createBufferSource();
    src.buffer = nBuf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + 0.12);
    bp.frequency.exponentialRampToValueAtTime(600, now + dur);
    bp.Q.value = 4.0;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this._masterGain);

    src.start(now);
    src.stop(now + dur);
  }

  /** Short rising chime when loot is collected. */
  _playCollect() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(1400, ctx.currentTime + 0.15);
    amp.gain.setValueAtTime(0.25, ctx.currentTime);
    amp.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
    osc.connect(amp);
    amp.connect(this._masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  }

  /** Triumphant two-note chord when an island is captured. */
  _playCapture() {
    if (!this._ctx) return;
    const ctx  = this._ctx;
    const amp  = ctx.createGain();
    amp.gain.setValueAtTime(0.22, ctx.currentTime);
    amp.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.7);
    amp.connect(this._masterGain);
    for (const freq of [440, 554, 660]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(amp);
      osc.start();
      osc.stop(ctx.currentTime + 0.72);
    }
  }

  /** Low hull-thud when the player is hit. */
  _playHullHit(pos) {
    if (!this._ctx) return;
    const ctx  = this._ctx;
    const vol  = this._distVol(pos, 300);
    if (vol < 0.01) return;

    // White-noise burst filtered to a low thud
    const sr     = ctx.sampleRate;
    const len    = Math.ceil(sr * 0.18);
    const buf    = ctx.createBuffer(1, len, sr);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src  = ctx.createBufferSource();
    src.buffer = buf;

    const lp         = ctx.createBiquadFilter();
    lp.type           = 'lowpass';
    lp.frequency.value = 320;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(vol * 0.6, ctx.currentTime);
    amp.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);

    src.connect(lp);
    lp.connect(amp);
    amp.connect(this._masterGain);
    src.start();
  }

  // ── Private: ambient — ocean waves ───────────────────────────────────────

  _startWaves() {
    const ctx    = this._ctx;
    const sr     = ctx.sampleRate;
    // 4-second noise buffer, looped — long enough that the loop is inaudible
    const bufLen = sr * 4;
    const buf    = ctx.createBuffer(1, bufLen, sr);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src   = ctx.createBufferSource();
    src.buffer  = buf;
    src.loop    = true;

    // Low-pass: keeps the oceanic rumble, removes distracting hiss
    const lp         = ctx.createBiquadFilter();
    lp.type           = 'lowpass';
    lp.frequency.value = 480;
    lp.Q.value         = 0.9;

    // Slow amplitude LFO simulates wave swells (~5.5 s period)
    const lfo      = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value  = 0.18;
    lfoDepth.gain.value  = 0.30;
    lfo.connect(lfoDepth);

    const waveGain       = ctx.createGain();
    waveGain.gain.value  = 0.52;
    lfoDepth.connect(waveGain.gain); // LFO modulates wave amplitude

    src.connect(lp);
    lp.connect(waveGain);
    waveGain.connect(this._ambGain);

    lfo.start();
    src.start();
  }

  // ── Private: ambient — wind ───────────────────────────────────────────────

  _startWind() {
    const ctx    = this._ctx;
    const sr     = ctx.sampleRate;
    const bufLen = sr * 3;
    const buf    = ctx.createBuffer(1, bufLen, sr);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src   = ctx.createBufferSource();
    src.buffer  = buf;
    src.loop    = true;

    // Bandpass centred on ~600 Hz gives the airy whistle character
    const bp        = ctx.createBiquadFilter();
    bp.type           = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value         = 0.35;

    // High-pass removes low-frequency overlap with waves
    const hp        = ctx.createBiquadFilter();
    hp.type           = 'highpass';
    hp.frequency.value = 280;

    // Very slow LFO shifts the centre frequency (wind gusts)
    const lfo      = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoDepth.gain.value = 130;
    lfo.connect(lfoDepth);
    lfoDepth.connect(bp.frequency);

    // Start quiet — update() will modulate this based on ship speed
    const windGain       = ctx.createGain();
    windGain.gain.value  = 0.10;
    this._windGain       = windGain;

    src.connect(bp);
    bp.connect(hp);
    hp.connect(windGain);
    windGain.connect(this._ambGain);

    lfo.start();
    src.start();
  }

  // ── Private: SFX — cannon boom ───────────────────────────────────────────

  _playCannonBoom(ship) {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    // Distance attenuation — enemy cannons sound quieter if far away
    const vol = this._distVol(ship?.group?.position, 180);

    // 1. Sub-bass thump (gives the gut-punch feel)
    const thump     = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = 'sine';
    thump.frequency.value = 52;
    thumpGain.gain.setValueAtTime(vol * 0.85, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    thump.connect(thumpGain);
    thumpGain.connect(this._sfxGain);
    thump.start(now);
    thump.stop(now + 0.38);

    // 2. Noise crack (the actual blast)
    const nBuf = this._makeNoiseBuf(0.55);
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const lp        = ctx.createBiquadFilter();
    lp.type          = 'lowpass';
    lp.frequency.value = 2400;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(vol * 0.65, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);
    nSrc.connect(lp);
    lp.connect(nGain);
    nGain.connect(this._sfxGain);
    nSrc.start(now);
    nSrc.stop(now + 0.55);

    // 3. Sawtooth snap (attack transient / fizz)
    const snap     = ctx.createOscillator();
    const snapGain = ctx.createGain();
    snap.type = 'sawtooth';
    snap.frequency.setValueAtTime(200, now);
    snap.frequency.exponentialRampToValueAtTime(38, now + 0.07);
    snapGain.gain.setValueAtTime(vol * 0.45, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    snap.connect(snapGain);
    snapGain.connect(this._sfxGain);
    snap.start(now);
    snap.stop(now + 0.07);
  }

  // ── Private: SFX — wood creak ────────────────────────────────────────────

  _playCreak() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const dur  = 0.35 + Math.random() * 0.15;
    const nBuf = this._makeNoiseBuf(dur + 0.05);
    const src  = ctx.createBufferSource();
    src.buffer = nBuf;
    // Slight pitch variation each creak
    src.playbackRate.value = 0.55 + Math.random() * 0.55;

    // Very narrow bandpass → woody "creak" timbre
    const bp        = ctx.createBiquadFilter();
    bp.type          = 'bandpass';
    bp.frequency.value = 320 + Math.random() * 380;
    bp.Q.value         = 10;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this._sfxGain);
    src.start(now);
    src.stop(now + dur + 0.05);
  }

  // ── Private: SFX — ship explosion ────────────────────────────────────────

  _playExplosion(position) {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const vol = this._distVol(position, 250);

    // 1. Deep frequency sweep (the "BOOM" that shakes the hull)
    const osc    = ctx.createOscillator();
    const oGain  = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(65, now);
    osc.frequency.exponentialRampToValueAtTime(18, now + 1.1);
    oGain.gain.setValueAtTime(vol * 1.1, now);
    oGain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    osc.connect(oGain);
    oGain.connect(this._sfxGain);
    osc.start(now);
    osc.stop(now + 1.3);

    // 2. Long noise burst with low-pass (debris / fire roar)
    const nBuf = this._makeNoiseBuf(1.5);
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const lp        = ctx.createBiquadFilter();
    lp.type          = 'lowpass';
    lp.frequency.value = 1600;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(vol * 0.85, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    nSrc.connect(lp);
    lp.connect(nGain);
    nGain.connect(this._sfxGain);
    nSrc.start(now);
    nSrc.stop(now + 1.5);

    // 3. High-mid crack transient (initial impact)
    const nBuf2 = this._makeNoiseBuf(0.12);
    const nSrc2 = ctx.createBufferSource();
    nSrc2.buffer = nBuf2;
    const hp        = ctx.createBiquadFilter();
    hp.type          = 'highpass';
    hp.frequency.value = 1200;
    const nGain2 = ctx.createGain();
    nGain2.gain.setValueAtTime(vol * 0.6, now);
    nGain2.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    nSrc2.connect(hp);
    hp.connect(nGain2);
    nGain2.connect(this._sfxGain);
    nSrc2.start(now);
    nSrc2.stop(now + 0.12);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Create a mono white-noise AudioBuffer of the given duration.
   * @param {number} seconds
   * @returns {AudioBuffer}
   */
  _makeNoiseBuf(seconds) {
    const sr  = this._ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this._ctx.createBuffer(1, len, sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Compute a 0..1 volume based on distance from the player ship.
   * @param {THREE.Vector3|null|undefined} worldPos  — position of the sound source
   * @param {number} maxDist                          — distance at which vol → ~0.05
   * @returns {number}
   */
  _distVol(worldPos, maxDist) {
    if (!this._playerShip || !worldPos) return 1.0;
    const dist = this._playerShip.group.position.distanceTo(worldPos);
    return Math.max(0.04, 1 - dist / maxDist);
  }
}

export default AudioSystem;
