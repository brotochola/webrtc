import { initDrawing, destroyDrawing } from "./drawing.js";
import { initMedia, destroyMedia } from "./media.js";
import {
    initGameHost, initGameClient,
    addGamePeer, removeGamePeer,
    destroyGame,
} from "./game.js";

export class GameService {
    constructor(containerEl) {
        this.containerEl = containerEl;
    }

    initHost() {
        initGameHost(this.containerEl);
    }

    initClient(dc) {
        initGameClient(dc, this.containerEl);
    }

    addPeer(clientId, dc) {
        addGamePeer(clientId, dc);
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

    init(dc) {
        destroyDrawing();
        initDrawing(dc, this.containerEl);
    }

    destroy() {
        destroyDrawing();
    }
}

export class ChatService {
    constructor({ logEl, msgInput }) {
        this.logEl = logEl;
        this.msgInput = msgInput;
        this.dc = null;
    }

    attachPrimaryChannel(dc, onOpen) {
        this.dc = dc;

        dc.onopen = () => {
            console.log("[DC] open!");
            this.log("🟢 conectado");
            onOpen?.(dc);
        };
        dc.onclose = () => { console.log("[DC] closed"); };
        dc.onerror = e => console.error("[DC] error:", e);
        dc.onmessage = e => {
            if (typeof e.data === "string") {
                console.log("[DC] mensaje:", e.data);
                this.log("📩 " + e.data);
            }
        };
    }

    attachPassiveChannel(dc, clientId) {
        dc.onclose = () => {};
        dc.onerror = e => console.error(`[DC:${clientId}] error:`, e);
        dc.onmessage = e => {
            if (typeof e.data === "string") this.log("📩 " + e.data);
        };
    }

    send() {
        if (this.dc && this.dc.readyState === "open") {
            this.dc.send(this.msgInput.value);
            this.log("📤 " + this.msgInput.value);
            this.msgInput.value = "";
        } else {
            this.log("⚠️ no conectado");
        }
    }

    log(text) {
        this.logEl.textContent += text + "\n";
    }

    clearLog() {
        this.logEl.textContent = "";
    }

    clearChannel() {
        this.dc = null;
    }
}
