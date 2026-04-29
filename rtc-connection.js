import { RtcHost, RtcClient } from "./rtc-transport.js";

export class RTCConnection {
    constructor({ myId, firebase, chat, media, drawing, game, setStatus }) {
        this.myId = myId;
        this.firebase = firebase;
        this.chat = chat;
        this.media = media;
        this.drawing = drawing;
        this.game = game;
        this.setStatus = setStatus;

        this.roomId = null;
        this.isCaller = false;
        this.reconnectTimer = null;
        this.hostTransport = null;
        this.clientTransport = null;

        this.peerMap = new Map();
        this.presenceAddedUnsub = null;
        this.presenceRemovedUnsub = null;

        this.clientPc = null;
        this.clientPendingCandidates = [];
        this.clientCandidatesUnsub = null;
        this.clientOfferUnsub = null;
    }

    async start(roomId) {
        this.roomId = roomId;
        this.isCaller = false;
        await this.startWebRTC();
    }

    async startWebRTC() {
        const didClaimHost = await this.firebase.claimHost(this.roomId, this.myId);

        if (didClaimHost) {
            this.startHost();
        } else {
            await this.startClient();
        }
    }

    startHost() {
        this.isCaller = true;
        console.log("[join] soy HOST");

        this.hostTransport = new RtcHost();
        this.chat.attachTransport(this.hostTransport);
        this.drawing.init(this.hostTransport);
        this.game.initHost(this.hostTransport);

        this.presenceAddedUnsub = this.firebase.watchPresenceAdded(this.roomId, clientId => {
            if (clientId === this.myId) return;
            this.connectToClient(clientId);
        });

        this.presenceRemovedUnsub = this.firebase.watchPresenceRemoved(this.roomId, clientId => {
            if (clientId === this.myId) return;
            console.log(`[presence] ${clientId} salio`);
            this.game.removePeer(clientId);
            this.closePeer(clientId);
        });
    }

    async startClient() {
        console.log("[join] soy CLIENT - esperando offer en connections/" + this.myId);

        this.clientTransport = new RtcClient();
        this.chat.attachTransport(this.clientTransport);
        this.drawing.init(this.clientTransport);
        this.game.initClient(this.clientTransport);

        this.clientPc = this.createPeerConnection();

        this.clientPc.onicecandidate = async e => {
            if (!e.candidate) return;
            await this.firebase.sendCandidate(this.roomId, this.myId, {
                from: "client",
                candidate: e.candidate.toJSON(),
            });
        };

        this.clientPc.onicegatheringstatechange = () =>
            console.log("[ICE] gatheringState ->", this.clientPc.iceGatheringState);

        this.clientPc.oniceconnectionstatechange = () =>
            console.log("[ICE] iceConnectionState ->", this.clientPc.iceConnectionState);

        this.clientPc.onconnectionstatechange = () => {
            const state = this.clientPc.connectionState;
            console.log("[PC] connectionState ->", state);
            this.setStatus(state, state === "connected");

            if (state === "connected") {
                this.chat.log("🟢 conectado");
                this.clearReconnectTimer();
                this.firebase.clearCandidates(this.roomId, this.myId);
            }
            if (state === "failed") {
                this.chat.log("🔴 conexion fallida - reconectando...");
                this.scheduleReconnect(500);
            }
            if (state === "disconnected") {
                this.chat.log("🟡 el otro se desconecto - esperando...");
                this.scheduleReconnect(4000);
            }
        };

        this.clientPc.ondatachannel = e => {
            console.log("[DC] ondatachannel:", e.channel.label);
            if (e.channel.label === "reliable") this.clientTransport.setChannel("reliable", e.channel);
            if (e.channel.label === "fast") this.clientTransport.setChannel("fast", e.channel);
        };

        // Media must be ready before setRemoteDescription so ontrack is installed.
        this.media.init(this.clientPc);

        this.clientCandidatesUnsub = this.firebase.watchCandidates(
            this.roomId,
            this.myId,
            "host",
            candidate => {
                this.clientPendingCandidates.push(candidate);
                this.flushClientCandidates();
            },
        );

        let lastOfferId = null;
        let lastLegacyOfferSeq = 0;
        this.clientOfferUnsub = this.firebase.watchOffer(this.roomId, this.myId, async ({ type, sdp, seq = 1, offerId }) => {
            if (offerId) {
                if (offerId === lastOfferId) return;
                lastOfferId = offerId;
            } else {
                if (seq <= lastLegacyOfferSeq) return;
                lastLegacyOfferSeq = seq;
            }
            console.log(`[Firebase] offer descifrado (seq=${seq}, offerId=${offerId ?? "legacy"}) -> setRemoteDescription...`);
            try {
                await this.clientPc.setRemoteDescription({ type, sdp });
                console.log("[SDP] setRemoteDescription(offer) OK");
                await this.flushClientCandidates();

                for (const t of this.clientPc.getTransceivers()) {
                    if (t.direction === "recvonly") t.direction = "sendrecv";
                }

                const answer = await this.clientPc.createAnswer();
                await this.clientPc.setLocalDescription(answer);
                console.log("[SDP] setLocalDescription(answer)");
                await this.firebase.sendAnswer(this.roomId, this.myId, {
                    type: answer.type,
                    sdp: answer.sdp,
                    seq,
                    offerId,
                });
                console.log(`[Firebase] answer subido cifrado (seq=${seq}, offerId=${offerId ?? "legacy"})`);
            } catch (e) {
                console.error("[SDP] error procesando offer:", e);
            }
        });
    }

    async connectToClient(clientId) {
        if (this.peerMap.has(clientId)) return;

        const isFirstPeer = this.peerMap.size === 0;
        const peerPc = this.createPeerConnection();
        const peer = {
            pc: peerPc,
            reliableDc: null,
            fastDc: null,
            transportReady: false,
            pendingCandidates: [],
            candidatesUnsub: null,
            answerUnsub: null,
        };
        this.peerMap.set(clientId, peer);
        console.log(`[Host] connecting to ${clientId} (first=${isFirstPeer})`);

        peerPc.onicecandidate = async e => {
            if (!e.candidate) return;
            await this.firebase.sendCandidate(this.roomId, clientId, {
                from: "host",
                candidate: e.candidate.toJSON(),
            });
        };

        peerPc.onicegatheringstatechange = () =>
            console.log(`[ICE:${clientId}] gatheringState ->`, peerPc.iceGatheringState);

        peerPc.onconnectionstatechange = () => {
            const state = peerPc.connectionState;
            console.log(`[PC:${clientId}] connectionState ->`, state);

            if (state === "connected") {
                if (isFirstPeer) {
                    this.setStatus(state, true);
                    this.chat.log("🟢 conectado");
                }
                this.clearReconnectTimer();
                this.firebase.clearCandidates(this.roomId, clientId);
            }
            if (state === "failed") {
                console.warn(`[PC:${clientId}] failed - removing peer`);
                this.game.removePeer(clientId);
                this.hostTransport?.removePeer(clientId);
                this.closePeer(clientId);
            }
            if (state === "disconnected" && isFirstPeer) {
                this.chat.log("🟡 el otro se desconecto - esperando...");
                this.scheduleReconnect(4000);
            }
        };

        peer.reliableDc = peerPc.createDataChannel("reliable");
        peer.reliableDc.binaryType = "arraybuffer";
        peer.reliableDc.onopen = () => {
            console.log(`[RTC reliable] open (host->${clientId})`);
            this.registerHostPeer(clientId, peer);
        };
        peer.reliableDc.onerror = e => console.error(`[RTC reliable:${clientId}] error:`, e);

        peer.fastDc = peerPc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 });
        peer.fastDc.binaryType = "arraybuffer";
        peer.fastDc.onopen = () => console.log(`[RTC fast] open (host->${clientId})`);
        peer.fastDc.onerror = e => console.error(`[RTC fast:${clientId}] error:`, e);

        if (isFirstPeer) {
            peerPc.addTransceiver("video", { direction: "sendrecv" });
            peerPc.addTransceiver("audio", { direction: "sendrecv" });
            this.media.init(peerPc);
        }

        let negotiationSeq = 0;
        let currentOfferId = null;
        let lastAnswerOfferId = null;

        peerPc.onnegotiationneeded = async () => {
            if (peerPc.signalingState !== "stable") return;
            negotiationSeq++;
            const seq = negotiationSeq;
            const offerId = `${this.myId}-${clientId}-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            currentOfferId = offerId;
            console.log(`[SDP:${clientId}] onnegotiationneeded (seq=${seq}, offerId=${offerId})`);
            try {
                const offer = await peerPc.createOffer();
                await peerPc.setLocalDescription(offer);
                await this.firebase.clearAnswer(this.roomId, clientId);
                await this.firebase.sendOffer(this.roomId, clientId, {
                    type: offer.type,
                    sdp: offer.sdp,
                    seq,
                    offerId,
                });
                console.log(`[Firebase] offer subido para ${clientId} (seq=${seq}, offerId=${offerId})`);
            } catch (e) {
                if (currentOfferId === offerId) currentOfferId = null;
                console.error(`[SDP:${clientId}] onnegotiationneeded error:`, e);
            }
        };

        peer.answerUnsub = this.firebase.watchAnswer(this.roomId, clientId, async ({ type, sdp, seq = 1, offerId }) => {
            if (!offerId || offerId !== currentOfferId) {
                console.warn(
                    `[Firebase] answer ignorado de ${clientId}: offerId=${offerId ?? "legacy"} esperado=${currentOfferId ?? "none"}`,
                );
                return;
            }
            if (offerId === lastAnswerOfferId) return;
            if (peerPc.signalingState !== "have-local-offer") {
                console.warn(`[SDP:${clientId}] answer ignorado en estado ${peerPc.signalingState} (offerId=${offerId})`);
                return;
            }
            console.log(`[Firebase] answer de ${clientId} (seq=${seq}, offerId=${offerId}) -> setRemoteDescription...`);
            try {
                await peerPc.setRemoteDescription({ type, sdp });
                lastAnswerOfferId = offerId;
                currentOfferId = null;
                console.log(`[SDP:${clientId}] setRemoteDescription(answer) OK`);
                this.flushPeerCandidates(peerPc, peer.pendingCandidates);
            } catch (e) {
                console.error(`[SDP:${clientId}] setRemoteDescription(answer) ERROR:`, e);
            }
        });

        peer.candidatesUnsub = this.firebase.watchCandidates(
            this.roomId,
            clientId,
            "client",
            candidate => {
                peer.pendingCandidates.push(candidate);
                this.flushPeerCandidates(peerPc, peer.pendingCandidates);
            },
        );
    }

    registerHostPeer(clientId, peer) {
        if (peer.transportReady) return;
        if (!this.hostTransport) return;
        peer.transportReady = true;
        this.hostTransport.addPeer(clientId, {
            reliable: peer.reliableDc,
            fast: peer.fastDc,
        });
        this.game.addPeer(clientId);
    }

    createPeerConnection() {
        return new RTCPeerConnection({ iceServers: window.iceServers || [] });
    }

    closePeer(clientId) {
        const peer = this.peerMap.get(clientId);
        if (!peer) return;

        if (peer.candidatesUnsub) peer.candidatesUnsub();
        if (peer.answerUnsub) peer.answerUnsub();
        this.hostTransport?.removePeer(clientId);
        try { peer.pc.close(); } catch (_) {}
        this.peerMap.delete(clientId);
        console.log(`[Host] peer ${clientId} closed`);
    }

    flushPeerCandidates(peerPc, queue) {
        if (!peerPc.remoteDescription) return;
        while (queue.length) {
            const init = queue.shift();
            if (!init?.candidate) continue;
            const patched = { ...init };
            if (patched.sdpMLineIndex == null && patched.sdpMid == null) patched.sdpMLineIndex = 0;
            peerPc.addIceCandidate(patched).catch(e => console.error("[ICE] addIceCandidate ERROR:", e));
        }
    }

    async flushClientCandidates() {
        if (!this.clientPc || !this.clientPc.remoteDescription) return;
        while (this.clientPendingCandidates.length) {
            const init = this.clientPendingCandidates.shift();
            if (!init?.candidate) continue;
            const patched = { ...init };
            if (patched.sdpMLineIndex == null && patched.sdpMid == null) patched.sdpMLineIndex = 0;
            try {
                await this.clientPc.addIceCandidate(patched);
            } catch (e) {
                console.error("[ICE] addIceCandidate ERROR:", e);
            }
        }
    }

    scheduleReconnect(delayMs) {
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (!this.roomId) return;
            console.log("[reconnect] reiniciando WebRTC...");
            this.chat.log("↻ reconectando...");
            this.media.destroy();
            this.drawing.destroy();
            this.game.destroy();
            this.closeRtcState();
            this.chat.clearChannel();
            this.isCaller = false;
            await this.startWebRTC();
        }, delayMs);
    }

    async leaveRoom() {
        const roomId = this.roomId;
        const wasCaller = this.isCaller;

        this.clearReconnectTimer();
        this.media.destroy();
        this.drawing.destroy();
        this.game.destroy();
        this.closeRtcState();
        this.chat.clearChannel();

        await this.firebase.leaveRoom(roomId, this.myId, wasCaller);

        this.roomId = null;
        this.isCaller = false;
    }

    closeRtcState() {
        if (this.presenceAddedUnsub) {
            this.presenceAddedUnsub();
            this.presenceAddedUnsub = null;
        }
        if (this.presenceRemovedUnsub) {
            this.presenceRemovedUnsub();
            this.presenceRemovedUnsub = null;
        }

        for (const { pc, candidatesUnsub, answerUnsub } of this.peerMap.values()) {
            if (candidatesUnsub) candidatesUnsub();
            if (answerUnsub) answerUnsub();
            try { pc.close(); } catch (_) {}
        }
        this.peerMap.clear();
        this.hostTransport?.destroy();
        this.hostTransport = null;

        if (this.clientCandidatesUnsub) {
            this.clientCandidatesUnsub();
            this.clientCandidatesUnsub = null;
        }
        if (this.clientOfferUnsub) {
            this.clientOfferUnsub();
            this.clientOfferUnsub = null;
        }
        if (this.clientPc) {
            try { this.clientPc.close(); } catch (_) {}
            this.clientPc = null;
        }
        this.clientTransport?.destroy();
        this.clientTransport = null;
        this.clientPendingCandidates = [];
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
