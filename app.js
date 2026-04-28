import { FirebaseSignaling } from "./firebase-service.js";
import { RTCConnection } from "./rtc-connection.js";
import "./iceServers.js";
import {
    ChatService,
    DrawingService,
    GameService,
    MediaService,
} from "./app-services.js";

export class App {
    constructor() {
        this.myId = Math.random().toString(36).slice(2);
        this.roomId = null;
        console.log("[init] myId:", this.myId);

        this.ui = this.getUiRefs();

        this.firebase = new FirebaseSignaling();
        this.game = new GameService(this.ui.gameContainer);
        this.media = new MediaService(this.ui.mediaContainer);
        this.drawing = new DrawingService(this.ui.drawingContainer);
        this.chat = new ChatService({
            logEl: this.ui.logEl,
            msgInput: this.ui.msgInput,
        });

        this.rtc = new RTCConnection({
            myId: this.myId,
            firebase: this.firebase,
            chat: this.chat,
            media: this.media,
            drawing: this.drawing,
            game: this.game,
            setStatus: this.setStatus.bind(this),
        });

        this.bindEvents();
        this.bindModuleToggles();
        this.firebase.watchRooms(rooms => this.renderRooms(rooms));
        this.firebase.cleanupOldRooms();
    }

    getUiRefs() {
        return {
            lobbyEl: document.getElementById("lobby"),
            roomViewEl: document.getElementById("room-view"),
            channelsListEl: document.getElementById("channels-list"),
            channelInput: document.getElementById("channel-input"),
            roomTitleEl: document.getElementById("room-title"),
            statusEl: document.getElementById("room-status"),
            logEl: document.getElementById("log"),
            msgInput: document.getElementById("msg"),
            drawingContainer: document.getElementById("drawing-container"),
            mediaContainer: document.getElementById("media-container"),
            gameContainer: document.getElementById("game-container"),
            joinButton: document.getElementById("btn-join-channel"),
            sendButton: document.getElementById("btn-send"),
            leaveButton: document.getElementById("btn-leave"),
        };
    }

    bindEvents() {
        this.ui.joinButton.addEventListener("click", () => {
            const name = this.ui.channelInput.value.trim();
            if (name) this.enterRoom(name);
        });

        this.ui.sendButton.addEventListener("click", () => this.chat.send());
        this.ui.msgInput.addEventListener("keydown", e => {
            if (e.key === "Enter") this.chat.send();
        });
        this.ui.leaveButton.addEventListener("click", () => this.leaveRoom());
    }

    bindModuleToggles() {
        document.querySelectorAll(".app-module").forEach(moduleEl => {
            const header = moduleEl.querySelector(".app-module-header");
            const body = moduleEl.querySelector(".app-module-body");
            const toggleText = moduleEl.querySelector(".app-module-toggle-text");
            if (!header || !body) return;

            const setExpanded = expanded => {
                header.setAttribute("aria-expanded", String(expanded));
                body.hidden = !expanded;
                moduleEl.classList.toggle("is-collapsed", !expanded);
                if (toggleText) toggleText.textContent = expanded ? "Ocultar" : "Mostrar";
            };

            setExpanded(header.getAttribute("aria-expanded") !== "false");
            header.addEventListener("click", () => {
                const expanded = header.getAttribute("aria-expanded") === "true";
                setExpanded(!expanded);
            });
        });
    }

    renderRooms(rooms) {
        this.ui.channelsListEl.innerHTML = "";

        if (rooms.length === 0) {
            this.ui.channelsListEl.innerHTML = '<div class="channels-label">Canales activos</div><div id="no-channels">No hay canales activos aun.</div>';
            return;
        }

        this.ui.channelsListEl.innerHTML = '<div class="channels-label">Canales activos</div>';
        for (const room of rooms) {
            const btn = document.createElement("button");
            btn.className = "channel-btn";

            const nameSpan = document.createElement("span");
            nameSpan.className = "channel-name";
            nameSpan.textContent = room.name;

            const metaSpan = document.createElement("span");
            metaSpan.className = "channel-meta";

            const countSpan = document.createElement("span");
            countSpan.className = "channel-count";
            countSpan.textContent = `${room.count} conectado${room.count !== 1 ? "s" : ""}`;
            metaSpan.appendChild(countSpan);

            if (room.lastUse) {
                const timeSpan = document.createElement("span");
                timeSpan.className = "channel-time";
                timeSpan.textContent = this.timeAgo(room.lastUse);
                metaSpan.appendChild(timeSpan);
            }

            btn.appendChild(nameSpan);
            btn.appendChild(metaSpan);
            btn.addEventListener("click", () => this.enterRoom(room.name));
            this.ui.channelsListEl.appendChild(btn);
        }
    }

    async enterRoom(name) {
        this.roomId = name;
        this.ui.lobbyEl.hidden = true;
        this.ui.roomViewEl.hidden = false;
        this.ui.roomTitleEl.textContent = this.roomId;
        this.setStatus("conectando...", false);
        this.chat.clearLog();

        console.log(`[room] entrando a "${this.roomId}" como myId=${this.myId}`);
        await this.firebase.enterRoom(this.roomId, this.myId);
        await this.rtc.start(this.roomId);
    }

    async leaveRoom() {
        await this.rtc.leaveRoom();
        this.roomId = null;
        this.ui.roomViewEl.hidden = true;
        this.ui.lobbyEl.hidden = false;
        this.firebase.cleanupOldRooms();
    }

    setStatus(text, connected) {
        this.ui.statusEl.textContent = text;
        this.ui.statusEl.className = connected ? "connected" : "";
    }

    timeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60_000) return "hace menos de 1 min";
        if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
        if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)}h`;
        return `hace ${Math.floor(diff / 86_400_000)}d`;
    }
}
