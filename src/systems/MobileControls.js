/**
 * MobileControls.js — On-screen virtual gamepad for mobile / touch devices.
 *
 * Detects touch support and renders:
 *   • A fullscreen button (eliminates browser chrome)
 *   • A virtual joystick (left side)
 *   • Action buttons (right side)
 *   • A ☰ menu button to toggle the bottom panel
 *
 * All button presses inject virtual key codes into InputSystem —
 * the rest of the game is completely unchanged.
 *
 * PC players: overlay is fully hidden (display:none via CSS).
 */

export class MobileControls {
  /** @param {import('./InputSystem.js').InputSystem} inputSystem */
  constructor(inputSystem) {
    this.input = inputSystem;
    this.enabled = false;

    this._joystickActive  = false;
    this._joystickStartX  = 0;
    this._joystickStartY  = 0;
    this._joystickTouchId = null;
    this._heldKeys        = new Set();

    this._menuOpen = false;

    this._init();
  }

  _isTouchDevice() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  _init() {
    if (!this._isTouchDevice()) return;

    this.enabled = true;
    document.body.classList.add('mobile-device');

    this._bindFullscreen();
    this._bindMenuToggle();
    this._bindJoystick();
    this._bindActionButtons();
  }

  // ─── Fullscreen ────────────────────────────────────────────────────────────

  _bindFullscreen() {
    const btn = document.getElementById('mob-btn-fullscreen');
    if (!btn) return;

    const toggle = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }, { passive: false });

    document.addEventListener('fullscreenchange', () => {
      btn.textContent = document.fullscreenElement ? '✕⛶' : '⛶';
      btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Go fullscreen';
    });
  }

  // ─── Bottom panel menu toggle ──────────────────────────────────────────────

  _bindMenuToggle() {
    const btn   = document.getElementById('mob-btn-menu');
    const panel = document.getElementById('bottom-panel');
    if (!btn || !panel) return;

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._menuOpen = !this._menuOpen;
      panel.classList.toggle('mob-panel-open', this._menuOpen);
      btn.textContent = this._menuOpen ? '✕' : '☰';
      btn.classList.toggle('active', this._menuOpen);
    }, { passive: false });
  }

  // ─── Joystick ──────────────────────────────────────────────────────────────

  _bindJoystick() {
    const base = document.getElementById('mob-joystick-base');
    const knob = document.getElementById('mob-joystick-knob');
    if (!base || !knob) return;

    const DEAD_ZONE  = 8;
    const MAX_RADIUS = 42;

    const onStart = (clientX, clientY, touchId = null) => {
      this._joystickActive  = true;
      this._joystickTouchId = touchId;
      this._joystickStartX  = clientX;
      this._joystickStartY  = clientY;
      base.classList.add('active');
    };

    const onMove = (clientX, clientY) => {
      if (!this._joystickActive) return;
      const dx   = clientX - this._joystickStartX;
      const dy   = clientY - this._joystickStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clamped = Math.min(dist, MAX_RADIUS);
      const angle   = Math.atan2(dy, dx);

      const kx = Math.cos(angle) * clamped;
      const ky = Math.sin(angle) * clamped;
      knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

      const prevHeld = new Set(this._heldKeys);
      this._heldKeys.clear();

      if (dist > DEAD_ZONE) {
        if (dy < -DEAD_ZONE) this._heldKeys.add('KeyW');
        if (dy > DEAD_ZONE)  this._heldKeys.add('KeyS');
        if (dx < -DEAD_ZONE) this._heldKeys.add('KeyA');
        if (dx > DEAD_ZONE)  this._heldKeys.add('KeyD');
      }

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
      for (const key of this._heldKeys) this.input.injectKeyUp(key);
      this._heldKeys.clear();
    };

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

    window.addEventListener('touchend', (e) => {
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
    const buttons = [
      { id: 'mob-btn-fire',    key: 'Space',  mode: 'tap'  },
      { id: 'mob-btn-anchor',  key: 'KeyQ',   mode: 'hold' },
      { id: 'mob-btn-board',   key: 'KeyB',   mode: 'tap'  },
      { id: 'mob-btn-repair',  key: 'KeyR',   mode: 'tap'  },
      { id: 'mob-btn-capture', key: 'KeyE',   mode: 'tap'  },
      { id: 'mob-btn-journal', key: 'KeyJ',   mode: 'tap'  },
      { id: 'mob-btn-pause',   key: 'Escape', mode: 'tap'  },
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
        el.addEventListener('touchstart', (e) => {
          e.preventDefault();
          this.input.injectKeyDown(key);
          el.classList.add('pressed');
          requestAnimationFrame(() => {
            this.input.injectKeyUp(key);
            el.classList.remove('pressed');
          });
        }, { passive: false });
      }
    }
  }

  destroy() {
    for (const key of this._heldKeys) this.input.injectKeyUp(key);
    this._heldKeys.clear();
  }
}

export default MobileControls;
