/**
 * game-client.js
 *
 * Client-side game logic. The client (B / callee) is NOT authoritative over
 * physics — it only:
 *
 *   1. Listens for Float32Array(6) position packets from the host and stores
 *      them as interpolation *targets* (never snaps directly to them).
 *
 *   2. Runs its own rAF loop that lerps the current rendered positions toward
 *      the latest target each frame, producing smooth motion even at 20 Hz
 *      network updates.
 *
 *   3. Captures local keyboard input and sends Int8Array(2) direction packets
 *      to the host so it can advance the client player's physics.
 */

import { Player } from "./game-physics.js";
import { InputHandler } from "./game-input.js";
import { ARENA_W, ARENA_H } from "./game-renderer.js";

/** Fill colours — must match game-host.js. */
const HOST_COLOR = "#3b82f6"; // blue
const CLIENT_COLOR = "#ef4444"; // red

/** Entity IDs — must match the IDs assigned by GameHost. */
const HOST_ENTITY_ID = 0;
const CLIENT_ENTITY_ID = 1;

/**
 * Lerp factor applied per rAF frame.
 *   0 = never move,  1 = instant snap,  0.5 = halfway each frame (~60 Hz).
 * At 60 fps a factor of 0.5 converges to within 1 px in ~7 frames (~115 ms),
 * giving visibly smooth motion while still tracking the host faithfully.
 */
const LERP = 0.15;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameClient
 *
 * Instantiated by the facade (game.js) when the local peer is the callee.
 * Owns the two Player display entities and the InputHandler. Runs a rAF loop
 * for interpolation; physics authority always lives on the host.
 */
export class GameClient {
  /**
   * @param {RTCDataChannel} dc           - The "game" data channel (already open).
   * @param {import('./game-renderer.js').GameRenderer} renderer
   */
  constructor(dc, renderer) {
    this._dc = dc;
    this._renderer = renderer;

    // Mirror GameHost's spawn positions exactly (center ± SPAWN_OFFSET)
    // so the canvas isn't blank during the first ~50 ms before the first packet.
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
     * Interpolation target positions — updated on every incoming packet.
     * The rAF loop lerps the Player SoA positions toward these values.
     *
     * Layout: [hostX, hostY, clientX, clientY]
     * Initialised to the spawn positions so the lerp starts from a known state.
     */
    this._target = new Float32Array([
      this._hostPlayer.posX,
      this._hostPlayer.posY,
      this._clientPlayer.posX,
      this._clientPlayer.posY,
    ]);

    // rAF handle for the interpolation loop.
    this._rafId = null;

    // Listen for position broadcast packets from the host.
    this._onMessage = this._handleMessage.bind(this);
    this._dc.addEventListener("message", this._onMessage);

    // Capture keyboard input and send direction packets to the host.
    // The host is the one that applies this input to the client player's physics.
    this._input = new InputHandler((ax, ay) => {
      if (this._dc.readyState !== "open") return;

      // Pack [ax, ay] into an Int8Array (2 bytes total) and send.
      // Int8 is sufficient because each value is always -1, 0, or +1.
      const buf = new Int8Array([ax, ay]);
      this._dc.send(buf.buffer);
    });

    // Start the interpolation loop and draw the first frame.
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * rAF loop — runs every frame (~60 Hz) regardless of network packet rate.
   * Lerps the current SoA positions toward _target, then redraws.
   * @private
   */
  _loop() {
    // Lerp each axis independently toward the latest target.
    // Using posX/posY setters writes into the SoA arrays in place.
    this._hostPlayer.posX += (this._target[0] - this._hostPlayer.posX) * LERP;
    this._hostPlayer.posY += (this._target[1] - this._hostPlayer.posY) * LERP;
    this._clientPlayer.posX +=
      (this._target[2] - this._clientPlayer.posX) * LERP;
    this._clientPlayer.posY +=
      (this._target[3] - this._clientPlayer.posY) * LERP;

    this._renderer.render(this._hostPlayer, this._clientPlayer);

    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  /**
   * Handle an incoming ArrayBuffer message from the host.
   * Expected format: Float32Array(6) → [frameNo, timestamp, hostX, hostY, clientX, clientY].
   *
   * Only updates the interpolation targets — the rAF loop does the actual
   * position stepping, so there is no render call here.
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
    // Store positions as lerp targets; the loop will converge toward them.
    this._target[0] = pkt[2];
    this._target[1] = pkt[3];
    this._target[2] = pkt[4];
    this._target[3] = pkt[5];
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Cancel the rAF loop, remove all event listeners, and tear down the input handler.
   * Called by the facade's destroyGame().
   */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    this._dc.removeEventListener("message", this._onMessage);
    this._input.destroy();
  }
}
