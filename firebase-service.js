import { deriveRoomKey, encryptVal, decryptVal } from "./crypto-utils.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getDatabase, ref, set, update, push, remove, get,
    onChildAdded, onChildRemoved, onValue, runTransaction, onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const TEN_MIN = 10 * 60 * 1000;

const firebaseConfig = {
    apiKey: "AIzaSyA2PW7pAnTSrutVDYabtwL7Q3JB2Mir3Pw",
    authDomain: "webrtc-5c119.firebaseapp.com",
    databaseURL: "https://webrtc-5c119-default-rtdb.firebaseio.com",
    projectId: "webrtc-5c119",
    storageBucket: "webrtc-5c119.firebasestorage.app",
    messagingSenderId: "334466186648",
    appId: "1:334466186648:web:10429db094bf249c203fed",
};

export class FirebaseSignaling {
    constructor(config = firebaseConfig) {
        this.app = initializeApp(config);
        this.db = getDatabase(this.app);
        this.roomId = null;
        this.roomKey = null;
    }

    watchRooms(onRooms) {
        return onValue(ref(this.db, "rooms"), snap => {
            const rooms = snap.val() || {};
            const activeRooms = Object.entries(rooms)
                .filter(([, data]) => data && data.presence)
                .map(([name, data]) => ({
                    name,
                    count: data.presence ? Object.keys(data.presence).length : 0,
                    lastUse: data?.meta?.last_use ?? data?.meta?.date_created,
                }));

            onRooms(activeRooms);
        });
    }

    async cleanupOldRooms() {
        const snap = await get(ref(this.db, "rooms"));
        if (!snap.exists()) return;

        const now = Date.now();
        const deletes = [];
        for (const [name, data] of Object.entries(snap.val())) {
            const lastUse = data?.meta?.last_use ?? data?.meta?.date_created ?? 0;
            if (now - lastUse > TEN_MIN) {
                console.log(`[cleanup] borrando "${name}" - ultimo uso: ${new Date(lastUse).toLocaleTimeString()}`);
                deletes.push(remove(ref(this.db, `rooms/${name}`)));
            }
        }

        if (deletes.length) {
            await Promise.all(deletes);
            console.log(`[cleanup] ${deletes.length} canal(es) eliminado(s)`);
        }
    }

    async enterRoom(roomId, myId) {
        this.roomId = roomId;
        this.roomKey = await deriveRoomKey(roomId);
        await this.registerPresence(roomId, myId);
        await this.touchRoomMeta(roomId);
    }

    async registerPresence(roomId, myId) {
        const presRef = ref(this.db, `rooms/${roomId}/presence/${myId}`);
        await set(presRef, true);
        onDisconnect(presRef).remove();
        console.log("[room] presencia registrada");
    }

    async touchRoomMeta(roomId) {
        const roundedNow = Math.floor(Date.now() / 300_000) * 300_000;
        const metaRef = ref(this.db, `rooms/${roomId}/meta`);
        const metaSnap = await get(metaRef);

        if (!metaSnap.exists()) {
            await set(metaRef, { date_created: roundedNow, last_use: roundedNow });
        } else {
            await update(metaRef, { last_use: roundedNow });
        }
    }

    async claimHost(roomId, myId) {
        const lockRef = ref(this.db, `rooms/${roomId}/callerClaimed`);
        const [lockSnap, presSnap] = await Promise.all([
            get(lockRef),
            get(ref(this.db, `rooms/${roomId}/presence`)),
        ]);

        const lockedById = lockSnap.val();
        const presence = presSnap.val() || {};
        if (lockedById && !presence[lockedById]) {
            console.log(`[join] lock stale (${lockedById} ya no esta), limpiando sala...`);
            await Promise.all([
                remove(lockRef),
                remove(ref(this.db, `rooms/${roomId}/connections`)),
            ]);
        }

        if (lockedById === myId) {
            onDisconnect(lockRef).remove();
            onDisconnect(ref(this.db, `rooms/${roomId}/connections`)).remove();
            return true;
        }

        console.log("[join] intentando reclamar rol de caller...");
        const tx = await runTransaction(lockRef, current => {
            if (current === null) return myId;
            return;
        });
        console.log("[join] transaccion committed:", tx.committed);

        if (tx.committed) {
            onDisconnect(lockRef).remove();
            onDisconnect(ref(this.db, `rooms/${roomId}/connections`)).remove();
        }

        return tx.committed;
    }

    watchPresenceAdded(roomId, onAdded) {
        return onChildAdded(ref(this.db, `rooms/${roomId}/presence`), snap => onAdded(snap.key));
    }

    watchPresenceRemoved(roomId, onRemoved) {
        return onChildRemoved(ref(this.db, `rooms/${roomId}/presence`), snap => onRemoved(snap.key));
    }

    async sendCandidate(roomId, clientId, payload) {
        const enc = await this.encrypt(payload);
        return push(ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`), enc);
    }

    watchCandidates(roomId, clientId, expectedFrom, onCandidate) {
        return onChildAdded(
            ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`),
            async snap => {
                let data;
                try {
                    data = await this.decrypt(snap.val());
                } catch (e) {
                    console.warn("[ICE] no se pudo descifrar candidato:", e);
                    return;
                }
                if (data.from !== expectedFrom) return;
                onCandidate(data.candidate);
            },
        );
    }

    async clearCandidates(roomId, clientId) {
        return remove(ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`));
    }

    async sendOffer(roomId, clientId, payload) {
        const enc = await this.encrypt(payload);
        return set(ref(this.db, `rooms/${roomId}/connections/${clientId}/offer`), enc);
    }

    watchOffer(roomId, clientId, onOffer) {
        return onValue(ref(this.db, `rooms/${roomId}/connections/${clientId}/offer`), async snap => {
            if (!snap.exists()) return;
            try {
                onOffer(await this.decrypt(snap.val()));
            } catch (e) {
                console.warn("[Firebase] no se pudo descifrar offer:", e);
            }
        });
    }

    async sendAnswer(roomId, clientId, payload) {
        const enc = await this.encrypt(payload);
        return set(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`), enc);
    }

    async clearAnswer(roomId, clientId) {
        return remove(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`));
    }

    watchAnswer(roomId, clientId, onAnswer) {
        return onValue(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`), async snap => {
            if (!snap.exists()) return;
            try {
                onAnswer(await this.decrypt(snap.val()));
            } catch (e) {
                console.warn(`[Firebase] no se pudo descifrar answer de ${clientId}:`, e);
            }
        });
    }

    async leaveRoom(roomId, myId, isHost) {
        if (!roomId) return;

        const deletes = [
            remove(ref(this.db, `rooms/${roomId}/presence/${myId}`)),
        ];

        if (isHost) {
            deletes.push(
                remove(ref(this.db, `rooms/${roomId}/callerClaimed`)),
                remove(ref(this.db, `rooms/${roomId}/connections`)),
            );
        } else {
            deletes.push(remove(ref(this.db, `rooms/${roomId}/connections/${myId}`)));
        }

        await Promise.all(deletes);
    }

    async encrypt(value) {
        this.assertRoomKey();
        return encryptVal(this.roomKey, value);
    }

    async decrypt(value) {
        this.assertRoomKey();
        return decryptVal(this.roomKey, value);
    }

    assertRoomKey() {
        if (!this.roomKey) {
            throw new Error("FirebaseSignaling room key is not initialized");
        }
    }
}
