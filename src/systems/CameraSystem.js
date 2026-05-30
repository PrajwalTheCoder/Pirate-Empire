/**
 * CameraSystem — smooth third-person follow camera.
 * The camera lerps each frame toward a position behind and above the target.
 */
import * as THREE from 'three';
import GameConfig from '../config/GameConfig.js';
import { lerp } from '../utils/MathUtils.js';

export class CameraSystem {
  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Scene}  scene
   */
  constructor(camera, scene) {
    this._camera = camera;
    this._scene  = scene;

    /** @type {THREE.Object3D|null} */
    this._target = null;

    // Working vectors reused each frame (avoids GC pressure)
    this._desiredPos   = new THREE.Vector3();
    this._offset       = new THREE.Vector3(
      GameConfig.CAMERA_OFFSET_X,
      GameConfig.CAMERA_OFFSET_Y,
      GameConfig.CAMERA_OFFSET_Z,
    );
    this._lookAtTarget = new THREE.Vector3();

    // Cinematic focus target (for dialogue)
    this._focusTarget = null;
    this._focusTimer = 0;

    // Initialise camera to a sensible default
    camera.position.set(0, GameConfig.CAMERA_OFFSET_Y, GameConfig.CAMERA_OFFSET_Z);
    camera.lookAt(0, 1.5, 0);
  }

  /** Set the ship group the camera should follow. */
  setTarget(object3D) {
    this._target = object3D;
  }

  /** Focus camera on a conversational target (Object3D or Vector3) for dialogue. */
  setFocusTarget(target, duration = 6500) {
    this._focusTarget = target;
    this._focusTimer  = duration;
  }

  /** Clear focus and return to standard third-person follow. */
  clearFocus() {
    this._focusTarget = null;
    this._focusTimer  = 0;
  }

  /** @param {number} delta */
  update(delta) {
    if (this._cinematicMode) {
      this._updateCinematic(delta);
      return;
    }
    if (!this._target) return;

    const t = this._target;

    // Cinematic focus target logic
    if (this._focusTarget) {
      const focusPos = this._focusTarget.position || this._focusTarget; // Object3D or Vector3
      
      // Calculate midpoint between player ship and focus target
      const midpoint = new THREE.Vector3().addVectors(t.position, focusPos).multiplyScalar(0.5);
      midpoint.y += 1.5;

      // Find the look-away direction from the midpoint to place the camera
      const direction = new THREE.Vector3().subVectors(t.position, focusPos).normalize();
      if (direction.lengthSq() === 0) direction.set(0, 0, 1);

      // Scale the camera distance based on separation
      const distance = t.position.distanceTo(focusPos);
      const pullBack = Math.max(28, Math.min(75, distance * 0.9));
      
      this._desiredPos.copy(midpoint).addScaledVector(direction, pullBack);
      // Elevate camera slightly
      this._desiredPos.y = Math.max(16, GameConfig.CAMERA_OFFSET_Y * 0.95 + distance * 0.15);

      // Lerp position for smooth cinematic pan
      this._camera.position.x = lerp(this._camera.position.x, this._desiredPos.x, delta * 2.2);
      this._camera.position.y = lerp(this._camera.position.y, this._desiredPos.y, delta * 1.8);
      this._camera.position.z = lerp(this._camera.position.z, this._desiredPos.z, delta * 2.2);

      // Point at midpoint
      this._camera.lookAt(midpoint);

      // Tick focus duration timer
      if (this._focusTimer > 0) {
        this._focusTimer -= delta;
        if (this._focusTimer <= 0) {
          this.clearFocus();
        }
      }
      return;
    }

    // Compute desired camera position in world space using ship's rotation
    this._desiredPos.copy(this._offset)
      .applyQuaternion(t.quaternion)
      .add(t.position);

    // Lerp camera position for smooth lag
    const lag = GameConfig.CAMERA_LAG;
    this._camera.position.x = lerp(this._camera.position.x, this._desiredPos.x, lag);
    this._camera.position.y = lerp(this._camera.position.y, this._desiredPos.y, lag * 1.5);
    this._camera.position.z = lerp(this._camera.position.z, this._desiredPos.z, lag);

    // Look at a point slightly in front of and above the waterline
    this._lookAtTarget.copy(t.position);
    this._lookAtTarget.y += 1.5;
    this._camera.lookAt(this._lookAtTarget);
  }

  /**
   * Enter cinematic orbit mode — camera slowly circles a fixed world position.
   * Call once when the player ship is destroyed.
   * @param {THREE.Vector3} worldPos
   */
  startCinematic(worldPos) {
    this._cinematicPos    = worldPos.clone();
    this._cinematicPos.y  = 0;
    // Start angle from current camera bearing so there's no jump
    this._cinematicAngle  = Math.atan2(
      this._camera.position.x - worldPos.x,
      this._camera.position.z - worldPos.z,
    );
    this._cinematicMode   = true;
  }

  _updateCinematic(delta) {
    // Slowly orbit around the death position
    this._cinematicAngle += delta * 0.35;

    const radius = 38;
    const tx = this._cinematicPos.x + Math.sin(this._cinematicAngle) * radius;
    const tz = this._cinematicPos.z + Math.cos(this._cinematicAngle) * radius;

    // Smoothly drift up and back to get a dramatic wide shot
    this._camera.position.x = lerp(this._camera.position.x, tx, delta * 1.2);
    this._camera.position.y = lerp(this._camera.position.y, 32, delta * 0.5);
    this._camera.position.z = lerp(this._camera.position.z, tz, delta * 1.2);

    this._camera.lookAt(
      this._cinematicPos.x,
      2,
      this._cinematicPos.z,
    );
  }
}

export default CameraSystem;
