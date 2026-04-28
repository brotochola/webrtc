/**
 * drawing.js — módulo de dibujo colaborativo
 *
 * Protocolo binario (ArrayBuffer, big-endian):
 *
 *   MSG_MOUSE      0x01  [type u8, x u16, y u16]                           5 bytes
 *   MSG_DRAW_BEGIN 0x02  [type u8, x u16, y u16, r u8, g u8, b u8, sz u8] 9 bytes
 *   MSG_DRAW_POINT 0x03  [type u8, x u16, y u16]                           5 bytes
 *   MSG_DRAW_END   0x04  [type u8]                                          1 byte
 *   MSG_CLEAR      0x05  [type u8]                                          1 byte
 *
 * Coordenadas normalizadas 0–65535 → independientes de la resolución del canvas.
 */

const CANVAS_W = 900;
const CANVAS_H = 540;
const MAX_U16  = 65535;

const MSG_MOUSE      = 0x01;
const MSG_DRAW_BEGIN = 0x02;
const MSG_DRAW_POINT = 0x03;
const MSG_DRAW_END   = 0x04;
const MSG_CLEAR      = 0x05;

// ── Estado global del módulo ──────────────────────────────────────────────
let wrapper, drawCanvas, cursorCanvas, drawCtx, cursorCtx;
let dc;
let rafId     = null;
let listeners = [];   // para cleanup: [[el, event, fn], ...]

// Estado local
let isDrawing  = false;
let localColor = "#ffffff";
let localSize  = 5;
let localPrevX = 0, localPrevY = 0;
let mousePending = false;

// Estado remoto
let remoteCursor    = null;   // { x, y } en coords de canvas
let remoteDrawing   = false;
let remoteColor     = "#ef4444";
let remoteSize      = 5;
let remotePrevX     = 0, remotePrevY = 0;

// ── Init / Destroy ────────────────────────────────────────────────────────

export function initDrawing(dataChannel, containerEl) {
    dc = dataChannel;
    dc.binaryType = "arraybuffer";

    // Wrapper total
    wrapper = document.createElement("div");
    wrapper.className = "drawing-wrap";

    // ── Toolbar ──
    const toolbar = document.createElement("div");
    toolbar.className = "drawing-toolbar";

    // Color picker
    const colorInput = document.createElement("input");
    colorInput.type      = "color";
    colorInput.value     = localColor;
    colorInput.title     = "Color del pincel";
    colorInput.className = "drawing-color";
    on(colorInput, "input", e => { localColor = e.target.value; });

    // Tamaño
    const sizeWrap = document.createElement("label");
    sizeWrap.className   = "drawing-size-label";
    sizeWrap.textContent = "Tamaño";
    const sizeInput = document.createElement("input");
    sizeInput.type      = "range";
    sizeInput.min       = 1;
    sizeInput.max       = 40;
    sizeInput.value     = localSize;
    sizeInput.className = "drawing-size-range";
    on(sizeInput, "input", e => { localSize = +e.target.value; });
    sizeWrap.appendChild(sizeInput);

    // Borrador
    const eraserBtn = document.createElement("button");
    eraserBtn.textContent = "✏️ Borrador";
    eraserBtn.className   = "action secondary drawing-btn";
    on(eraserBtn, "click", () => { localColor = "#111111"; colorInput.value = "#111111"; });

    // Limpiar canvas (local + remoto)
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "🗑️ Limpiar";
    clearBtn.className   = "action secondary drawing-btn";
    on(clearBtn, "click", () => { clearCanvas(); sendMsg(buildByte(MSG_CLEAR)); });

    toolbar.append(colorInput, sizeWrap, eraserBtn, clearBtn);

    // ── Canvas stack ──
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "drawing-canvas-wrap";

    drawCanvas   = makeCanvas("drawing-canvas");
    cursorCanvas = makeCanvas("drawing-cursor");

    drawCtx   = drawCanvas.getContext("2d");
    cursorCtx = cursorCanvas.getContext("2d");

    drawGrid(drawCtx);

    canvasWrap.append(drawCanvas, cursorCanvas);
    wrapper.append(toolbar, canvasWrap);
    containerEl.appendChild(wrapper);

    // En algunos browsers móviles el height del canvas-wrap no se computa
    // hasta el siguiente frame si el layout aún no finalizó; forzamos recalculo.
    requestAnimationFrame(() => {
        const h = canvasWrap.getBoundingClientRect().height;
        if (h > 0) cursorCanvas.style.height = h + "px";
    });

    // Eventos de ratón
    on(cursorCanvas, "mousemove",  handleMouseMove);
    on(cursorCanvas, "mousedown",  handleMouseDown);
    on(cursorCanvas, "mouseup",    handleMouseUp);
    on(cursorCanvas, "mouseleave", handleMouseLeave);

    // Eventos táctiles (passive:false para poder llamar preventDefault)
    on(cursorCanvas, "touchstart",  handleTouchStart, { passive: false });
    on(cursorCanvas, "touchmove",   handleTouchMove,  { passive: false });
    on(cursorCanvas, "touchend",    handleTouchEnd,   { passive: false });
    on(cursorCanvas, "touchcancel", handleTouchEnd,   { passive: false });

    // Mensajes binarios del peer
    on(dc, "message", handleMessage);

    rafId = requestAnimationFrame(renderCursors);
    console.log("[drawing] inicializado");
}

export function destroyDrawing() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    listeners.forEach(([el, ev, fn, opts]) => el.removeEventListener(ev, fn, opts));
    listeners = [];
    wrapper?.remove();      wrapper      = null;
    drawCanvas?.remove();   drawCanvas   = null; drawCtx   = null;
    cursorCanvas?.remove(); cursorCanvas = null; cursorCtx = null;
    dc = null;
    remoteCursor  = null;
    remoteDrawing = false;
    isDrawing     = false;
    console.log("[drawing] destruido");
}

// ── Eventos de ratón ──────────────────────────────────────────────────────

function handleMouseMove(e) {
    const [nx, ny] = norm(e.clientX, e.clientY);

    if (isDrawing) {
        const [cx, cy] = toCanvas(nx, ny);
        const [px, py] = toCanvas(localPrevX, localPrevY);
        drawLine(drawCtx, px, py, cx, cy, localColor, localSize);
        localPrevX = nx; localPrevY = ny;
        sendMsg(buildPoint(MSG_DRAW_POINT, nx, ny));
        // No enviar MSG_MOUSE por separado mientras se dibuja:
        // el peer actualiza su cursor con los MSG_DRAW_POINT
    } else {
        // Solo movimiento → throttle a 1 msg/frame
        if (!mousePending) {
            mousePending = true;
            requestAnimationFrame(() => {
                mousePending = false;
                sendMsg(buildPoint(MSG_MOUSE, nx, ny));
            });
        }
    }
}

function handleMouseDown(e) {
    if (e.button !== 0) return;
    const [nx, ny] = norm(e.clientX, e.clientY);
    isDrawing  = true;
    localPrevX = nx; localPrevY = ny;
    sendMsg(buildDrawBegin(nx, ny));
}

function handleMouseUp() {
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(buildByte(MSG_DRAW_END));
}

function handleMouseLeave() {
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(buildByte(MSG_DRAW_END));
}

// ── Eventos táctiles ──────────────────────────────────────────────────────

function handleTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    const [nx, ny] = norm(t.clientX, t.clientY);
    isDrawing  = true;
    localPrevX = nx; localPrevY = ny;
    sendMsg(buildDrawBegin(nx, ny));
}

function handleTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    if (!t || !isDrawing) return;
    const [nx, ny] = norm(t.clientX, t.clientY);
    const [cx, cy] = toCanvas(nx, ny);
    const [px, py] = toCanvas(localPrevX, localPrevY);
    drawLine(drawCtx, px, py, cx, cy, localColor, localSize);
    localPrevX = nx; localPrevY = ny;
    sendMsg(buildPoint(MSG_DRAW_POINT, nx, ny));
}

function handleTouchEnd(e) {
    e.preventDefault();
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(buildByte(MSG_DRAW_END));
}

// ── Recepción ─────────────────────────────────────────────────────────────

function handleMessage(e) {
    if (!(e.data instanceof ArrayBuffer)) return;
    const v = new DataView(e.data);
    if (v.byteLength < 1) return;

    switch (v.getUint8(0)) {
        case MSG_MOUSE: {
            if (v.byteLength < 5) break;
            const [x, y] = fromNorm(v, 1);
            remoteCursor = { x, y };
            break;
        }
        case MSG_DRAW_BEGIN: {
            if (v.byteLength < 9) break;
            const [x, y] = fromNorm(v, 1);
            remoteColor   = `rgb(${v.getUint8(5)},${v.getUint8(6)},${v.getUint8(7)})`;
            remoteSize    = v.getUint8(8);
            remoteDrawing = true;
            remotePrevX   = x; remotePrevY = y;
            remoteCursor  = { x, y };
            break;
        }
        case MSG_DRAW_POINT: {
            if (v.byteLength < 5) break;
            const [x, y] = fromNorm(v, 1);
            if (remoteDrawing) {
                drawLine(drawCtx, remotePrevX, remotePrevY, x, y, remoteColor, remoteSize);
            }
            remotePrevX  = x; remotePrevY = y;
            remoteCursor = { x, y };
            break;
        }
        case MSG_DRAW_END: {
            remoteDrawing = false;
            break;
        }
        case MSG_CLEAR: {
            clearCanvas();
            break;
        }
    }
}

// ── Constructores de mensajes ─────────────────────────────────────────────

function buildByte(type) {
    return new Uint8Array([type]).buffer;
}

function buildPoint(type, nx, ny) {
    const buf = new ArrayBuffer(5);
    const v   = new DataView(buf);
    v.setUint8(0, type);
    v.setUint16(1, nx, false);
    v.setUint16(3, ny, false);
    return buf;
}

function buildDrawBegin(nx, ny) {
    const buf = new ArrayBuffer(9);
    const v   = new DataView(buf);
    const hex = localColor.replace("#", "");
    v.setUint8(0, MSG_DRAW_BEGIN);
    v.setUint16(1, nx, false);
    v.setUint16(3, ny, false);
    v.setUint8(5, parseInt(hex.slice(0, 2), 16));
    v.setUint8(6, parseInt(hex.slice(2, 4), 16));
    v.setUint8(7, parseInt(hex.slice(4, 6), 16));
    v.setUint8(8, Math.min(255, Math.max(1, Math.round(localSize))));
    return buf;
}

function sendMsg(buf) {
    if (dc && dc.readyState === "open") dc.send(buf);
}

// ── Canvas helpers ────────────────────────────────────────────────────────

function drawLine(ctx, x0, y0, x1, y1, color, size) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = size;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
}

function clearCanvas() {
    if (!drawCtx) return;
    drawCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawGrid(drawCtx);
}

function drawGrid(ctx) {
    ctx.save();
    ctx.strokeStyle = "#1c1c1c";
    ctx.lineWidth   = 1;
    for (let x = 0; x <= CANVAS_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
    ctx.restore();
}

// ── Render del cursor remoto (loop) ───────────────────────────────────────

function renderCursors() {
    if (!cursorCtx) return;
    cursorCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (remoteCursor) drawRemoteCursor(remoteCursor.x, remoteCursor.y, remoteDrawing);
    rafId = requestAnimationFrame(renderCursors);
}

function drawRemoteCursor(x, y, active) {
    const R = 9;
    cursorCtx.save();
    cursorCtx.shadowColor = active ? "rgba(99,102,241,0.8)" : "rgba(99,102,241,0.4)";
    cursorCtx.shadowBlur  = active ? 18 : 8;
    cursorCtx.strokeStyle = "#6366f1";
    cursorCtx.fillStyle   = active ? "rgba(99,102,241,0.3)" : "rgba(99,102,241,0.1)";
    cursorCtx.lineWidth   = active ? 2.5 : 1.5;

    cursorCtx.beginPath();
    cursorCtx.arc(x, y, R, 0, Math.PI * 2);
    cursorCtx.fill();
    cursorCtx.stroke();

    cursorCtx.beginPath();
    cursorCtx.moveTo(x - R * 1.7, y); cursorCtx.lineTo(x + R * 1.7, y);
    cursorCtx.moveTo(x, y - R * 1.7); cursorCtx.lineTo(x, y + R * 1.7);
    cursorCtx.stroke();
    cursorCtx.restore();
}

// ── Utils ─────────────────────────────────────────────────────────────────

/** Coordenadas normalizadas 0-65535 a partir de clientX/clientY relativas al canvas */
function norm(clientX, clientY) {
    const rect = cursorCanvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(MAX_U16, Math.round(((clientX - rect.left) / rect.width)  * MAX_U16)));
    const ny = Math.max(0, Math.min(MAX_U16, Math.round(((clientY - rect.top)  / rect.height) * MAX_U16)));
    return [nx, ny];
}

/** Normalizado → coords del canvas */
function toCanvas(nx, ny) {
    return [(nx / MAX_U16) * CANVAS_W, (ny / MAX_U16) * CANVAS_H];
}

/** Lee u16 u16 de un DataView y devuelve coords de canvas */
function fromNorm(v, offset) {
    const nx = v.getUint16(offset,     false);
    const ny = v.getUint16(offset + 2, false);
    return toCanvas(nx, ny);
}

function makeCanvas(className) {
    const c = document.createElement("canvas");
    c.width     = CANVAS_W;
    c.height    = CANVAS_H;
    c.className = className;
    return c;
}

function on(el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    listeners.push([el, ev, fn, opts]);
}
