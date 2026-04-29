/**
 * drawing.js — módulo de dibujo colaborativo
 *
 * Payloads binarios (ArrayBuffer, big-endian) enviados por el transporte RTC:
 *
 *   MOUSE      [x u16, y u16]                           4 bytes
 *   DRAW_BEGIN [x u16, y u16, r u8, g u8, b u8, sz u8] 8 bytes
 *   DRAW_POINT [x u16, y u16]                           4 bytes
 *   DRAW_END   empty
 *   CLEAR      empty
 *
 * Coordenadas normalizadas 0–65535 → independientes de la resolución del canvas.
 */

import { RTC_MODULE, DRAWING_MSG } from "./rtc-protocol.js";

const CANVAS_W = 900;
const CANVAS_H = 540;
const MAX_U16  = 65535;

// ── Estado global del módulo ──────────────────────────────────────────────
let wrapper, drawCanvas, cursorCanvas, drawCtx, cursorCtx;
let transport;
let rafId     = null;
let listeners = [];   // para cleanup: [[el, event, fn], ...]
let offPackets = [];

// Estado local
let isDrawing  = false;
let localColor = "#ffffff";
let localSize  = 5;
let localPrevX = 0, localPrevY = 0;
let mousePending = false;

// Estado remoto, indexado por peerId (host) o sourceId (clientes).
let remotePeers = new Map();
let sourceIds = new Map();
let nextSourceId = 1;

// ── Init / Destroy ────────────────────────────────────────────────────────

export function initDrawing(rtcTransport, containerEl) {
    transport = rtcTransport;

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
    on(clearBtn, "click", () => { clearCanvas(); sendMsg(DRAWING_MSG.CLEAR); });

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

    // Mensajes binarios del transporte RTC.
    for (const type of Object.values(DRAWING_MSG)) {
        offPackets.push(transport.on(RTC_MODULE.DRAWING, type, handlePacket));
    }

    rafId = requestAnimationFrame(renderCursors);
    console.log("[drawing] inicializado");
}

export function destroyDrawing() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    listeners.forEach(([el, ev, fn, opts]) => el.removeEventListener(ev, fn, opts));
    listeners = [];
    offPackets.forEach(off => off());
    offPackets = [];
    wrapper?.remove();      wrapper      = null;
    drawCanvas?.remove();   drawCanvas   = null; drawCtx   = null;
    cursorCanvas?.remove(); cursorCanvas = null; cursorCtx = null;
    transport = null;
    remotePeers.clear();
    sourceIds.clear();
    nextSourceId = 1;
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
        sendMsg(DRAWING_MSG.DRAW_POINT, buildPoint(nx, ny));
        // No enviar movimiento separado mientras se dibuja:
        // el peer actualiza su cursor con los puntos de trazo.
    } else {
        // Solo movimiento → throttle a 1 msg/frame
        if (!mousePending) {
            mousePending = true;
            requestAnimationFrame(() => {
                mousePending = false;
                sendMsg(DRAWING_MSG.MOUSE, buildPoint(nx, ny));
            });
        }
    }
}

function handleMouseDown(e) {
    if (e.button !== 0) return;
    const [nx, ny] = norm(e.clientX, e.clientY);
    isDrawing  = true;
    localPrevX = nx; localPrevY = ny;
    sendMsg(DRAWING_MSG.DRAW_BEGIN, buildDrawBegin(nx, ny));
}

function handleMouseUp() {
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(DRAWING_MSG.DRAW_END);
}

function handleMouseLeave() {
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(DRAWING_MSG.DRAW_END);
}

// ── Eventos táctiles ──────────────────────────────────────────────────────

function handleTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    const [nx, ny] = norm(t.clientX, t.clientY);
    isDrawing  = true;
    localPrevX = nx; localPrevY = ny;
    sendMsg(DRAWING_MSG.DRAW_BEGIN, buildDrawBegin(nx, ny));
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
    sendMsg(DRAWING_MSG.DRAW_POINT, buildPoint(nx, ny));
}

function handleTouchEnd(e) {
    e.preventDefault();
    if (!isDrawing) return;
    isDrawing = false;
    sendMsg(DRAWING_MSG.DRAW_END);
}

// ── Recepción ─────────────────────────────────────────────────────────────

function handlePacket(peerId, packet) {
    const type = packet.messageType;

    if (transport?.isHost) {
        applyRemotePacket(peerId, type, packet.payloadView);
        transport.broadcastExcept(
            peerId,
            RTC_MODULE.DRAWING,
            type,
            withSourceId(sourceIdForPeer(peerId), packet.payload),
        );
        return;
    }

    if (packet.payload.byteLength < 1) return;
    const sourceId = packet.payload[0];
    const view = new DataView(
        packet.payload.buffer,
        packet.payload.byteOffset + 1,
        packet.payload.byteLength - 1,
    );
    applyRemotePacket(sourceId, type, view);
}

function applyRemotePacket(remoteId, type, v) {
    const state = remoteState(remoteId);

    switch (type) {
        case DRAWING_MSG.MOUSE: {
            if (v.byteLength < 4) break;
            const [x, y] = fromNorm(v, 0);
            state.cursor = { x, y };
            break;
        }
        case DRAWING_MSG.DRAW_BEGIN: {
            if (v.byteLength < 8) break;
            const [x, y] = fromNorm(v, 0);
            state.color   = `rgb(${v.getUint8(4)},${v.getUint8(5)},${v.getUint8(6)})`;
            state.size    = v.getUint8(7);
            state.drawing = true;
            state.prevX   = x; state.prevY = y;
            state.cursor  = { x, y };
            break;
        }
        case DRAWING_MSG.DRAW_POINT: {
            if (v.byteLength < 4) break;
            const [x, y] = fromNorm(v, 0);
            if (state.drawing) {
                drawLine(drawCtx, state.prevX, state.prevY, x, y, state.color, state.size);
            }
            state.prevX  = x; state.prevY = y;
            state.cursor = { x, y };
            break;
        }
        case DRAWING_MSG.DRAW_END: {
            state.drawing = false;
            break;
        }
        case DRAWING_MSG.CLEAR: {
            clearCanvas();
            remotePeers.clear();
            break;
        }
    }
}

function remoteState(remoteId) {
    if (!remotePeers.has(remoteId)) {
        remotePeers.set(remoteId, {
            cursor: null,
            drawing: false,
            color: "#ef4444",
            size: 5,
            prevX: 0,
            prevY: 0,
        });
    }
    return remotePeers.get(remoteId);
}

// ── Constructores de mensajes ─────────────────────────────────────────────

function buildPoint(nx, ny) {
    const buf = new ArrayBuffer(4);
    const v   = new DataView(buf);
    v.setUint16(0, nx, false);
    v.setUint16(2, ny, false);
    return buf;
}

function buildDrawBegin(nx, ny) {
    const buf = new ArrayBuffer(8);
    const v   = new DataView(buf);
    const hex = localColor.replace("#", "");
    v.setUint16(0, nx, false);
    v.setUint16(2, ny, false);
    v.setUint8(4, parseInt(hex.slice(0, 2), 16));
    v.setUint8(5, parseInt(hex.slice(2, 4), 16));
    v.setUint8(6, parseInt(hex.slice(4, 6), 16));
    v.setUint8(7, Math.min(255, Math.max(1, Math.round(localSize))));
    return buf;
}

function sendMsg(type, payload = null) {
    if (!transport) return;
    if (transport.isHost) {
        transport.broadcast(RTC_MODULE.DRAWING, type, withSourceId(0, payload));
    } else {
        transport.send(RTC_MODULE.DRAWING, type, payload);
    }
}

function sourceIdForPeer(peerId) {
    if (!sourceIds.has(peerId)) sourceIds.set(peerId, nextSourceId++);
    return sourceIds.get(peerId);
}

function withSourceId(sourceId, payload = null) {
    const payloadBytes = payload
        ? new Uint8Array(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength ?? payload.byteLength)
        : new Uint8Array(0);
    const out = new Uint8Array(1 + payloadBytes.byteLength);
    out[0] = sourceId & 0xff;
    out.set(payloadBytes, 1);
    return out;
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
    for (const state of remotePeers.values()) {
        if (state.cursor) drawRemoteCursor(state.cursor.x, state.cursor.y, state.drawing);
    }
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
