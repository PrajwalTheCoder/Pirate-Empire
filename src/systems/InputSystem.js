/**
 * InputSystem — tracks keyboard state.
 * Import and call isDown(keyCode) anywhere.
 */
export class InputSystem {
  constructor() {
    /** @type {Set<string>} */
    this._keys = new Set();
    /** @type {Set<string>} — keys pressed this frame (cleared after each update) */
    this._justPressed  = new Set();
    this._justReleased = new Set();

    this._onKeyDown = (e) => {
      if (!this._keys.has(e.code)) {
        this._justPressed.add(e.code);
      }
      this._keys.add(e.code);
    };

    this._onKeyUp = (e) => {
      this._keys.delete(e.code);
      this._justReleased.add(e.code);
    };

    this._onMouseDown = (e) => {
      const key = `Mouse${e.button}`;
      if (!this._keys.has(key)) {
        this._justPressed.add(key);
      }
      this._keys.add(key);
    };

    this._onMouseUp = (e) => {
      const key = `Mouse${e.button}`;
      this._keys.delete(key);
      this._justReleased.add(key);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup',   this._onMouseUp);
  }

  /** Is the key currently held? */
  isDown(code) { return this._keys.has(code); }

  /** Was it pressed THIS frame? */
  justPressed(code) { return this._justPressed.has(code); }

  /** Was it released THIS frame? */
  justReleased(code) { return this._justReleased.has(code); }

  /**
   * Inject a virtual key-down (used by MobileControls for touch buttons).
   * Safe to call from outside — behaves identically to a real keydown event.
   */
  injectKeyDown(code) {
    if (!this._keys.has(code)) this._justPressed.add(code);
    this._keys.add(code);
  }

  /**
   * Inject a virtual key-up (used by MobileControls for touch buttons).
   */
  injectKeyUp(code) {
    this._keys.delete(code);
    this._justReleased.add(code);
  }

  /** Call once per frame to clear single-frame flags. */
  update() {
    this._justPressed.clear();
    this._justReleased.clear();
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup',   this._onMouseUp);
  }
}

export default InputSystem;
