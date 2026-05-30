/**
 * MathUtils — shared math helpers used across all game systems.
 */

/** Linear interpolation between a and b by factor t (0–1). */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp value v between min and max. */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Random float between min (inclusive) and max (exclusive). */
export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** Random integer between min and max (both inclusive). */
export function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Pick a random element from an array. */
export function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Test overlap between two spheres.
 * @param {import('three').Vector3} posA
 * @param {import('three').Vector3} posB
 * @param {number} radius
 */
export function sphereOverlap(posA, posB, radius) {
  const dx = posA.x - posB.x;
  const dy = posA.y - posB.y;
  const dz = posA.z - posB.z;
  return (dx * dx + dy * dy + dz * dz) < (radius * radius);
}

/**
 * Distance (2D, XZ plane) between two Vector3-like objects.
 */
export function dist2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Return angle (radians) from position a toward position b on XZ plane.
 */
export function angleTo(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/**
 * Wrap angle to [-PI, PI].
 */
export function wrapAngle(angle) {
  while (angle > Math.PI)  angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Project a Three.js world position to screen (x/y in pixels).
 * @param {import('three').Vector3} worldPos
 * @param {import('three').Camera} camera
 * @param {HTMLCanvasElement} canvas
 * @returns {{ x: number, y: number }}
 */
export function worldToScreen(worldPos, camera, canvas) {
  const v = worldPos.clone().project(camera);
  return {
    x: ( v.x * 0.5 + 0.5) * canvas.clientWidth,
    y: (-v.y * 0.5 + 0.5) * canvas.clientHeight,
  };
}
