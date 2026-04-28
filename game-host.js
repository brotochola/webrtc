/**
 * game-host.js
 *
 * Host-side game logic for the star topology (1 host + N clients).
 *
 * The host is the sole physics authority. It:
 *
 *   1. Owns a Player entity for itself (entity 0) and one per connected client.
 *   2. Runs a requestAnimationFrame loop that steps all entities every frame.
 *   3. Broadcasts the full state (position + velocity for every entity) to each
 *      connected client every SEND_EVERY frames.
 *   4. Receives Int8Array([ax, ay]) input packets from each client and routes
 *      them to the correct player entity.
 *   5. Exposes addPeer() / removePeer() so index.html can plug in game data
 *      channels as clients join and leave.
 */

import { Player, POS_X, POS_Y, VEL_X, VEL_Y, PLAYER_COLORS, MAX_ENTITIES } from './game-physics.js';
import { InputHandler } from './game-input.js';
import { ARENA_W, ARENA_H } from './game-renderer.js';

/** dt cap — prevents huge physics jumps when the tab is backgrounded. */
const MAX_DT = 0.1;

/**
 * Broadcast every SEND_EVERY rAF frames (~20 Hz at 60 fps).
 * No setInterval needed — the rAF loop counts frames.
 */
const SEND_EVERY = 3;

/** Horizontal distance from centre where new players spawn. */
const SPAWN_OFFSET_X = 60;

/**
 * Spread players evenly across the vertical axis so they don't all stack.
 * Vertical spawn position for entity i: ARENA_H * SPAWN_Y_FRACS[i].
 */
const SPAWN_Y_FRACS = [0.5, 0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];

/**
 * Horizontal spawn positions (fraction of ARENA_W) for the first 8 entities.
 * Entity 0 (host) always spawns left-of-centre.
 */
const SPAWN_X_FRACS = [0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.25, 0.75];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameHost
 *
 * Instantiated by the facade (game.js) when the local peer wins the host
 * election. Clients are plugged in later via addPeer().
 */
export class GameHost {
    /**
     * @param {import('./game-renderer.js').GameRenderer} renderer
     */
    constructor(renderer) {
        this._renderer = renderer;

        /**
         * Entity 0 — the host's own player.
         * Controlled by local keyboard via InputHandler.
         */
        this._hostPlayer = new Player(
            0,
            PLAYER_COLORS[0],
            ARENA_W * SPAWN_X_FRACS[0],
            ARENA_H * SPAWN_Y_FRACS[0],
        );

        /**
         * Per-client peer state.
         * key   = clientId (string, from Firebase presence)
         * value = { dc, player, entityId, onMessage }
         *
         * @type {Map<string, { dc: RTCDataChannel, player: Player, entityId: number, onMessage: Function }>}
         */
        this._peers = new Map();

        /**
         * Persistent broadcast buffer.
         * Reallocated by _rebuildBroadcastBuffer() whenever a peer joins/leaves.
         * Layout: [frameNo, timestamp, playerCount, posX₀, posY₀, velX₀, velY₀, posX₁, …]
         * @type {Float32Array}
         */
        this._posBuf = null;
        this._rebuildBroadcastBuffer();

        this._frameCount = 0;
        this._rafId      = null;
        this._lastTime   = 0;

        // Host player is driven by local keyboard.
        this._input = new InputHandler((ax, ay) => {
            this._hostPlayer.setInput(ax, ay);
        });

        // Draw the initial frame (just the host player) immediately.
        this._render();
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    /** Start the physics + render loop. Called by the facade after construction. */
    start() {
        this._lastTime = performance.now();
        this._rafId    = requestAnimationFrame(this._loop.bind(this));
    }

    /**
     * Register a new client's game data channel.
     *
     * Assigns the next available entity ID (1, 2, …), creates a Player,
     * sends a 1-byte setup packet to tell the client its entity ID, and
     * wires up the input-message listener.
     *
     * @param {string}         clientId - Firebase presence key for this client.
     * @param {RTCDataChannel} dc       - The open "game" data channel to this client.
     */
    addPeer(clientId, dc) {
        if (this._peers.has(clientId)) return; // guard against duplicate calls

        const entityId = this._peers.size + 1; // entity 0 = host, 1+ = clients

        if (entityId >= MAX_ENTITIES) {
            console.warn(`[GameHost] addPeer: reached MAX_ENTITIES (${MAX_ENTITIES}), ignoring ${clientId}`);
            return;
        }

        const player = new Player(
            entityId,
            PLAYER_COLORS[entityId],
            ARENA_W * SPAWN_X_FRACS[entityId],
            ARENA_H * SPAWN_Y_FRACS[entityId],
        );

        // Tell the client which entity ID it owns — distinguished by byteLength=1.
        dc.send(new Int8Array([entityId]).buffer);

        const onMessage = this._makeInputHandler(player);
        dc.addEventListener('message', onMessage);

        this._peers.set(clientId, { dc, player, entityId, onMessage });
        this._rebuildBroadcastBuffer();
        this._updateLegend();

        console.log(`[GameHost] peer added: ${clientId} → entity ${entityId}`);
    }

    /**
     * Deregister a client (e.g. on disconnect).
     * Removes the player from the simulation and frees the entity slot.
     *
     * @param {string} clientId
     */
    removePeer(clientId) {
        const peer = this._peers.get(clientId);
        if (!peer) return;

        peer.dc.removeEventListener('message', peer.onMessage);
        this._peers.delete(clientId);
        this._rebuildBroadcastBuffer();
        this._updateLegend();

        console.log(`[GameHost] peer removed: ${clientId}`);
    }

    /** Stop the loop and clean up all listeners. */
    destroy() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        for (const { dc, onMessage } of this._peers.values()) {
            dc.removeEventListener('message', onMessage);
        }
        this._peers.clear();
        this._input.destroy();
    }

    // ─── Private — helpers ────────────────────────────────────────────────────

    /**
     * Returns all active Player objects in entity-ID order.
     * Index 0 = host, index 1+ = clients in join order.
     * @returns {Player[]}
     */
    _allPlayers() {
        return [this._hostPlayer, ...Array.from(this._peers.values()).map(p => p.player)];
    }

    /**
     * (Re)allocate the shared broadcast buffer to fit the current player count.
     * Called whenever a peer joins or leaves.
     *
     * Buffer layout (Float32):
     *   [0]       frameNo
     *   [1]       timestamp_ms
     *   [2]       playerCount  (N)
     *   [3+i*4]   POS_X  for entity i
     *   [4+i*4]   POS_Y  for entity i
     *   [5+i*4]   VEL_X  for entity i
     *   [6+i*4]   VEL_Y  for entity i
     */
    _rebuildBroadcastBuffer() {
        const n      = 1 + this._peers.size; // host + all clients
        this._posBuf = new Float32Array(3 + n * 4);
    }

    /** Rebuild the renderer legend to match the current peer count. */
    _updateLegend() {
        const labels = ['Host', ...Array.from(this._peers.values()).map((_, i) => `Cliente ${i + 1}`)];
        this._renderer.updateLegend(labels);
    }

    /** Convenience wrapper: render all current players. */
    _render() {
        this._renderer.render(this._allPlayers());
    }

    /**
     * Create an onmessage handler bound to a specific client's Player.
     * Reads Int8Array([ax, ay]) input packets and calls setInput().
     *
     * @param {Player} player
     * @returns {(e: MessageEvent) => void}
     */
    _makeInputHandler(player) {
        return (e) => {
            if (!(e.data instanceof ArrayBuffer)) return;
            const buf = new Int8Array(e.data);
            // byteLength === 1 is a setup echo — ignore it
            if (buf.byteLength !== 2) return;
            player.setInput(buf[0], buf[1]);
        };
    }

    // ─── Private — physics loop ───────────────────────────────────────────────

    /**
     * rAF callback. Steps all entities, redraws, broadcasts every SEND_EVERY frames.
     * @param {DOMHighResTimeStamp} now
     */
    _loop(now) {
        const dt = Math.min((now - this._lastTime) / 1000, MAX_DT);
        this._lastTime = now;
        this._frameCount++;

        // Advance physics for all active entities.
        this._hostPlayer.update(dt, ARENA_W, ARENA_H);
        for (const { player } of this._peers.values()) {
            player.update(dt, ARENA_W, ARENA_H);
        }

        this._render();

        if (this._frameCount % SEND_EVERY === 0) {
            this._broadcastPositions(now);
        }

        this._rafId = requestAnimationFrame(this._loop.bind(this));
    }

    // ─── Private — network ────────────────────────────────────────────────────

    /**
     * Fill _posBuf with the current frame header and all entity states,
     * then send it to every connected client.
     *
     * Zero allocations per call — _posBuf is reused every frame.
     *
     * @param {DOMHighResTimeStamp} now
     */
    _broadcastPositions(now) {
        const players = this._allPlayers();
        const n       = players.length;

        this._posBuf[0] = this._frameCount;
        this._posBuf[1] = now;
        this._posBuf[2] = n;

        for (let i = 0; i < n; i++) {
            const id    = players[i].id;
            const base  = 3 + i * 4;
            this._posBuf[base]     = POS_X[id];
            this._posBuf[base + 1] = POS_Y[id];
            this._posBuf[base + 2] = VEL_X[id];
            this._posBuf[base + 3] = VEL_Y[id];
        }

        // Send to every peer whose channel is open.
        for (const { dc } of this._peers.values()) {
            if (dc.readyState === 'open') {
                dc.send(this._posBuf.buffer);
            }
        }
    }
}
