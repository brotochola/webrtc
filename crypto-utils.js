/**
 * Derives an AES-GCM-256 key from a room name using PBKDF2.
 * Both peers derive the same key independently as long as they type the same room name,
 * so signaling data (offer/answer/ICE) stored in Firebase is opaque to Firebase/Google.
 */

const SALT       = new TextEncoder().encode("webrtc-signal-salt-v1");
const ITERATIONS = 100_000;

export async function deriveRoomKey(roomName) {
    const raw = new TextEncoder().encode(roomName);
    const keyMaterial = await crypto.subtle.importKey(
        "raw", raw, "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: SALT, iterations: ITERATIONS, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypts any JSON-serialisable value.
 * Returns a plain object { iv, ct } (both base64 strings) safe to store in Firebase.
 */
export async function encryptVal(key, value) {
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const ct      = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return {
        iv: btoa(String.fromCharCode(...iv)),
        ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    };
}

/**
 * Decrypts a { iv, ct } object produced by encryptVal.
 */
export async function decryptVal(key, { iv, ct }) {
    const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const ctBytes = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
    const plain   = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ctBytes);
    return JSON.parse(new TextDecoder().decode(plain));
}
