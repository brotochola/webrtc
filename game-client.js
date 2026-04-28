/**
 * game-client.js
 *
 * Client-side game logic with client-side prediction + reconciliation.
 *
 * Three things happen each rAF frame:
 *
 *  1. CLIENT-SIDE PREDICTION (own player only)
 *     The client runs its own copy of the physics for its player using the
 *     current input state. This makes movement feel instant — no waiting for
 *     the host round-trip (~50-100 ms).
 *
 *  2. RECONCILIATION
 *     Every ~50 ms a position packet arrives from the authoritative host.
 *     We compare it with our local prediction:
 *       - small error (< 60 px) → soft correction nudge (invisible)
 *       - large error (≥ 60 px) → hard snap (severe desync)
 *
 *  3. HOST PLAYER DEAD RECKONING
 *     We have no prediction for the host player (we don't have their inputs).
 *     The host now sends velocity alongside position, so the client extrapolates
 *     where the host player should be right now:
 *         renderPos = lastKnownPos + vel × age
 *     A small residual lerp corrects any drift when the next packet arrives.
 */

import { Player }           from './game-physics.js';
import { InputHandler }     from './game-input.js';
import { ARENA_W, ARENA_H } from './game-renderer.js';

/** Fill colours — must match game-host.js. */
const HOST_COLOR   = '#3b82f6';
const CLIENT_COLOR = '#ef4444';

/** Entity IDs — must match the IDs assigned by GameHost. */
const HOST_ENTITY_ID   = 0;
const CLIENT_ENTITY_ID = 1;

/**
 * If the prediction error exceeds this threshold (px) we snap instead of
 * nudging — the player must have desynced badly.
 */
const SNAP_THRESHOLD = 60;

/**
 * Per-frame correction factor applied to the prediction error.
 * Small enough to be invisible, large enough to prevent drift accumulation.
 * 0.15 ≈ corrects ~50 % of any error within 4 frames (~67 ms at 60 fps).
 */
const CORRECTION_ALPHA = 0.15;

/**
 * Initial assumed packet interval (seconds).
 * Will be updated from real measurements after the first two packets arrive.
 */
const INITIAL_PACKET_INTERVAL = 0.05;   // 50 ms (matches SEND_EVERY = 3 at 60 fps)

/** Physics dt cap — same value as GameHost to keep simulations in sync. */
const MAX_DT = 0.1;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameClient
 *
 * Instantiated by the facade (game.js) when the local peer is the callee.
 */
export class GameClient {
    /**
     * @param {RTCDataChannel} dc           - The "game" data channel (already open).
     * @param {import('./game-renderer.js').GameRenderer} renderer
     */
    constructor(dc, renderer) {
        this._dc       = dc;
        this._renderer = renderer;

        // Spawn positions mirror GameHost so the canvas is correct before
        // the first packet arrives (~50 ms).
        const SPAWN_OFFSET = 60;
        this._hostPlayer = new Player(
            HOST_ENTITY_ID,
            HOST_COLOR,
            ARENA_W / 2 - SPAWN_OFFSET,
            ARENA_H / 2,
        );
        this._clientPlayer = new Player(
            CLIENT_ENTITY_ID,
            CLIENT_COLOR,
            ARENA_W / 2 + SPAWN_OFFSET,
            ARENA_H / 2,
        );

        /**
         * Last authoritative snapshot received from the host.
         *
         * Layout: [hostX, hostY, clientX, clientY, hostVX, hostVY, clientVX, clientVY]
         *
         * Positions (0-3) are used for reconciliation and dead reckoning.
         * Velocities (4-7) are used by dead reckoning to extrapolate the host
         * player's position forward in time between packets.
         */
        this._snap = new Float32Array([
            this._hostPlayer.posX,
            this._hostPlayer.posY,
            this._clientPlayer.posX,
            this._clientPlayer.posY,
            0, 0, 0, 0,   // velocities start at zero
        ]);

        /**
         * Exponential moving average of the measured interval between consecutive
         * packets (seconds). Used to scale the residual lerp for the host player.
         */
        this._packetInterval   = INITIAL_PACKET_INTERVAL;
        this._lastPacketTimeMs = 0;   // wall-clock ms when the previous packet arrived
        this._snapTimeMs       = 0;   // wall-clock ms when _snap was last written

        // rAF bookkeeping
        this._rafId    = null;
        this._lastTime = 0;

        // Register network listener.
        this._onMessage = this._handleMessage.bind(this);
        this._dc.addEventListener('message', this._onMessage);

        /**
         * Keyboard input handler.
         * On change: immediately apply to local physics (prediction) AND send
         * to the host so it can advance its simulation.
         */
        this._input = new InputHandler((ax, ay) => {
            // Prediction: apply to our local copy of the client player instantly.
            this._clientPlayer.setInput(ax, ay);

            // Network: tell the host about the new direction.
            if (this._dc.readyState === 'open') {
                this._dc.send(new Int8Array([ax, ay]).buffer);
            }
        });

        // Kick off the loop and paint the initial frame.
        this._rafId = requestAnimationFrame(this._loop.bind(this));
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Main rAF loop.
     *
     * @param {DOMHighResTimeStamp} now
     * @private
     */
    _loop(now) {
        const dt = Math.min((now - this._lastTime) / 1000, MAX_DT);
        this._lastTime = now;

        // ── 1. Client-side prediction ──────────────────────────────────────
        // Run the host's exact same physics locally for our own player.
        // Because we apply input to setInput() immediately on keydown/up, the
        // local simulation is always one step ahead of the network.
        this._clientPlayer.update(dt, ARENA_W, ARENA_H);

        // ── 2. Reconciliation ──────────────────────────────────────────────
        // Compare our predicted position with the latest authoritative value.
        // Silently nudge if error is small; snap if severe.
        const errX = this._snap[2] - this._clientPlayer.posX;
        const errY = this._snap[3] - this._clientPlayer.posY;
        const err  = Math.hypot(errX, errY);

        if (err >= SNAP_THRESHOLD) {
            // Hard snap — prediction drifted too far (e.g. after reconnect).
            this._clientPlayer.posX = this._snap[2];
            this._clientPlayer.posY = this._snap[3];
        } else if (err > 1) {
            // Soft correction — nudge toward authoritative position each frame.
            this._clientPlayer.posX += errX * CORRECTION_ALPHA;
            this._clientPlayer.posY += errY * CORRECTION_ALPHA;
        }

        // ── 3. Host player — dead reckoning ────────────────────────────────
        // The snapshot contains the host's position AND velocity at the moment
        // the packet was sent. Extrapolate forward by the time elapsed since
        // that packet arrived to get a continuously-moving estimate.
        const ageSec = Math.min(
            (now - this._snapTimeMs) / 1000,
            this._packetInterval * 2,   // cap extrapolation to 2× packet interval
        );
        const extraX = this._snap[0] + this._snap[4] * ageSec;
        const extraY = this._snap[1] + this._snap[5] * ageSec;

        // Small residual lerp smooths any discontinuity when a new packet
        // arrives and resets the extrapolation origin.
        const alpha = this._lerpAlpha(dt);
        this._hostPlayer.posX += (extraX - this._hostPlayer.posX) * alpha;
        this._hostPlayer.posY += (extraY - this._hostPlayer.posY) * alpha;

        this._renderer.render(this._hostPlayer, this._clientPlayer);

        this._rafId = requestAnimationFrame(this._loop.bind(this));
    }

    /**
     * Compute a frame-rate-independent lerp factor using exponential decay.
     *
     *   alpha = 1 - e^(-dt / τ)
     *
     * τ (tau) is set to half the measured packet interval so we converge to
     * the target within roughly one packet period regardless of frame rate.
     *
     * @param {number} dt - Frame delta-time in seconds.
     * @returns {number} Lerp factor in (0, 1).
     * @private
     */
    _lerpAlpha(dt) {
        // τ = half the packet interval, clamped to a sensible range.
        const tau = Math.max(0.016, Math.min(0.1, this._packetInterval * 0.5));
        return 1 - Math.exp(-dt / tau);
    }

    /**
     * Handle an incoming position broadcast from the host.
     * Packet format: Float32Array(6) → [frameNo, timestamp, hostX, hostY, clientX, clientY]
     *
     * Updates _target (used for lerp + reconciliation) and tracks the
     * arrival interval for adaptive lerp tuning.
     *
     * @param {MessageEvent} e
     * @private
     */
    _handleMessage(e) {
        if (!(e.data instanceof ArrayBuffer)) return;

        const pkt = new Float32Array(e.data);

        // Expect 10 floats: [frameNo, timestamp, hx, hy, cx, cy, hvx, hvy, cvx, cvy]
        if (pkt.length < 10) return;

        const nowMs = performance.now();

        // ── Store authoritative snapshot ───────────────────────────────────
        // Positions — used for reconciliation (client) and dead reckoning (host).
        this._snap[0] = pkt[2];   // hostX
        this._snap[1] = pkt[3];   // hostY
        this._snap[2] = pkt[4];   // clientX
        this._snap[3] = pkt[5];   // clientY
        // Velocities — used to extrapolate host position between packets.
        this._snap[4] = pkt[6];   // hostVX
        this._snap[5] = pkt[7];   // hostVY
        this._snap[6] = pkt[8];   // clientVX  (available for future use)
        this._snap[7] = pkt[9];   // clientVY

        // Record when this snapshot was received so _loop() can compute age.
        this._snapTimeMs = nowMs;

        // ── Measure packet interval for adaptive lerp ──────────────────────
        if (this._lastPacketTimeMs > 0) {
            const measured = (nowMs - this._lastPacketTimeMs) / 1000;
            // EMA — 10 % weight per sample keeps transient jitter from dominating.
            this._packetInterval = this._packetInterval * 0.9 + measured * 0.1;
        }
        this._lastPacketTimeMs = nowMs;
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Cancel the rAF loop, remove event listeners, destroy input handler.
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
