/**
 * SkySystem — configures scene background, fog, and lighting.
 * Includes a sky-dome hemisphere mesh with a vertical colour gradient
 * so the horizon blends warm while the zenith stays deep blue.
 *
 * Atmospheric extras
 *   • Thicker exponential fog that thickens at the horizon
 *   • A low-lying sea-mist plane (transparent, animated billboard quad ring)
 *     just above the water surface for a moody coastal atmosphere
 */
import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';

// Sky-dome gradient shader — zenith deep blue → horizon warm haze
// uNight blends toward a dark-navy night palette (0=day, 1=night)
const skyVertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos   = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const skyFragmentShader = /* glsl */ `
  uniform float uNight;
  uniform float uBloodMoon;
  varying vec3 vWorldPos;
  void main() {
    float t = clamp(vWorldPos.y / 480.0, 0.0, 1.0);
    vec3 zenith  = vec3(0.18, 0.38, 0.72);
    vec3 horizon = vec3(0.69, 0.86, 0.96);
    vec3 dayColor   = mix(horizon, zenith, t * t);
    vec3 nightZen   = vec3(0.01, 0.01, 0.10);
    vec3 nightHor   = vec3(0.03, 0.05, 0.15);
    vec3 nightColor = mix(nightHor, nightZen, t * t);
    vec3 baseColor  = mix(dayColor, nightColor, uNight);
    
    vec3 bloodZen   = vec3(0.15, 0.01, 0.01);
    vec3 bloodHor   = vec3(0.40, 0.03, 0.03);
    vec3 bloodColor = mix(bloodHor, bloodZen, t * t);
    
    gl_FragColor = vec4(mix(baseColor, bloodColor, uBloodMoon), 1.0);
  }
`;

// Sea-mist shader — a wide flat ring that fades from centre outward
const mistVertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2  vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const mistFragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2  vUv;
  void main() {
    // Radial fade: fully transparent at centre (near camera), opaque mid-ring,
    // fully transparent at outer edge (far horizon handled by scene fog)
    float r     = length(vUv - 0.5) * 2.0;   // 0 = centre, 1 = edge
    float alpha = smoothstep(0.35, 0.62, r) * (1.0 - smoothstep(0.72, 1.0, r));

    // Slight animated opacity shimmer
    alpha *= 0.28 + 0.06 * sin(uTime * 0.4 + vUv.x * 8.0);

    vec3 mistColor = vec3(0.78, 0.90, 0.97);   // pale sea-haze blue
    gl_FragColor   = vec4(mistColor, alpha);
  }
`;

export class SkySystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this._scene     = scene;
    this._sunAngle  = 0;
    this._time      = 0;
    this._bloodMoonIntensity = 0; // Blood Moon dynamic strength

    // ── Background colour (horizon sky blue) ──────────────────────────────────
    scene.background = new THREE.Color(0x87ceeb);

    // ── Exponential fog — thicker than before for a moody pirate-sea feel ────
    // density 0.0012 ≈ objects start blending into sky at ~400 units
    scene.fog = new THREE.FogExp2(0x9ac8d8, 0.0012);

    // ── Ambient light (soft warm fill) ────────────────────────────────────────
    this._ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(this._ambient);

    // ── Directional sun light ─────────────────────────────────────────────────
    this._sun = new THREE.DirectionalLight(0xfff8e0, 1.6);
    this._sun.position.set(200, 300, 100);
    this._sun.castShadow = true;

    // Shadow map quality
    const shadowCam = this._sun.shadow.camera;
    shadowCam.near   = 1;
    shadowCam.far    = 600;
    shadowCam.left   = -200;
    shadowCam.right  =  200;
    shadowCam.top    =  200;
    shadowCam.bottom = -200;
    this._sun.shadow.mapSize.set(2048, 2048);
    this._sun.shadow.bias = -0.0005;

    scene.add(this._sun);
    scene.add(this._sun.target);

    // ── Secondary fill light (cool blue from opposite side) ───────────────────
    this._fill = new THREE.DirectionalLight(0x8ab4d4, 0.35);
    this._fill.position.set(-80, 60, -60);
    scene.add(this._fill);

    // ── Hemisphere sky/ground light ───────────────────────────────────────────
    this._hemi = new THREE.HemisphereLight(0x87ceeb, 0x5a4020, 0.5);
    scene.add(this._hemi);

    // ── Sky dome mesh ─────────────────────────────────────────────────────────
    this._domeMat = new THREE.ShaderMaterial({
      vertexShader:   skyVertexShader,
      fragmentShader: skyFragmentShader,
      uniforms: { 
        uNight: { value: 0 },
        uBloodMoon: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const domeGeo  = new THREE.SphereGeometry(500, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    this._dome     = new THREE.Mesh(domeGeo, this._domeMat);
    this._dome.renderOrder = -1;
    scene.add(this._dome);

    // ── Sea-mist plane — low ring just above water surface ───────────────────
    // A large flat plane centred on the player; the shader makes it transparent
    // near the player and near the outer edge, giving only a mid-distance haze.
    this._mistMat = new THREE.ShaderMaterial({
      vertexShader:   mistVertexShader,
      fragmentShader: mistFragmentShader,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    const mistGeo    = new THREE.PlaneGeometry(1400, 1400);
    this._mistMesh   = new THREE.Mesh(mistGeo, this._mistMat);
    this._mistMesh.rotation.x    = -Math.PI / 2;
    this._mistMesh.position.y    = 1.8;   // just above the wave tops
    this._mistMesh.renderOrder   = 1;     // render after opaque ocean
    scene.add(this._mistMesh);

    // Make shadow camera follow the player (set each frame)
    this._playerRef = null;

    // Day/night cycle state (full cycle = 600 s)
    this._dayPhase      = 0;      // 0 → 1 → 0  (0=noon, 0.5=midnight)
    this._nightFraction = 0;
    this._wasNight      = false;
    this._stormIntensity = 0;
  }

  /** Set the player ship group so the shadow camera tracks it. */
  setPlayerRef(shipGroup) {
    this._playerRef = shipGroup;
  }

  /** @param {number} delta */
  update(delta) {
    this._time     += delta;
    this._sunAngle += delta * 0.005;

    // ── Day/Night cycle (600 s per full day) ────────────────────────────────
    this._dayPhase += delta / 300.0;                       // 0→1→0 each 600 s
    const rawNight = (1 - Math.cos(this._dayPhase * Math.PI * 2)) * 0.5;  // 0=day→1=midnight
    const night    = Math.pow(rawNight, 1.4);              // make days longer than nights
    this._nightFraction = night;

    // Emit events at dawn/dusk so other systems can react
    const isNight = night > 0.55;
    if (isNight !== this._wasNight) {
      this._wasNight = isNight;
      EventEmitter.emit(isNight ? 'sky:night' : 'sky:day', { night });
    }

    // Sky dome shader
    this._domeMat.uniforms.uNight.value = Math.min(1, night + this._stormIntensity * 0.3);
    this._domeMat.uniforms.uBloodMoon.value = this._bloodMoonIntensity;

    const bloodMoonActive = this._bloodMoonIntensity > 0.02;

    // Scene background colour
    let bg = new THREE.Color(0x87ceeb).lerp(new THREE.Color(0x060a18), night);
    if (bloodMoonActive) {
      const bloodBg = new THREE.Color(0x180303);
      bg.lerp(bloodBg, this._bloodMoonIntensity);
    }
    this._scene.background.copy(bg);

    // Fog colour
    if (this._scene.fog) {
      let fogCol = new THREE.Color(0x9ac8d8).lerp(new THREE.Color(0x06091a), night);
      if (bloodMoonActive) {
        const bloodFog = new THREE.Color(0x280505);
        fogCol.lerp(bloodFog, this._bloodMoonIntensity);
      }
      this._scene.fog.color.copy(fogCol);
    }

    // Lights
    const ambientBase = THREE.MathUtils.lerp(0.55, 0.12, night);
    this._ambient.intensity = THREE.MathUtils.lerp(ambientBase, 0.08, this._bloodMoonIntensity);
    if (bloodMoonActive) {
      this._ambient.color.setRGB(1.0, 1.0 - 0.75 * this._bloodMoonIntensity, 1.0 - 0.75 * this._bloodMoonIntensity);
    } else {
      this._ambient.color.setHex(0xffffff);
    }

    const sunBase = THREE.MathUtils.lerp(1.6, 0.15, night);
    this._sun.intensity = THREE.MathUtils.lerp(sunBase, 0.20, this._bloodMoonIntensity);
    if (bloodMoonActive) {
      this._sun.color.setRGB(1.0, 1.0 - 0.88 * this._bloodMoonIntensity, 1.0 - 0.88 * this._bloodMoonIntensity);
    } else {
      this._sun.color.setHex(0xfff8e0);
    }

    // Moonlight fill
    if (bloodMoonActive) {
      this._fill.color.setRGB(0.65, 0.1, 0.1);
      this._fill.intensity = THREE.MathUtils.lerp(0.35, 0.45, this._bloodMoonIntensity);
    } else {
      this._fill.color.set(night > 0.5 ? 0x4466aa : 0x8ab4d4);
      this._fill.intensity = THREE.MathUtils.lerp(0.35, 0.5, night);
    }

    this._mistMat.uniforms.uTime.value = this._time;

    // Move shadow frustum, sky dome, and mist to follow player
    if (this._playerRef) {
      const p = this._playerRef.position;
      this._sun.target.position.set(p.x, 0, p.z);
      this._sun.target.updateMatrixWorld();
      this._dome.position.set(p.x, 0, p.z);
      this._mistMesh.position.set(p.x, 1.8, p.z);
    }
  }

  /**
   * Called by main.js to darken sky during storms (0 = calm, 1 = storm).
   * @param {number} t
   */
  setStormIntensity(t) {
    this._stormIntensity = t;
  }

  /**
   * Set Blood Moon visual intensity (0 = none, 1 = maximum blood red).
   * @param {number} val
   */
  setBloodMoonIntensity(val) {
    this._bloodMoonIntensity = val;
  }

  /** 0 = full day, 1 = midnight. */
  get nightFraction() { return this._nightFraction; }
}

export default SkySystem;
