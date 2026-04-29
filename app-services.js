import { initDrawing, destroyDrawing } from "./drawing.js";
import { initMedia, destroyMedia } from "./media.js";
import {
    initGameHost, initGameClient,
    addGamePeer, removeGamePeer,
    destroyGame,
} from "./game.js";
import { RTC_MODULE, CHAT_MSG } from "./rtc-protocol.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class GameService {
    constructor(containerEl) {
        this.containerEl = containerEl;
    }

    initHost(transport) {
        initGameHost(this.containerEl, transport);
    }

    initClient(transport) {
        initGameClient(transport, this.containerEl);
    }

    addPeer(clientId) {
        addGamePeer(clientId);
    }

    removePeer(clientId) {
        removeGamePeer(clientId);
    }

    destroy() {
        destroyGame();
    }
}

export class MediaService {
    constructor(containerEl) {
        this.containerEl = containerEl;
    }

    init(pc) {
        initMedia(pc, this.containerEl);
    }

    destroy() {
        destroyMedia();
    }
}

export class DrawingService {
    constructor(containerEl) {
        this.containerEl = containerEl;
    }

    init(transport) {
        destroyDrawing();
        initDrawing(transport, this.containerEl);
    }

    destroy() {
        destroyDrawing();
    }
}

export class ChatService {
    constructor({ logEl, msgInput }) {
        this.logEl = logEl;
        this.msgInput = msgInput;
        this.transport = null;
        this.offMessage = null;
    }

    attachTransport(transport) {
        this.clearChannel();
        this.transport = transport;
        this.offMessage = transport.on(RTC_MODULE.CHAT, CHAT_MSG.TEXT, (peerId, packet) => {
            const text = textDecoder.decode(packet.payload);
            this.log("📩 " + text);
            if (transport.isHost) {
                transport.broadcastExcept(peerId, RTC_MODULE.CHAT, CHAT_MSG.TEXT, packet.payload);
            }
        });
    }

    send() {
        const text = this.msgInput.value;
        const payload = textEncoder.encode(text);

        if (!this.transport) {
            this.log("⚠️ no conectado");
            return;
        }

        if (this.transport.isHost) {
            this.transport.broadcast(RTC_MODULE.CHAT, CHAT_MSG.TEXT, payload);
        } else if (!this.transport.send(RTC_MODULE.CHAT, CHAT_MSG.TEXT, payload)) {
            this.log("⚠️ no conectado");
            return;
        }

        this.log("📤 " + text);
        this.msgInput.value = "";
    }

    log(text) {
        this.logEl.textContent += text + "\n";
    }

    clearLog() {
        this.logEl.textContent = "";
    }

    clearChannel() {
        if (this.offMessage) this.offMessage();
        this.offMessage = null;
        this.transport = null;
    }
}
