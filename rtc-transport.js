import {
    RTC_CHANNEL,
    encodePacket,
    decodePacket,
} from "./rtc-protocol.js";

const HOST_PEER_ID = "host";

class BinaryRouter {
    constructor() {
        this._handlers = new Map();
    }

    on(moduleId, messageType, handler) {
        const key = this._key(moduleId, messageType);
        if (!this._handlers.has(key)) this._handlers.set(key, new Set());
        this._handlers.get(key).add(handler);
        return () => this.off(moduleId, messageType, handler);
    }

    off(moduleId, messageType, handler) {
        const key = this._key(moduleId, messageType);
        const handlers = this._handlers.get(key);
        if (!handlers) return;
        handlers.delete(handler);
        if (handlers.size === 0) this._handlers.delete(key);
    }

    removeAllHandlers() {
        this._handlers.clear();
    }

    _emit(peerId, packet) {
        const handlers = this._handlers.get(this._key(packet.moduleId, packet.messageType));
        if (!handlers) return;
        for (const handler of handlers) handler(peerId, packet);
    }

    _key(moduleId, messageType) {
        return `${moduleId}:${messageType}`;
    }
}

export class RtcHost extends BinaryRouter {
    constructor() {
        super();
        this.peerId = HOST_PEER_ID;
        this.isHost = true;
        this._peers = new Map();
        this._sequence = 0;
    }

    addPeer(peerId, channels) {
        this.removePeer(peerId);

        const peer = {
            channels,
            listeners: [],
        };
        this._peers.set(peerId, peer);

        this._wireChannel(peerId, peer, channels.reliable);
        this._wireChannel(peerId, peer, channels.fast);
    }

    removePeer(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) return;

        for (const [channel, listener] of peer.listeners) {
            channel.removeEventListener("message", listener);
        }
        this._peers.delete(peerId);
    }

    sendTo(peerId, moduleId, messageType, payload, options = {}) {
        const peer = this._peers.get(peerId);
        if (!peer) return false;
        return this._sendOnChannels(peer.channels, moduleId, messageType, payload, options);
    }

    broadcast(moduleId, messageType, payload, options = {}) {
        for (const peerId of this._peers.keys()) {
            this.sendTo(peerId, moduleId, messageType, payload, options);
        }
    }

    broadcastExcept(excludedPeerId, moduleId, messageType, payload, options = {}) {
        for (const peerId of this._peers.keys()) {
            if (peerId === excludedPeerId) continue;
            this.sendTo(peerId, moduleId, messageType, payload, options);
        }
    }

    destroy() {
        for (const peerId of [...this._peers.keys()]) this.removePeer(peerId);
        this.removeAllHandlers();
    }

    _wireChannel(peerId, peer, channel) {
        if (!channel) return;
        channel.binaryType = "arraybuffer";
        const listener = event => this._handleMessage(peerId, event);
        channel.addEventListener("message", listener);
        peer.listeners.push([channel, listener]);
    }

    _handleMessage(peerId, event) {
        const packet = decodePacket(event.data);
        if (!packet) return;
        this._emit(peerId, packet);
    }

    _sendOnChannels(channels, moduleId, messageType, payload, options) {
        const channel = pickOpenChannel(channels, options.channel);
        if (!channel) return false;

        channel.send(encodePacket(moduleId, messageType, payload, {
            flags: options.flags,
            sequence: this._nextSequence(),
            tick: options.tick,
        }));
        return true;
    }

    _nextSequence() {
        this._sequence = (this._sequence + 1) & 0xffff;
        return this._sequence;
    }
}

export class RtcClient extends BinaryRouter {
    constructor() {
        super();
        this.peerId = null;
        this.isHost = false;
        this._channels = { reliable: null, fast: null };
        this._listeners = [];
        this._sequence = 0;
    }

    setChannel(kind, channel) {
        this._unwireChannel(kind);
        this._channels[kind] = channel;
        if (!channel) return;

        channel.binaryType = "arraybuffer";
        const listener = event => this._handleMessage(event);
        channel.addEventListener("message", listener);
        this._listeners.push([kind, channel, listener]);
    }

    send(moduleId, messageType, payload, options = {}) {
        const channel = pickOpenChannel(this._channels, options.channel);
        if (!channel) return false;

        channel.send(encodePacket(moduleId, messageType, payload, {
            flags: options.flags,
            sequence: this._nextSequence(),
            tick: options.tick,
        }));
        return true;
    }

    destroy() {
        for (const [kind] of [...this._listeners]) this._unwireChannel(kind);
        this.removeAllHandlers();
        this.peerId = null;
    }

    _handleMessage(event) {
        const packet = decodePacket(event.data);
        if (!packet) return;
        this._emit(HOST_PEER_ID, packet);
    }

    _unwireChannel(kind) {
        for (let i = this._listeners.length - 1; i >= 0; i--) {
            const [listenerKind, channel, listener] = this._listeners[i];
            if (listenerKind !== kind) continue;
            channel.removeEventListener("message", listener);
            this._listeners.splice(i, 1);
        }
        this._channels[kind] = null;
    }

    _nextSequence() {
        this._sequence = (this._sequence + 1) & 0xffff;
        return this._sequence;
    }
}

function pickOpenChannel(channels, preferred = RTC_CHANNEL.RELIABLE) {
    if (preferred === RTC_CHANNEL.FAST) {
        return openOrNull(channels.fast) || openOrNull(channels.reliable);
    }
    return openOrNull(channels.reliable) || openOrNull(channels.fast);
}

function openOrNull(channel) {
    return channel?.readyState === "open" ? channel : null;
}
