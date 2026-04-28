/**
 * game-renderer.js
 *
 * Builds the game panel DOM (canvas + labels) and handles all drawing.
 * This class is intentionally free of any game-logic or network code —
 * it only knows how to turn a pair of player objects into pixels.
 */

/** Logical arena dimensions (CSS pixels at 1× DPR). */
export const ARENA_W = 600;
export const ARENA_H = 380;

/** Radius of each player circle (px). */
const PLAYER_RADIUS = 16;

/**
 * Faint grid line spacing (px).
 * A subtle grid helps players perceive relative movement.
 */
const GRID_STEP = 40;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GameRenderer
 *
 * Manages a <canvas> element and exposes a single render() method that
 * redraws both players every time it is called. The caller is responsible
 * for deciding *when* to call render() (e.g. inside a rAF loop or on
 * every incoming position packet).
 */
export class GameRenderer {
    /**
     * @param {HTMLElement} containerEl - DOM node to inject the panel into.
     *   Its previous contents are replaced on construction and cleared on destroy().
     */
    constructor(containerEl) {
        this._container = containerEl;
        this._buildDOM();
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /** Creates the panel markup and stores references to key nodes. */
    _buildDOM() {
        this._container.innerHTML = `
            <div class="game-panel">
                <div class="game-panel-header">
                    <span class="game-panel-title">🕹️ Arena</span>
                    <span class="game-panel-hint">Mové con ← → ↑ ↓ o WASD</span>
                </div>
                <canvas class="game-canvas" width="${ARENA_W}" height="${ARENA_H}"></canvas>
                <div class="game-panel-legend">
                    <span class="game-legend-host">&#9679; Host</span>
                    <span class="game-legend-client">&#9679; Cliente</span>
                </div>
            </div>`;

        this._canvas = this._container.querySelector('.game-canvas');
        this._ctx    = this._canvas.getContext('2d');

        // Scale canvas for high-DPI screens without stretching the layout.
        this._applyDPR();
    }

    /**
     * Scales the canvas backing store to the device pixel ratio so that
     * everything looks crisp on retina / HiDPI displays.
     */
    _applyDPR() {
        const dpr = window.devicePixelRatio || 1;
        if (dpr === 1) return; // nothing to do on standard displays

        // Stretch the backing store, keep the CSS size.
        this._canvas.width  = ARENA_W * dpr;
        this._canvas.height = ARENA_H * dpr;
        this._canvas.style.width  = `${ARENA_W}px`;
        this._canvas.style.height = `${ARENA_H}px`;
        this._ctx.scale(dpr, dpr);
    }

    // ─── Drawing helpers ─────────────────────────────────────────────────────

    /** Fills the arena with the background colour and draws the faint grid. */
    _drawBackground() {
        const ctx = this._ctx;

        // Solid dark background
        ctx.fillStyle = '#0f1923';
        ctx.fillRect(0, 0, ARENA_W, ARENA_H);

        // Faint grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth   = 1;
        ctx.beginPath();

        for (let x = GRID_STEP; x < ARENA_W; x += GRID_STEP) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, ARENA_H);
        }
        for (let y = GRID_STEP; y < ARENA_H; y += GRID_STEP) {
            ctx.moveTo(0, y);
            ctx.lineTo(ARENA_W, y);
        }
        ctx.stroke();

        // Subtle arena border
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(1, 1, ARENA_W - 2, ARENA_H - 2);
    }

    /**
     * Renders one player as a filled circle.
     *
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
     * Clear the canvas and redraw both players.
     * Safe to call at any frequency; no internal state is mutated.
     *
     * @param {{ color: string, posX: number, posY: number }} hostPlayer
     * @param {{ color: string, posX: number, posY: number }} clientPlayer
     */
    render(hostPlayer, clientPlayer) {
        this._drawBackground();
        this._drawPlayer(hostPlayer);
        this._drawPlayer(clientPlayer);
    }

    /**
     * Remove the panel from the DOM and release the canvas reference.
     * Called by the facade's destroyGame().
     */
    destroy() {
        this._container.innerHTML = '';
        this._canvas = null;
        this._ctx    = null;
    }
}
