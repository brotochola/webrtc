/**
 * game-host.js
 *
 * Host-side game logic. The host (A / caller) is the single source of truth
 * for all physics. It:
 *
 *   1. Runs a requestAnimationFrame loop that updates both players every frame.
 *   2. Broadcasts both players' positions every SEND_EVERY frames inside the rAF
 *      loop using a persistent Float32Array(6) buffer — zero allocations per send.
 *   3. Listens for incoming Int8Array(2) packets that carry the client's
 *      directional input and feeds them into the client player's physics.
 *   4. Captures the host's own keyboard input via an InputHandler instance.
 */

import { Player, POS_X, POS_Y } from "./game-physics.js";
import { InputHandler } from "./game-input.js";
import { ARENA_W, ARENA_H } from "./game-renderer.js";

/** Fill colours for each player's circle. */
const HOST_COLOR   = '#3b82f6';   // blue
const CLIENT_COLOR = '#ef4444';   // red

/**
 * Maximum allowed dt (seconds) passed to Player.update().
 * Caps the physics step when the tab is backgrounded or the frame rate drops,
 * preventing players from teleporting large distances.
 */
const MAX_DT = 0.1;

/**
 * Send a position packet every SEND_EVERY frames.
 * At 60 fps, 3 frames ≈ 50 ms (≈ 20 Hz) — no setInterval needed.
 */
const SEND_EVERY = 3;

/**
 * Horizontal offset (px) applied to the center spawn so the two players
 * start side-by-side instead of on top of each other.
 */
const SPAWN_OFFSET = 60;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameHost
 *
 * Owns the authoritative state of both players and drives the physics loop.
 * Instantiated by the facade (game.js) when the local peer is the host.
 */
export class GameHost {
  /**
   * @param {RTCDataChannel} dc           - The "game" data channel (already open).
   * @param {import('./game-renderer.js').GameRenderer} renderer
   */
  constructor(dc, renderer) {
    this._dc = dc;
    this._renderer = renderer;

    // Spawn both players at the vertical centre, offset left/right so they
    // don't overlap. Entity IDs (0, 1) must match CLIENT_ENTITY_ID constants
    // in game-client.js.
    this._hostPlayer = new Player(
      0,
      HOST_COLOR,
      ARENA_W / 2 - SPAWN_OFFSET,
      ARENA_H / 2,
    );
    this._clientPlayer = new Player(
      1,
      CLIENT_COLOR,
      ARENA_W / 2 + SPAWN_OFFSET,
      ARENA_H / 2,
    );

    /**
     * Persistent send buffer — never reallocated after construction.
     *
     * Layout (Float32, 6 elements = 24 bytes):
     *   [0] frameNo      — monotonic frame counter (cast to f32, exact up to 2²⁴)
     *   [1] timestamp_ms — performance.now() from the rAF callback
     *   [2] hostX
     *   [3] hostY
     *   [4] clientX
     *   [5] clientY
     */
    this._posBuf = new Float32Array(6);

    // Monotonic frame counter; used both for the send-throttle and the packet header.
    this._frameCount = 0;

    // rAF handle — stored so the loop can be cancelled in destroy().
    this._rafId = null;

    // Timestamp of the previous frame (set on start).
    this._lastTime = 0;

    // Listen for directional input packets coming from the client.
    this._onMessage = this._handleClientMessage.bind(this);
    this._dc.addEventListener("message", this._onMessage);

    // Capture the host's own keyboard input and apply it to the host player.
    this._input = new InputHandler((ax, ay) => {
      this._hostPlayer.setInput(ax, ay);
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the physics loop and the position-broadcast timer.
   * Must be called once after construction (called by the facade).
   */
  start() {
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  /**
   * Stop all loops, remove all listeners, and release references.
   * Called by the facade when leaving the room or reconnecting.
   */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    this._dc.removeEventListener("message", this._onMessage);
    this._input.destroy();
  }

  // ─── Private — physics loop ──────────────────────────────────────────────

  /**
   * rAF callback. Computes dt, steps both players, re-renders.
   * @param {number} now - DOMHighResTimeStamp provided by requestAnimationFrame.
   * @private
   */
  _loop(now) {
    // Compute delta-time in seconds, capped to prevent huge jumps.
    const dt = Math.min((now - this._lastTime) / 1000, MAX_DT);
    this._lastTime = now;

    this._frameCount++;

    // Advance physics for both players.
    this._hostPlayer.update(dt, ARENA_W, ARENA_H);
    this._clientPlayer.update(dt, ARENA_W, ARENA_H);

    // Redraw the canvas with the updated positions.
    this._renderer.render(this._hostPlayer, this._clientPlayer);

    // Broadcast every SEND_EVERY frames — no setInterval needed.
    // `now` comes straight from the rAF callback so no extra performance.now() call.
    if (this._frameCount % SEND_EVERY === 0) {
      this._broadcastPositions(now);
    }

    // Schedule next frame.
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  // ─── Private — network ───────────────────────────────────────────────────

  /**
   * Write the current frame header + both players' positions into the
   * persistent _posBuf and send it as-is — zero allocations per call.
   *
   * Packet layout (Float32 × 6 = 24 bytes):
   *   [0] frameNo      monotonic counter
   *   [1] timestamp_ms performance.now() from the rAF callback
   *   [2] hostX
   *   [3] hostY
   *   [4] clientX
   *   [5] clientY
   *
   * Reads positions from the SoA arrays (POS_X / POS_Y) directly by entity ID.
   *
   * @param {number} now - DOMHighResTimeStamp forwarded from _loop().
   * @private
   */
  _broadcastPositions(now) {
    if (this._dc.readyState !== "open") return;

    const hi = this._hostPlayer.id;
    const ci = this._clientPlayer.id;

    this._posBuf[0] = this._frameCount;
    this._posBuf[1] = now;
    this._posBuf[2] = POS_X[hi];
    this._posBuf[3] = POS_Y[hi];
    this._posBuf[4] = POS_X[ci];
    this._posBuf[5] = POS_Y[ci];

    // .buffer is the backing ArrayBuffer of the Float32Array — no copy, no alloc.
    this._dc.send(this._posBuf.buffer);
  }

  /**
   * Handle an incoming message on the "game" data channel.
   * Expected payload: Int8Array(2) — [ax, ay] from the client's InputHandler.
   *
   * @param {MessageEvent} e
   * @private
   */
  _handleClientMessage(e) {
    if (!(e.data instanceof ArrayBuffer)) return;

    const input = new Int8Array(e.data);

    // Guard against malformed packets.
    if (input.byteLength < 2) return;

    // Apply the client's directional intent to the client player's physics.
    this._clientPlayer.setInput(input[0], input[1]);
  }
}
