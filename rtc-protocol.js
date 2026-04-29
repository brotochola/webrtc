export const RTC_PROTOCOL_VERSION = 1;

export const RTC_HEADER_BYTES = 10;

export const RTC_MODULE = Object.freeze({
    CONTROL: 0,
    GAME: 1,
    DRAWING: 2,
    CHAT: 3,
});

export const RTC_CHANNEL = Object.freeze({
    RELIABLE: "reliable",
    FAST: "fast",
});

export const RTC_FLAG = Object.freeze({
    NONE: 0,
});

export const CONTROL_MSG = Object.freeze({
    PEER_READY: 1,
});

export const GAME_MSG = Object.freeze({
    SETUP: 1,
    INPUT: 2,
    SNAPSHOT: 3,
});

export const DRAWING_MSG = Object.freeze({
    MOUSE: 1,
    DRAW_BEGIN: 2,
    DRAW_POINT: 3,
    DRAW_END: 4,
    CLEAR: 5,
});

export const CHAT_MSG = Object.freeze({
    TEXT: 1,
});

export function encodePacket(moduleId, messageType, payload = null, options = {}) {
    const payloadBytes = toUint8Array(payload);
    const buffer = new ArrayBuffer(RTC_HEADER_BYTES + payloadBytes.byteLength);
    const view = new DataView(buffer);

    view.setUint8(0, RTC_PROTOCOL_VERSION);
    view.setUint8(1, moduleId);
    view.setUint8(2, messageType);
    view.setUint8(3, options.flags ?? RTC_FLAG.NONE);
    view.setUint16(4, options.sequence ?? 0, false);
    view.setUint32(6, options.tick ?? 0, false);

    new Uint8Array(buffer, RTC_HEADER_BYTES).set(payloadBytes);
    return buffer;
}

export function decodePacket(data) {
    if (!(data instanceof ArrayBuffer)) return null;
    if (data.byteLength < RTC_HEADER_BYTES) return null;

    const view = new DataView(data);
    const version = view.getUint8(0);
    if (version !== RTC_PROTOCOL_VERSION) return null;

    return {
        version,
        moduleId: view.getUint8(1),
        messageType: view.getUint8(2),
        flags: view.getUint8(3),
        sequence: view.getUint16(4, false),
        tick: view.getUint32(6, false),
        buffer: data,
        payload: new Uint8Array(data, RTC_HEADER_BYTES),
        payloadView: new DataView(data, RTC_HEADER_BYTES),
    };
}

export function toUint8Array(payload) {
    if (!payload) return new Uint8Array(0);
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) {
        return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    throw new TypeError("RTC packet payload must be an ArrayBuffer or typed array");
}
