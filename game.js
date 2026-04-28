/**
 * game.js — Public facade for the game panel.
 *
 * This is the only file that index.html needs to import.
 * It hides the internal class hierarchy behind five functions:
 *
 *   initGameHost(containerEl)         — called once when host role is confirmed
 *   initGameClient(dc, containerEl)   — called when the client's game DC opens
 *   addGamePeer(clientId, dc)         — host calls this per new client DC open
 *   removeGamePeer(clientId)          — host calls this on client disconnect
 *   destroyGame()                     — tear everything down (leave / reconnect)
 *
 * Only one game instance is active at a time.  A second call to any init
 * function automatically destroys the previous session.
 */

import { GameRenderer } from './game-renderer.js';
import { GameHost }     from './game-host.js';
import { GameClient }   from './game-client.js';

// ─── Module-level singleton references ───────────────────────────────────────

/** @type {GameHost | null} */
let _host     = null;

/** @type {GameClient | null} */
let _client   = null;

/** @type {GameRenderer | null} */
let _renderer = null;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the host-side game panel.
 *
 * Creates the renderer and a GameHost instance (no data channel needed yet —
 * peers are added later via addGamePeer() as clients join).
 *
 * @param {HTMLElement} containerEl - DOM node to inject the game panel into.
 */
export function initGameHost(containerEl) {
    destroyGame();
    console.log('[Game] init — role: host');

    _renderer = new GameRenderer(containerEl);
    _host     = new GameHost(_renderer);
    _host.start();
}

/**
 * Initialise the client-side game panel.
 *
 * Creates the renderer and a GameClient instance.  The client's entity ID
 * arrives later via a 1-byte setup packet from the host, so no entityId
 * argument is needed here.
 *
 * @param {RTCDataChannel} dc          - The "game" data channel (already open).
 * @param {HTMLElement}    containerEl - DOM node to inject the game panel into.
 */
export function initGameClient(dc, containerEl) {
    destroyGame();
    console.log('[Game] init — role: client');

    _renderer = new GameRenderer(containerEl);
    _client   = new GameClient(dc, _renderer);
}

/**
 * Register a new client's game data channel with the host.
 *
 * Must only be called after initGameHost().  Safe to call from any async
 * context (e.g. inside gameDc.onopen).
 *
 * @param {string}         clientId - Firebase presence key for this client.
 * @param {RTCDataChannel} dc       - The "game" data channel to this client.
 */
export function addGamePeer(clientId, dc) {
    if (!_host) {
        console.warn('[Game] addGamePeer called but no host is running');
        return;
    }
    _host.addPeer(clientId, dc);
}

/**
 * Deregister a client from the host (on disconnect).
 *
 * @param {string} clientId
 */
export function removeGamePeer(clientId) {
    if (!_host) return;
    _host.removePeer(clientId);
}

/**
 * Tear down the game panel: stop loops, remove listeners, clear the DOM.
 * Safe to call multiple times or when nothing is running.
 */
export function destroyGame() {
    if (_host) {
        console.log('[Game] destroy host');
        _host.destroy();
        _host = null;
    }

    if (_client) {
        console.log('[Game] destroy client');
        _client.destroy();
        _client = null;
    }

    if (_renderer) {
        _renderer.destroy();
        _renderer = null;
    }
}
