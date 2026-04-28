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
const ACCEL     = 900;

/**
 * Per-frame velocity damping multiplier.
 * Applied as: vel *= FRICTION each integration step.
 * 0 = instant stop, 1 = no damping. Tuned for ~60 fps.
 */
const FRICTION  = 0.88;

/** Absolute velocity ceiling (px / s). Both axes are scaled together. */
const MAX_SPEED = 420;

/** Inset from each arena edge so the emoji character never clips the border. */
const EDGE_PAD  = 22;

// ─── SoA buffers (module-level, allocated once) ───────────────────────────────

/** Maximum number of simultaneous entities. */
const MAX_ENTITIES = 8;

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
     * @param {string} emoji   - Emoji character rendered on the canvas.
     * @param {number} startX  - Initial X position (px).
     * @param {number} startY  - Initial Y position (px).
     */
    constructor(id, emoji, startX, startY) {
        /** @type {number} Entity ID — the only piece of state stored on the object. */
        this.id    = id;
        /** @type {string} */
        this.emoji = emoji;

        // Initialise this entity's slot in every SoA array.
        POS_X[id] = startX;  POS_Y[id] = startY;
        VEL_X[id] = 0;       VEL_Y[id] = 0;
        ACC_X[id] = 0;       ACC_Y[id] = 0;
    }

    // ─── Position ─────────────────────────────────────────────────────────────

    get posX() { return POS_X[this.id]; }
    set posX(v) { POS_X[this.id] = v;  }

    get posY() { return POS_Y[this.id]; }
    set posY(v) { POS_Y[this.id] = v;  }

    // ─── Velocity ─────────────────────────────────────────────────────────────

    get velX() { return VEL_X[this.id]; }
    set velX(v) { VEL_X[this.id] = v;  }

    get velY() { return VEL_Y[this.id]; }
    set velY(v) { VEL_Y[this.id] = v;  }

    // ─── Acceleration ─────────────────────────────────────────────────────────

    get accX() { return ACC_X[this.id]; }
    set accX(v) { ACC_X[this.id] = v;  }

    get accY() { return ACC_Y[this.id]; }
    set accY(v) { ACC_Y[this.id] = v;  }

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
