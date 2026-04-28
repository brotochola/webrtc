/**
 * game-client.js
 *
 * Client-side game logic. The client (B / callee) is NOT authoritative over
 * physics — it only:
 *
 *   1. Listens for Float32Array(6) position packets from the host and
 *      writes them into the SoA store via the Player entity setters,
 *      then triggers a canvas redraw.
 *
 *   2. Captures local keyboard input and sends Int8Array(2) direction
 *      packets to the host so it can advance the client player's physics.
 *
 * Using Player instances (rather than plain objects) keeps the rendering
 * interface identical to the host side and ensures the SoA arrays in this
 * browser context are properly initialised.
 */

import { Player }       from './game-physics.js';
import { InputHandler } from './game-input.js';
import { ARENA_W, ARENA_H } from './game-renderer.js';

/** Emoji identifiers — must match game-host.js. */
const HOST_EMOJI   = '🟦';
const CLIENT_EMOJI = '🟥';

/** Entity IDs — must match the IDs assigned by GameHost. */
const HOST_ENTITY_ID   = 0;
const CLIENT_ENTITY_ID = 1;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameClient
 *
 * Instantiated by the facade (game.js) when the local peer is the callee.
 * Owns the two Player display entities and the InputHandler, but never runs
 * a physics loop — position truth always comes from the host over the wire.
 */
export class GameClient {
    /**
     * @param {RTCDataChannel} dc           - The "game" data channel (already open).
     * @param {import('./game-renderer.js').GameRenderer} renderer
     */
    constructor(dc, renderer) {
        this._dc       = dc;
        this._renderer = renderer;

        // Mirror GameHost's spawn positions exactly (center ± SPAWN_OFFSET)
        // so the canvas isn't blank during the first ~50 ms before the first packet.
        const SPAWN_OFFSET = 60;
        this._hostPlayer   = new Player(HOST_ENTITY_ID,   HOST_EMOJI,   ARENA_W / 2 - SPAWN_OFFSET, ARENA_H / 2);
        this._clientPlayer = new Player(CLIENT_ENTITY_ID, CLIENT_EMOJI, ARENA_W / 2 + SPAWN_OFFSET, ARENA_H / 2);

        // Listen for position broadcast packets from the host.
        this._onMessage = this._handleMessage.bind(this);
        this._dc.addEventListener('message', this._onMessage);

        // Capture keyboard input and send direction packets to the host.
        // The host is the one that applies this input to the client player's physics.
        this._input = new InputHandler((ax, ay) => {
            if (this._dc.readyState !== 'open') return;

            // Pack [ax, ay] into an Int8Array (2 bytes total) and send.
            // Int8 is sufficient because each value is always -1, 0, or +1.
            const buf = new Int8Array([ax, ay]);
            this._dc.send(buf.buffer);
        });

        // Draw the initial frame immediately so the arena isn't blank on load.
        this._renderer.render(this._hostPlayer, this._clientPlayer);
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Handle an incoming ArrayBuffer message from the host.
     * Expected format: Float32Array(6) → [frameNo, timestamp, hostX, hostY, clientX, clientY].
     *
     * Writes the decoded values into the SoA store through the Player's
     * posX / posY setters, then requests a canvas redraw.
     *
     * @param {MessageEvent} e
     * @private
     */
    _handleMessage(e) {
        if (!(e.data instanceof ArrayBuffer)) return;

        const pkt = new Float32Array(e.data);

        // Expect at least 6 floats: [frameNo, timestamp, hx, hy, cx, cy]
        if (pkt.length < 6) return;

        // [0] = frameNo, [1] = timestamp_ms — available for lag/jitter metrics.
        // Positions start at index 2.
        this._hostPlayer.posX   = pkt[2];
        this._hostPlayer.posY   = pkt[3];
        this._clientPlayer.posX = pkt[4];
        this._clientPlayer.posY = pkt[5];

        // Re-render with the freshly updated positions.
        this._renderer.render(this._hostPlayer, this._clientPlayer);
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Remove all event listeners and tear down the input handler.
     * Called by the facade's destroyGame().
     */
    destroy() {
        this._dc.removeEventListener('message', this._onMessage);
        this._input.destroy();
    }
}
