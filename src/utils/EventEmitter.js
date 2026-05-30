/**
 * EventEmitter — lightweight pub/sub used across all game systems.
 * Singleton exported so any module can import and share the same bus.
 */
class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} fn
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
    return this; // chainable
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
    return this;
  }

  /**
   * Subscribe to an event only once.
   * @param {string} event
   * @param {Function} fn
   */
  once(event, fn) {
    const wrapper = (data) => {
      fn(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  /**
   * Emit an event with optional data payload.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    const set = this._listeners.get(event);
    if (set) {
      set.forEach(fn => {
        try { fn(data); }
        catch (e) { console.error(`[EventEmitter] Error in handler for "${event}":`, e); }
      });
    }
  }

  /** Remove all listeners for a given event, or all events if none specified. */
  removeAll(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }
}

export default new EventEmitter();
