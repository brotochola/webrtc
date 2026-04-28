/**
 * game-physics.js
 *
 * Structure-of-Arrays (SoA) physics store + Player entity wrapper.
 *
 * Data layout — one flat TypedArray per scalar component, indexed by entity ID:
 *
 *   POS_X[id]  POS_Y[id]   — position   (px)
 *   VEL_X[id]  VEL_Y[id]   — velocity   (px / s)
 *   ACC_X[id]  ACC_Y[id]   — acceleration (px / s²)
 *
 * An "entity" is just a number (its array index). The Player class is a
 * lightweight view over those arrays: every getter/setter reads and writes
 * directly into the relevant typed-array slot, so no per-frame allocation
 * ever occurs and the raw arrays can be accessed directly when filling the
 * broadcast Float32Array in game-host.js.
 *
 * Capacity is fixed at MAX_ENTITIES = 8 so the buffers can be allocated once
 * and never resized during a session.
 */

// ─── Physics constants ────────────────────────────────────────────────────────

/** Acceleration applied while a direction key is held (px / s²). */
const ACCEL = 1900;

/**
 * Per-frame velocity damping multiplier.
 * Applied as: vel *= FRICTION each integration step.
 * 0 = instant stop, 1 = no damping. Tuned for ~60 fps.
 */
const FRICTION = 0.97;

/** Absolute velocity ceiling (px / s). Both axes are scaled together. */
const MAX_SPEED = 420;

/** Inset from each arena edge so the emoji character never clips the border. */
const EDGE_PAD = 22;

/**
 * Collision radius of every player circle (px).
 * Physics property — the renderer imports this same value so the visual
 * circle and the collision circle can never drift apart.
 */
export const PLAYER_RADIUS = 16;

// ─── Color palette ────────────────────────────────────────────────────────────

/**
 * One colour per entity slot (index = entity ID).
 * Entity 0 is always the host (blue); subsequent IDs are clients in join order.
 * Exported so game-host.js, game-client.js, and game-renderer.js can all share
 * the same palette without any hard-coded colour strings.
 */
export const PLAYER_COLORS = [
    '#3b82f6', // 0 — host   (blue)
    '#ef4444', // 1 — client (red)
    '#22c55e', // 2          (green)
    '#f59e0b', // 3          (amber)
    '#a855f7', // 4          (purple)
    '#ec4899', // 5          (pink)
    '#14b8a6', // 6          (teal)
    '#f97316', // 7          (orange)
];

// ─── SoA buffers (module-level, allocated once) ───────────────────────────────

/** Maximum number of simultaneous entities. */
export const MAX_ENTITIES = 8;

export const POS_X = new Float32Array(MAX_ENTITIES);
export const POS_Y = new Float32Array(MAX_ENTITIES);
export const VEL_X = new Float32Array(MAX_ENTITIES);
export const VEL_Y = new Float32Array(MAX_ENTITIES);
export const ACC_X = new Float32Array(MAX_ENTITIES);
export const ACC_Y = new Float32Array(MAX_ENTITIES);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Player
 *
 * An entity is a plain integer (its slot in the SoA arrays).
 * This class wraps that integer and exposes named getters / setters so that
 * call-sites read cleanly without knowing the array layout.
 *
 * game-host.js may also read the SoA arrays directly (e.g. POS_X[id])
 * when filling the broadcast buffer — that is intentional and idiomatic ECS.
 */
export class Player {
  /**
   * @param {number} id      - Entity ID: index into every SoA array.
   * @param {string} color   - CSS colour string used by the renderer (e.g. '#3b82f6').
   * @param {number} startX  - Initial X position (px).
   * @param {number} startY  - Initial Y position (px).
   */
  constructor(id, color, startX, startY) {
    /** @type {number} Entity ID — the only piece of state stored on the object. */
    this.id = id;
    /** @type {string} CSS colour string forwarded to the renderer. */
    this.color = color;

    // Initialise this entity's slot in every SoA array.
    POS_X[id] = startX;
    POS_Y[id] = startY;
    VEL_X[id] = 0;
    VEL_Y[id] = 0;
    ACC_X[id] = 0;
    ACC_Y[id] = 0;
  }

  // ─── Position ─────────────────────────────────────────────────────────────

  get posX() {
    return POS_X[this.id];
  }
  set posX(v) {
    POS_X[this.id] = v;
  }

  get posY() {
    return POS_Y[this.id];
  }
  set posY(v) {
    POS_Y[this.id] = v;
  }

  // ─── Velocity ─────────────────────────────────────────────────────────────

  get velX() {
    return VEL_X[this.id];
  }
  set velX(v) {
    VEL_X[this.id] = v;
  }

  get velY() {
    return VEL_Y[this.id];
  }
  set velY(v) {
    VEL_Y[this.id] = v;
  }

  // ─── Acceleration ─────────────────────────────────────────────────────────

  get accX() {
    return ACC_X[this.id];
  }
  set accX(v) {
    ACC_X[this.id] = v;
  }

  get accY() {
    return ACC_Y[this.id];
  }
  set accY(v) {
    ACC_Y[this.id] = v;
  }

  // ─── Input ────────────────────────────────────────────────────────────────

  /**
   * Convert a directional input into acceleration for the next frame.
   * Called by the host for its own player (InputHandler callback) and for
   * the remote client player (decoded from incoming Int8Array packets).
   *
   * @param {number} ax - Horizontal: -1 (left), 0, +1 (right).
   * @param {number} ay - Vertical:   -1 (up),   0, +1 (down).
   */
  setInput(ax, ay) {
    ACC_X[this.id] = ax * ACCEL;
    ACC_Y[this.id] = ay * ACCEL;
  }

  // ─── Physics step ─────────────────────────────────────────────────────────

  /**
   * Advance this entity's physics by one frame (semi-implicit Euler).
   *
   *   1. vel += acc · dt          (acceleration impulse)
   *   2. vel *= FRICTION           (exponential drag)
   *   3. |vel| clamped to MAX_SPEED
   *   4. pos += vel · dt          (position integration)
   *   5. pos clamped to arena bounds ± EDGE_PAD
   *
   * All reads and writes go through the SoA arrays via the entity ID,
   * so no heap allocation occurs inside this method.
   *
   * @param {number} dt      - Frame delta-time (s). Caller caps this to ≤ 0.1.
   * @param {number} arenaW  - Arena width  (px), from GameRenderer.ARENA_W.
   * @param {number} arenaH  - Arena height (px), from GameRenderer.ARENA_H.
   */
  update(dt, arenaW, arenaH) {
    const id = this.id;

    // 1 + 2 — velocity with friction
    VEL_X[id] = (VEL_X[id] + ACC_X[id] * dt) * FRICTION;
    VEL_Y[id] = (VEL_Y[id] + ACC_Y[id] * dt) * FRICTION;

    // 3 — speed cap (scales both axes proportionally)
    const speed = Math.hypot(VEL_X[id], VEL_Y[id]);
    if (speed > MAX_SPEED) {
      const inv = MAX_SPEED / speed;
      VEL_X[id] *= inv;
      VEL_Y[id] *= inv;
    }

    // 4 — integrate position
    POS_X[id] += VEL_X[id] * dt;
    POS_Y[id] += VEL_Y[id] * dt;

    // 5 — boundary clamp
    POS_X[id] = Math.max(EDGE_PAD, Math.min(arenaW - EDGE_PAD, POS_X[id]));
    POS_Y[id] = Math.max(EDGE_PAD, Math.min(arenaH - EDGE_PAD, POS_Y[id]));
  }
}

// ─── Circle-vs-circle collisions ─────────────────────────────────────────────
//
// Two helpers operate directly on the SoA arrays:
//
//   resolveCollisions(ids, w, h)
//     Authoritative pass used by the host. All unique pairs are tested; on
//     overlap each entity is pushed half the penetration along the contact
//     normal and the normal components of their velocities are swapped
//     (equal-mass elastic collision).
//
//   resolveOwnCollision(myId, otherIds, w, h)
//     Used by the client for its predicted entity. Other players are treated
//     as immovable obstacles (they're dead-reckoned, not simulated locally),
//     so only my entity is pushed out and any approaching velocity component
//     against the obstacle is zeroed.
//
// Both helpers re-clamp positions to the arena bounds after resolution so a
// collision can never push an entity past EDGE_PAD.

/** Squared minimum centre-to-centre distance for two non-overlapping circles. */
const _MIN_DIST_SQ = (2 * PLAYER_RADIUS) * (2 * PLAYER_RADIUS);

/**
 * Resolve a single overlapping pair authoritatively (used by the host).
 * Both entities move (half each) and exchange their normal velocity component.
 *
 * @param {number} a - Entity ID A.
 * @param {number} b - Entity ID B.
 */
function _resolvePairElastic(a, b) {
  const dx = POS_X[b] - POS_X[a];
  const dy = POS_Y[b] - POS_Y[a];
  const d2 = dx * dx + dy * dy;

  if (d2 >= _MIN_DIST_SQ) return;

  // Degenerate: exact same position — nudge B by an arbitrary small offset
  // so we have a valid normal direction.
  let dist, nx, ny;
  if (d2 === 0) {
    dist = 0;
    nx = 1;
    ny = 0;
  } else {
    dist = Math.sqrt(d2);
    nx = dx / dist;
    ny = dy / dist;
  }

  // Positional correction — push each circle out by half the overlap.
  const overlap = 2 * PLAYER_RADIUS - dist;
  const half    = overlap * 0.5;
  POS_X[a] -= nx * half;
  POS_Y[a] -= ny * half;
  POS_X[b] += nx * half;
  POS_Y[b] += ny * half;

  // Velocity exchange along the contact normal (equal mass, elastic).
  // Only resolve if the pair is approaching; otherwise they're already
  // separating and an exchange would re-introduce an inward velocity.
  const vAn = VEL_X[a] * nx + VEL_Y[a] * ny;
  const vBn = VEL_X[b] * nx + VEL_Y[b] * ny;
  const dv  = vBn - vAn;
  if (dv >= 0) return; // separating or sliding → done

  VEL_X[a] += dv * nx;
  VEL_Y[a] += dv * ny;
  VEL_X[b] -= dv * nx;
  VEL_Y[b] -= dv * ny;
}

/**
 * Authoritative all-pairs collision pass. Mutates POS_* and VEL_* in-place.
 * Iteration order is deterministic (i < j ascending) so the host produces
 * the same result every frame for the same input state.
 *
 * @param {number[]} ids    - Active entity IDs to consider.
 * @param {number}   arenaW - Arena width  (px) for re-clamping after resolution.
 * @param {number}   arenaH - Arena height (px).
 */
export function resolveCollisions(ids, arenaW, arenaH) {
  const n = ids.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      _resolvePairElastic(ids[i], ids[j]);
    }
  }
  // A collision push may have moved a circle past the arena clamp the
  // per-entity update() applied moments earlier — re-clamp now.
  for (let k = 0; k < n; k++) {
    const id = ids[k];
    POS_X[id] = Math.max(EDGE_PAD, Math.min(arenaW - EDGE_PAD, POS_X[id]));
    POS_Y[id] = Math.max(EDGE_PAD, Math.min(arenaH - EDGE_PAD, POS_Y[id]));
  }
}

/**
 * Client-side single-entity collision pass.
 *
 * Treats every entity in `otherIds` as an immovable circular obstacle and
 * resolves only `myId`:
 *   • position is pushed out by the full penetration along the contact normal
 *   • the inward (approaching) component of my velocity is removed
 *
 * The host stays authoritative — this exists purely so the local prediction
 * for the player's own circle doesn't visibly clip through other players
 * between authoritative snapshots.
 *
 * @param {number}   myId     - My entity ID.
 * @param {number[]} otherIds - All other live entity IDs.
 * @param {number}   arenaW
 * @param {number}   arenaH
 */
export function resolveOwnCollision(myId, otherIds, arenaW, arenaH) {
  for (let k = 0; k < otherIds.length; k++) {
    const o = otherIds[k];

    // Normal points from the other entity towards me — the direction I get
    // pushed when we overlap.
    const dx = POS_X[myId] - POS_X[o];
    const dy = POS_Y[myId] - POS_Y[o];
    const d2 = dx * dx + dy * dy;
    if (d2 >= _MIN_DIST_SQ) continue;

    let dist, nx, ny;
    if (d2 === 0) {
      dist = 0;
      nx = 1;
      ny = 0;
    } else {
      dist = Math.sqrt(d2);
      nx = dx / dist;
      ny = dy / dist;
    }

    const overlap = 2 * PLAYER_RADIUS - dist;
    POS_X[myId] += nx * overlap;
    POS_Y[myId] += ny * overlap;

    // Zero the component of my velocity that points back into the obstacle.
    // Approaching ⇔ vAn < 0  (because n points from obstacle to me).
    const vAn = VEL_X[myId] * nx + VEL_Y[myId] * ny;
    if (vAn < 0) {
      VEL_X[myId] -= vAn * nx;
      VEL_Y[myId] -= vAn * ny;
    }
  }

  POS_X[myId] = Math.max(EDGE_PAD, Math.min(arenaW - EDGE_PAD, POS_X[myId]));
  POS_Y[myId] = Math.max(EDGE_PAD, Math.min(arenaH - EDGE_PAD, POS_Y[myId]));
}
