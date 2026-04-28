/**
 * game-input.js
 *
 * Translates raw keyboard events into a normalised 2-axis directional signal
 * and fires a callback whenever that signal changes.
 *
 * Design notes:
 *  - Tracks *all* currently pressed direction keys so that releasing one key
 *    while another is still held produces the correct resultant direction.
 *  - The callback is only fired when the net (ax, ay) actually changes,
 *    avoiding redundant packets over the data channel.
 *  - Arrow keys have their default browser scroll behaviour suppressed.
 */

/**
 * Maps a KeyboardEvent.key value to an [axis, direction] pair:
 *   axis  0 = horizontal (x),  1 = vertical (y)
 *   dir  -1 = left / up,      +1 = right / down
 *
 * Both Arrow keys and WASD are supported so that players on different
 * machines can use whichever layout they prefer.
 *
 * @type {Record<string, [0|1, -1|1]>}
 */
const KEY_MAP = {
    ArrowLeft:  [0, -1],
    ArrowRight: [0, +1],
    ArrowUp:    [1, -1],
    ArrowDown:  [1, +1],
    a: [0, -1],  A: [0, -1],
    d: [0, +1],  D: [0, +1],
    w: [1, -1],  W: [1, -1],
    s: [1, +1],  S: [1, +1],
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * InputHandler
 *
 * Listens for keyboard events on `window`, maintains a Set of currently
 * pressed direction keys, and distils them into a single (ax, ay) signal.
 */
export class InputHandler {
    /**
     * @param {(ax: number, ay: number) => void} onChange
     *   Callback invoked whenever the net direction changes.
     *   ax and ay are each -1, 0, or +1.
     */
    constructor(onChange) {
        /** @private */
        this._onChange = onChange;

        /**
         * Set of currently pressed keys that appear in KEY_MAP.
         * Using a Set lets us correctly handle simultaneous key presses.
         * @private @type {Set<string>}
         */
        this._pressed = new Set();

        /**
         * Last emitted direction, stored to detect actual changes.
         * @private
         */
        this._lastAx = 0;
        this._lastAy = 0;

        // Bind once so the same function reference can be removed later.
        this._onKeyDown = this._handleKey.bind(this, true);
        this._onKeyUp   = this._handleKey.bind(this, false);

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup',   this._onKeyUp);
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Handle a keydown or keyup event.
     * Updates the pressed-key set and recalculates the net direction.
     *
     * @param {boolean} isDown - true for keydown, false for keyup.
     * @param {KeyboardEvent} e
     * @private
     */
    _handleKey(isDown, e) {
        if (!(e.key in KEY_MAP)) return;

        // Prevent arrow keys from scrolling the page while the game is active.
        if (e.key.startsWith('Arrow')) e.preventDefault();

        if (isDown) {
            this._pressed.add(e.key);
        } else {
            this._pressed.delete(e.key);
        }

        this._recalculate();
    }

    /**
     * Compute the net (ax, ay) from all currently pressed keys and emit
     * the callback only if the value differs from the last emission.
     * @private
     */
    _recalculate() {
        let ax = 0;
        let ay = 0;

        for (const key of this._pressed) {
            const [axis, dir] = KEY_MAP[key];
            if (axis === 0) ax += dir;
            else            ay += dir;
        }

        // Clamp to [-1, 1] in case two opposite keys are pressed simultaneously.
        ax = Math.max(-1, Math.min(1, ax));
        ay = Math.max(-1, Math.min(1, ay));

        // Only fire if the direction actually changed to minimise network traffic.
        if (ax !== this._lastAx || ay !== this._lastAy) {
            this._lastAx = ax;
            this._lastAy = ay;
            this._onChange(ax, ay);
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Remove keyboard event listeners.
     * Must be called when the game panel is torn down to avoid ghost listeners.
     */
    destroy() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup',   this._onKeyUp);
        this._pressed.clear();
    }
}
