/**
 * Ocean — animated wave plane using a custom ShaderMaterial.
 * The time uniform advances each frame to create rolling wave motion.
 */
import * as THREE from 'three';

// ── GLSL shaders ──────────────────────────────────────────────────────────────

// Standalone GLSL function used in both vertex shader and JS (kept in sync)
const WAVE_GLSL = /* glsl */ `
  float waveH(float x, float y, float t) {
    float e  = sin(x * 0.05  + t * 1.2) * 0.6;
         e += cos(y * 0.04   + t * 0.9) * 0.5;
         e += sin((x + y) * 0.03 + t * 0.7) * 0.3;
         e += cos(x * 0.012  - t * 0.4) * 0.15;
    return e;
  }
`;

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2  vUv;
  varying float vElevation;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

  ${WAVE_GLSL}

  void main() {
    vUv = uv;

    // Displace in local Z — after rotation.x=-π/2, local Z maps to world Y
    float e   = waveH(position.x, position.y, uTime);
    vec3  disp = vec3(position.x, position.y, position.z + e);

    vElevation = e;
    vWorldPos  = (modelMatrix * vec4(disp, 1.0)).xyz;

    // Surface normal from analytical wave gradient (central differences)
    float eps  = 2.0;
    float dhdx = (waveH(position.x + eps, position.y, uTime)
                - waveH(position.x - eps, position.y, uTime)) / (2.0 * eps);
    float dhdy = (waveH(position.x, position.y + eps, uTime)
                - waveH(position.x, position.y - eps, uTime)) / (2.0 * eps);
    // tangent_x=(1,0,dhdx), tangent_y=(0,1,dhdy) → normal=cross=(-dhdx,-dhdy,1)
    vec3 localNorm  = normalize(vec3(-dhdx, -dhdy, 1.0));
    vWorldNormal    = normalize(mat3(modelMatrix) * localNorm);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(disp, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  varying vec2  vUv;
  varying float vElevation;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

  void main() {
    // Dynamic light direction (Sun during day, Moon during night)
    vec3 dayLightDir   = normalize(vec3(200.0, 300.0, 100.0));
    vec3 nightLightDir = normalize(vec3(-80.0, 60.0, -60.0));
    vec3 lightDir      = normalize(mix(dayLightDir, nightLightDir, uNight));

    // ── Ocean colour: near (bright turquoise) → far (deep navy) ─────────────
    // Interpolates to a very dark navy/teal base color at night
    vec3 dayNearColor   = vec3(0.161, 0.710, 0.910);  // #29b5e8 — shallow day
    vec3 dayFarColor    = vec3(0.039, 0.153, 0.267);  // #0a2744 — deep day
    vec3 nightNearColor = vec3(0.012, 0.054, 0.090);  // shallow night
    vec3 nightFarColor  = vec3(0.004, 0.015, 0.026);  // deep night

    vec3 nearColor = mix(dayNearColor, nightNearColor, uNight);
    vec3 farColor  = mix(dayFarColor, nightFarColor, uNight);
    float distNorm  = clamp(length(vWorldPos.xz) / 900.0, 0.0, 1.0);
    float distFade  = distNorm * distNorm;
    vec3 oceanBase  = mix(nearColor, farColor, distFade);

    // Wave-crest colour shift: troughs darker, crests lighter (darkens at night)
    vec3 deepColor  = mix(vec3(0.043, 0.200, 0.450), vec3(0.005, 0.024, 0.060), uNight);
    vec3 crestColor = mix(vec3(0.302, 0.720, 1.000), vec3(0.045, 0.160, 0.280), uNight);
    float wavT = clamp((vElevation + 1.5) / 3.0, 0.0, 1.0);
    vec3 waterColor = mix(mix(deepColor, crestColor, wavT), oceanBase, 0.55);

    // White foam at wave crests (dimmed and blended with dark tones at night)
    float foam = smoothstep(0.85, 1.35, vElevation);
    vec3 foamColor = mix(vec3(0.90, 0.97, 1.00), vec3(0.10, 0.22, 0.32), uNight);
    waterColor = mix(waterColor, foamColor, foam * mix(0.60, 0.20, uNight));

    // ── Lighting ──────────────────────────────────────────────────────────────
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // Diffuse lighting (much darker ambient baseline at night)
    float NdotL  = max(dot(N, lightDir), 0.0);
    float ambientIntensity = mix(0.30, 0.08, uNight);
    vec3  lit    = waterColor * (ambientIntensity + NdotL * mix(0.70, 0.40, uNight));

    // Specular (Blinn-Phong) — sun glint vs cool blue moonlight glint
    vec3  specColor     = mix(vec3(1.0, 0.97, 0.85), vec3(0.40, 0.65, 1.0), uNight);
    float specIntensity = mix(1.6, 0.45, uNight);
    float specPower     = mix(220.0, 140.0, uNight);
    vec3  H             = normalize(lightDir + V);
    float spec          = pow(max(dot(N, H), 0.0), specPower) * specIntensity;
    lit += specColor * spec;

    // ── Sun/Moon reflection path on water surface ───────────────────────────
    vec3  toFrag      = normalize(vWorldPos - cameraPosition);
    vec3  reflDir     = reflect(toFrag, N);
    float lightAlign  = max(dot(reflDir, lightDir), 0.0);
    float lightPath   = pow(lightAlign, 35.0) * mix(0.55, 0.20, uNight);
    float lightGlare  = pow(lightAlign, 180.0) * mix(1.8, 0.6, uNight);
    vec3  pathColor   = mix(vec3(1.00, 0.92, 0.70), vec3(0.45, 0.70, 1.00), uNight);
    lit += pathColor * (lightPath + lightGlare);

    // Fresnel — bright rim reflection (cool blue-sky during day, dark navy at night)
    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    vec3 fresnelColor = mix(vec3(0.55, 0.82, 1.0), vec3(0.03, 0.06, 0.15), uNight);
    lit = mix(lit, fresnelColor, fresnel * mix(0.45, 0.18, uNight));

    // ── Horizon fog — blends ocean into sky-fog colour at distance ─────────
    vec3 dayFogColor   = vec3(0.56, 0.80, 0.93);   // daytime sky horizon
    vec3 nightFogColor = vec3(0.024, 0.035, 0.102); // matches SkySystem night fog
    vec3 fogColor      = mix(dayFogColor, nightFogColor, uNight);
    float fogAmt       = clamp(distFade * 0.85, 0.0, 0.78);
    lit = mix(lit, fogColor, fogAmt);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

export class Ocean {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this._time = 0;

    // Larger plane for horizon coverage; more segments for smooth waves
    const geometry = new THREE.PlaneGeometry(3000, 3000, 160, 160);

    this._material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime:  { value: 0 },
        uNight: { value: 0 },
      },
      transparent: false,   // opaque — never blend with sky background
      depthWrite: true,
      side: THREE.FrontSide,
    });

    this._mesh = new THREE.Mesh(geometry, this._material);
    this._mesh.rotation.x = -Math.PI / 2;
    this._mesh.position.y = 0;          // sit exactly at sea level
    this._mesh.receiveShadow = true;
    this._mesh.renderOrder  = 0;        // render before ships
    this._mesh.name = 'ocean';

    scene.add(this._mesh);
  }

  /** 
   * @param {number} delta — seconds since last frame
   * @param {number} nightFraction — 0 = day, 1 = night
   */
  update(delta, nightFraction = 0) {
    this._time += delta;
    this._material.uniforms.uTime.value = this._time;
    this._material.uniforms.uNight.value = nightFraction;
  }

  /** Approximate wave height at (x, z) world position — used for ship bobbing.
   *  Amplitudes must match the vertex shader waveH() function. */
  getHeightAt(x, z) {
    const t = this._time;
    let h  = Math.sin(x * 0.05 + t * 1.2) * 0.6;
    h     += Math.cos(z * 0.04 + t * 0.9) * 0.5;
    h     += Math.sin((x + z)  * 0.03 + t * 0.7) * 0.3;
    h     += Math.cos(x * 0.012 - t * 0.4) * 0.15;
    return h;
  }
}

export default Ocean;
