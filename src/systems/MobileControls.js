/**
 * MobileControls.js — On-screen virtual gamepad for mobile / touch devices.
 *
 * Detects touch support and renders a joystick + action buttons overlay.
 * All button presses inject virtual key codes directly into the InputSystem
 * so the rest of the game code is completely unchanged.
 *
 * PC players: overlay is fully hidden (display:none via CSS).
 */

export class MobileControls {
  /**
   * @param {import('./InputSystem.js').InputSystem} inputSystem
   */
  constructor(inputSystem) {
    this.input = inputSystem;
    this.enabled = false;

    /** Joystick drag state */
    this._joystickActive  = false;
    this._joystickStartX  = 0;
    this._joystickStartY  = 0;
    this._joystickTouchId = null;

    /** Currently held virtual keys from joystick */
    this._heldKeys = new Set();

    this._init();
  }

  _isTouchDevice() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  _init() {
    if (!this._isTouchDevice()) return;

    this.enabled = true;
    document.body.classList.add('mobile-device');

    this._bindJoystick();
    this._bindActionButtons();
  }

  // ─── Joystick ──────────────────────────────────────────────────────────────

  _bindJoystick() {
    const base  = document.getElementById('mob-joystick-base');
    const knob  = document.getElementById('mob-joystick-knob');
    if (!base || !knob) return;

    const DEAD_ZONE  = 8;   // px — ignore micro-movements
    const MAX_RADIUS = 42;  // px — maximum knob travel

    const onStart = (clientX, clientY, touchId = null) => {
      this._joystickActive  = true;
      this._joystickTouchId = touchId;
      this._joystickStartX  = clientX;
      this._joystickStartY  = clientY;
      base.classList.add('active');
    };

    const onMove = (clientX, clientY) => {
      if (!this._joystickActive) return;
      const dx = clientX - this._joystickStartX;
      const dy = clientY - this._joystickStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clamped = Math.min(dist, MAX_RADIUS);
      const angle   = Math.atan2(dy, dx);

      // Move knob visually
      const kx = Math.cos(angle) * clamped;
      const ky = Math.sin(angle) * clamped;
      knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

      // Determine which keys to press
      const prevHeld = new Set(this._heldKeys);
      this._heldKeys.clear();

      if (dist > DEAD_ZONE) {
        // Forward / backward (Y axis)
        if (dy < -DEAD_ZONE) this._heldKeys.add('KeyW');
        if (dy > DEAD_ZONE)  this._heldKeys.add('KeyS');
        // Left / right (X axis — steering)
        if (dx < -DEAD_ZONE) this._heldKeys.add('KeyA');
        if (dx > DEAD_ZONE)  this._heldKeys.add('KeyD');
      }

      // Inject / release virtual keys into InputSystem
      const allKeys = new Set([...prevHeld, ...this._heldKeys]);
      for (const key of allKeys) {
        const wasHeld = prevHeld.has(key);
        const isHeld  = this._heldKeys.has(key);
        if (!wasHeld && isHeld)  this.input.injectKeyDown(key);
        if (wasHeld  && !isHeld) this.input.injectKeyUp(key);
      }
    };

    const onEnd = () => {
      if (!this._joystickActive) return;
      this._joystickActive  = false;
      this._joystickTouchId = null;
      knob.style.transform  = 'translate(-50%, -50%)';
      base.classList.remove('active');

      // Release all held joystick keys
      for (const key of this._heldKeys) this.input.injectKeyUp(key);
      this._heldKeys.clear();
    };

    // Touch events
    base.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onStart(t.clientX, t.clientY, t.identifier);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joystickTouchId) {
          e.preventDefault();
          onMove(t.clientX, t.clientY);
          return;
        }
      }
    }, { passive: false });

    window.addEventListener('touchend',    (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joystickTouchId) { onEnd(); return; }
      }
    });
    window.addEventListener('touchcancel', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joystickTouchId) { onEnd(); return; }
      }
    });
  }

  // ─── Action buttons ────────────────────────────────────────────────────────

  _bindActionButtons() {
    /**
     * Each entry: { id: DOM element id, key: InputSystem key code, mode: 'hold'|'tap' }
     * 'hold' — key stays down while finger is on button
     * 'tap'  — key fires justPressed for one frame, then releases
     */
    const buttons = [
      { id: 'mob-btn-fire',    key: 'Space',   mode: 'tap'  },
      { id: 'mob-btn-anchor',  key: 'KeyQ',    mode: 'hold' },
      { id: 'mob-btn-board',   key: 'KeyB',    mode: 'tap'  },
      { id: 'mob-btn-repair',  key: 'KeyR',    mode: 'tap'  },
      { id: 'mob-btn-capture', key: 'KeyE',    mode: 'tap'  },
      { id: 'mob-btn-journal', key: 'KeyJ',    mode: 'tap'  },
      { id: 'mob-btn-pause',   key: 'Escape',  mode: 'tap'  },
    ];

    for (const { id, key, mode } of buttons) {
      const el = document.getElementById(id);
      if (!el) continue;

      if (mode === 'hold') {
        el.addEventListener('touchstart', (e) => {
          e.preventDefault();
          this.input.injectKeyDown(key);
          el.classList.add('pressed');
        }, { passive: false });

        const release = (e) => {
          e.preventDefault();
          this.input.injectKeyUp(key);
          el.classList.remove('pressed');
        };
        el.addEventListener('touchend',    release, { passive: false });
        el.addEventListener('touchcancel', release, { passive: false });

      } else {
        // tap — press + release in the same handler so justPressed fires once
        el.addEventListener('touchstart', (e) => {
          e.preventDefault();
          this.input.injectKeyDown(key);
          el.classList.add('pressed');
          // Release after one frame so justPressed is detected
          requestAnimationFrame(() => {
            this.input.injectKeyUp(key);
            el.classList.remove('pressed');
          });
        }, { passive: false });
      }
    }
  }

  destroy() {
    // Release all held keys on cleanup
    for (const key of this._heldKeys) this.input.injectKeyUp(key);
    this._heldKeys.clear();
  }
}

export default MobileControls;
