/**
 * game.js — Public facade for the game panel.
 *
 * This is the only file that index.html needs to import. It hides the
 * internal class hierarchy (GameRenderer, GameHost, GameClient) behind
 * two simple functions: initGame() and destroyGame().
 *
 * Lifecycle contract:
 *   - Call initGame() once the "game" RTCDataChannel is open.
 *   - Call destroyGame() before closing/reconnecting the peer connection,
 *     or any time the room panel is hidden.
 *   - Calling initGame() when an instance already exists automatically
 *     destroys the previous one first (safe re-initialisation on reconnect).
 */

import { GameRenderer } from './game-renderer.js';
import { GameHost }     from './game-host.js';
import { GameClient }   from './game-client.js';

// ─── Module-level singleton references ───────────────────────────────────────

/**
 * Active game instance. Either a GameHost or a GameClient, depending on role.
 * null when no game is running.
 * @type {GameHost | GameClient | null}
 */
let _instance = null;

/**
 * Active renderer. Kept separately so destroy() can clear the DOM even if
 * _instance teardown fails for any reason.
 * @type {GameRenderer | null}
 */
let _renderer = null;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the game panel for this peer.
 *
 * Creates a GameRenderer (injects the canvas into containerEl), then
 * either a GameHost (runs physics, broadcasts positions) or a GameClient
 * (receives positions, sends input) depending on the isHost flag.
 *
 * @param {RTCDataChannel} dc           - The "game" data channel, already open.
 * @param {HTMLElement}    containerEl  - DOM node to inject the panel into.
 * @param {boolean}        isHost       - True if this peer is the caller (A).
 */
export function initGame(dc, containerEl, isHost) {
    // Tear down any previous session first (safe to call when null).
    destroyGame();

    console.log(`[Game] init — role: ${isHost ? 'host' : 'client'}`);

    _renderer = new GameRenderer(containerEl);

    if (isHost) {
        // Host owns the physics simulation and streams positions.
        _instance = new GameHost(dc, _renderer);
        _instance.start();
    } else {
        // Client receives positions and streams input.
        _instance = new GameClient(dc, _renderer);
    }
}

/**
 * Tear down the game panel: stop loops, remove listeners, clear the DOM.
 * Safe to call multiple times or when nothing is running.
 */
export function destroyGame() {
    if (_instance) {
        console.log('[Game] destroy');
        _instance.destroy();
        _instance = null;
    }

    if (_renderer) {
        _renderer.destroy();
        _renderer = null;
    }
}
