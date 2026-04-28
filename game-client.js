/**
 * game-client.js
 *
 * Client-side game logic for the star topology.
 *
 * Each rAF frame does three things:
 *
 *   1. CLIENT-SIDE PREDICTION (own player only)
 *      The client runs its own copy of physics for its entity using the
 *      current input state — movement feels instant, no round-trip wait.
 *
 *   2. RECONCILIATION (own player)
 *      When an authoritative packet arrives from the host, compare the
 *      authoritative position with the local prediction:
 *        error < SNAP_THRESHOLD → soft nudge (invisible correction)
 *        error ≥ SNAP_THRESHOLD → hard snap (severe desync recovery)
 *
 *   3. DEAD RECKONING (all other players)
 *      Host packets include velocity, so between packets we extrapolate:
 *        renderPos = lastKnownPos + vel × age
 *      A small residual lerp smooths any discontinuity on packet arrival.
 *
 * The client's entity ID is assigned by the host and delivered in a
 * 1-byte setup packet before the first broadcast arrives.
 */

import { Player, PLAYER_COLORS, MAX_ENTITIES } from './game-physics.js';
import { InputHandler }     from './game-input.js';
import { ARENA_W, ARENA_H } from './game-renderer.js';

/** Prediction error (px) above which we hard-snap instead of nudging. */
const SNAP_THRESHOLD = 60;

/** Per-frame soft-correction factor for small prediction errors. */
const CORRECTION_ALPHA = 0.15;

/** Initial assumed packet interval (s) before measurements arrive. */
const INITIAL_PACKET_INTERVAL = 0.05;

/** Physics dt cap — must match GameHost.MAX_DT. */
const MAX_DT = 0.1;

/**
 * Horizontal / vertical spawn positions (fraction of arena) per entity.
 * Must match the arrays in game-host.js so the initial frame is correct
 * before the first broadcast arrives.
 */
const SPAWN_X_FRACS = [0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.25, 0.75];
const SPAWN_Y_FRACS = [0.5, 0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameClient
 *
 * Instantiated by the facade (game.js) when the local peer is a callee.
 * The client's entity ID arrives via a 1-byte setup packet from the host;
 * until it arrives the rAF loop renders only the initial placeholder state.
 */
export class GameClient {
    /**
     * @param {RTCDataChannel} dc           - The "game" data channel (already open).
     * @param {import('./game-renderer.js').GameRenderer} renderer
     */
    constructor(dc, renderer) {
        this._dc       = dc;
        this._renderer = renderer;

        /**
         * Player display array indexed by entity ID.
         * Slots are null until the host populates them via a broadcast packet.
         * Slot for own entity is created as soon as the setup packet arrives.
         *
         * @type {Array<Player|null>}
         */
        this._players = new Array(MAX_ENTITIES).fill(null);

        /**
         * This client's entity ID.
         * -1 = not yet received (waiting for setup packet from host).
         * @type {number}
         */
        this._myEntityId = -1;

        /**
         * Per-entity dead-reckoning snapshot.
         * Layout: for entity i → base = i * 6
         *   [base+0] posX  [base+1] posY
         *   [base+2] velX  [base+3] velY
         *   [base+4] snapTimeMs (stored as regular JS number, not in the TypedArray)
         *
         * We use a Float64Array for the time values to preserve ms precision.
         */
        this._snapPos     = new Float32Array(MAX_ENTITIES * 4); // [posX,posY,velX,velY]×N
        this._snapTimeMs  = new Float64Array(MAX_ENTITIES);     // arrival time per entity

        /** EMA of packet inter-arrival interval (s) for adaptive lerp. */
        this._packetInterval   = INITIAL_PACKET_INTERVAL;
        this._lastPacketTimeMs = 0;

        /** rAF bookkeeping. */
        this._rafId    = null;
        this._lastTime = 0;

        // Register the message handler before the first frame.
        this._onMessage = this._handleMessage.bind(this);
        this._dc.addEventListener('message', this._onMessage);

        /**
         * Keyboard input handler.
         * Applies to own Player immediately (prediction) and sends to host.
         * Active even before setup packet — input is just buffered in the Player.
         */
        this._input = new InputHandler((ax, ay) => {
            if (this._myEntityId >= 0) {
                this._players[this._myEntityId]?.setInput(ax, ay);
            }
            if (this._dc.readyState === 'open') {
                this._dc.send(new Int8Array([ax, ay]).buffer);
            }
        });

        // Kick off the rAF loop.
        this._rafId = requestAnimationFrame(this._loop.bind(this));
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Main rAF loop — prediction, reconciliation, dead reckoning, render.
     * @param {DOMHighResTimeStamp} now
     */
    _loop(now) {
        const dt = Math.min((now - this._lastTime) / 1000, MAX_DT);
        this._lastTime = now;

        const me = this._myEntityId;

        for (let id = 0; id < MAX_ENTITIES; id++) {
            const player = this._players[id];
            if (!player) continue;

            if (id === me) {
                // ── 1. Prediction ────────────────────────────────────────
                player.update(dt, ARENA_W, ARENA_H);

                // ── 2. Reconciliation ────────────────────────────────────
                const base  = id * 4;
                const errX  = this._snapPos[base]     - player.posX;
                const errY  = this._snapPos[base + 1] - player.posY;
                const err   = Math.hypot(errX, errY);

                if (err >= SNAP_THRESHOLD) {
                    player.posX = this._snapPos[base];
                    player.posY = this._snapPos[base + 1];
                } else if (err > 1) {
                    player.posX += errX * CORRECTION_ALPHA;
                    player.posY += errY * CORRECTION_ALPHA;
                }

            } else {
                // ── 3. Dead reckoning ────────────────────────────────────
                const base   = id * 4;
                const ageSec = Math.min(
                    (now - this._snapTimeMs[id]) / 1000,
                    this._packetInterval * 2,
                );
                const extraX = this._snapPos[base]     + this._snapPos[base + 2] * ageSec;
                const extraY = this._snapPos[base + 1] + this._snapPos[base + 3] * ageSec;

                const alpha  = this._lerpAlpha(dt);
                player.posX += (extraX - player.posX) * alpha;
                player.posY += (extraY - player.posY) * alpha;
            }
        }

        this._renderer.render(this._players);
        this._rafId = requestAnimationFrame(this._loop.bind(this));
    }

    /**
     * Frame-rate-independent lerp factor.
     *   α = 1 − e^(−dt / τ),   τ = packetInterval × 0.5
     * @param {number} dt
     * @returns {number}
     */
    _lerpAlpha(dt) {
        const tau = Math.max(0.016, Math.min(0.1, this._packetInterval * 0.5));
        return 1 - Math.exp(-dt / tau);
    }

    /**
     * Handle incoming messages on the "game" data channel.
     *
     * Two message types (distinguished by byteLength):
     *   1 byte  → setup packet: Int8Array([myEntityId]) from host
     *   >4 bytes → broadcast:   Float32Array([frameNo, ts, N, px0, py0, vx0, vy0, …])
     *
     * @param {MessageEvent} e
     */
    _handleMessage(e) {
        if (!(e.data instanceof ArrayBuffer)) return;

        const buf = e.data;

        // ── Setup packet ──────────────────────────────────────────────────────
        if (buf.byteLength === 1) {
            const entityId = new Int8Array(buf)[0];
            this._initOwnPlayer(entityId);
            return;
        }

        // ── Broadcast packet ──────────────────────────────────────────────────
        // Minimum: header (3 floats = 12 bytes) + 1 player (4 floats = 16 bytes)
        if (buf.byteLength < 28) return;

        const pkt          = new Float32Array(buf);
        const playerCount  = Math.round(pkt[2]);
        const nowMs        = performance.now();

        for (let i = 0; i < playerCount; i++) {
            const base  = 3 + i * 4;
            const posX  = pkt[base];
            const posY  = pkt[base + 1];
            const velX  = pkt[base + 2];
            const velY  = pkt[base + 3];

            // Lazily create a display Player for this entity slot if needed.
            if (!this._players[i]) {
                this._players[i] = new Player(
                    i,
                    PLAYER_COLORS[i],
                    posX,
                    posY,
                );
            }

            // Store authoritative snapshot for dead reckoning / reconciliation.
            const snapBase = i * 4;
            this._snapPos[snapBase]     = posX;
            this._snapPos[snapBase + 1] = posY;
            this._snapPos[snapBase + 2] = velX;
            this._snapPos[snapBase + 3] = velY;
            this._snapTimeMs[i]         = nowMs;
        }

        // Measure packet interval for adaptive lerp.
        if (this._lastPacketTimeMs > 0) {
            const measured       = (nowMs - this._lastPacketTimeMs) / 1000;
            this._packetInterval = this._packetInterval * 0.9 + measured * 0.1;
        }
        this._lastPacketTimeMs = nowMs;
    }

    /**
     * Called once when the setup packet arrives.
     * Creates the own-player entity and initialises the snapshot slot.
     *
     * @param {number} entityId
     */
    _initOwnPlayer(entityId) {
        if (this._myEntityId >= 0) return; // already initialised

        this._myEntityId = entityId;

        const player = new Player(
            entityId,
            PLAYER_COLORS[entityId],
            ARENA_W * SPAWN_X_FRACS[entityId],
            ARENA_H * SPAWN_Y_FRACS[entityId],
        );
        this._players[entityId] = player;

        // Seed snapshot so reconciliation has a valid target on first broadcast.
        const base = entityId * 4;
        this._snapPos[base]     = player.posX;
        this._snapPos[base + 1] = player.posY;
        this._snapPos[base + 2] = 0;
        this._snapPos[base + 3] = 0;
        this._snapTimeMs[entityId] = performance.now();

        console.log(`[GameClient] own entity ID: ${entityId}`);
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Cancel the rAF loop, remove listeners, destroy input handler.
     * Called by the facade's destroyGame().
     */
    destroy() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._dc.removeEventListener('message', this._onMessage);
        this._input.destroy();
    }
}
