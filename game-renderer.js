/**
 * game-renderer.js
 *
 * Builds the game panel DOM (canvas + labels) and handles all drawing.
 * Intentionally free of game-logic and network code — it only turns an
 * array of player objects into pixels.
 *
 * render() now accepts a Player[] indexed by entity ID so the same
 * renderer works for any number of players (2…MAX_ENTITIES).
 */

import { PLAYER_COLORS } from './game-physics.js';

/** Logical arena dimensions (CSS pixels at 1× DPR). */
export const ARENA_W = 600;
export const ARENA_H = 380;

/** Radius of each player circle (px). */
const PLAYER_RADIUS = 16;

/** Faint grid line spacing (px). */
const GRID_STEP = 40;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameRenderer
 *
 * Manages a <canvas> element and exposes a render(players) method that
 * redraws every non-null entry in the players array on each call.
 */
export class GameRenderer {
    /**
     * @param {HTMLElement} containerEl - DOM node to inject the panel into.
     */
    constructor(containerEl) {
        this._container = containerEl;
        this._legendEl  = null;   // updated by updateLegend()
        this._buildDOM();
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /** Creates the initial panel markup. */
    _buildDOM() {
        this._container.innerHTML = `
            <div class="game-panel">
                <div class="game-panel-header">
                    <span class="game-panel-title">🕹️ Arena</span>
                    <span class="game-panel-hint">Mové con ← → ↑ ↓ o WASD</span>
                </div>
                <canvas class="game-canvas" width="${ARENA_W}" height="${ARENA_H}"></canvas>
                <div class="game-panel-legend"></div>
            </div>`;

        this._canvas    = this._container.querySelector('.game-canvas');
        this._ctx       = this._canvas.getContext('2d');
        this._legendEl  = this._container.querySelector('.game-panel-legend');

        // Start with a default 2-player legend; host calls updateLegend() as
        // peers join/leave.
        this.updateLegend(['Host', 'Cliente']);

        this._applyDPR();
    }

    /** Scales the canvas backing store to the device pixel ratio. */
    _applyDPR() {
        const dpr = window.devicePixelRatio || 1;
        if (dpr === 1) return;
        this._canvas.width  = ARENA_W * dpr;
        this._canvas.height = ARENA_H * dpr;
        this._canvas.style.width  = `${ARENA_W}px`;
        this._canvas.style.height = `${ARENA_H}px`;
        this._ctx.scale(dpr, dpr);
    }

    /** Fills the arena background with the dark colour and draws the grid. */
    _drawBackground() {
        const ctx = this._ctx;

        ctx.fillStyle = '#0f1923';
        ctx.fillRect(0, 0, ARENA_W, ARENA_H);

        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        for (let x = GRID_STEP; x < ARENA_W; x += GRID_STEP) {
            ctx.moveTo(x, 0); ctx.lineTo(x, ARENA_H);
        }
        for (let y = GRID_STEP; y < ARENA_H; y += GRID_STEP) {
            ctx.moveTo(0, y); ctx.lineTo(ARENA_W, y);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(1, 1, ARENA_W - 2, ARENA_H - 2);
    }

    /**
     * Renders one player as a filled circle.
     * @param {{ color: string, posX: number, posY: number }} player
     */
    _drawPlayer(player) {
        const ctx = this._ctx;
        ctx.beginPath();
        ctx.arc(player.posX, player.posY, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = player.color;
        ctx.fill();
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Rebuild the legend row to reflect the current player list.
     * Call this whenever a peer joins or leaves.
     *
     * @param {string[]} labels - Display name for each entity ID (index = entity ID).
     */
    updateLegend(labels) {
        if (!this._legendEl) return;
        this._legendEl.innerHTML = labels
            .map((label, i) => {
                const color = PLAYER_COLORS[i] ?? '#ffffff';
                return `<span class="game-legend-entry" style="color:${color}">&#9679; ${label}</span>`;
            })
            .join('');
    }

    /**
     * Clear the canvas and draw every non-null player in the array.
     * The array is indexed by entity ID — null entries are simply skipped.
     *
     * @param {Array<{color:string, posX:number, posY:number}|null>} players
     */
    render(players) {
        this._drawBackground();
        for (const player of players) {
            if (player) this._drawPlayer(player);
        }
    }

    /**
     * Remove the panel from the DOM and release canvas references.
     * Called by the facade's destroyGame().
     */
    destroy() {
        this._container.innerHTML = '';
        this._canvas   = null;
        this._ctx      = null;
        this._legendEl = null;
    }
}
