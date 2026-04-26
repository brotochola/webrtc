/**
 * media.js — módulo de cámara y micrófono colaborativo
 *
 * API pública:
 *   initMedia(pc, containerEl)  — crea la UI e instala el handler ontrack
 *   destroyMedia()              — para tracks, elimina la UI
 *
 * IMPORTANTE: initMedia debe llamarse ANTES de setRemoteDescription (lado B)
 * porque ontrack se dispara durante esa llamada.
 */

let _pc          = null;
let localStream  = null;
let camEnabled   = false;
let micEnabled   = false;

let _wrapper      = null;
let _videoSection = null;
let _localVideo   = null;
let _remoteVideo  = null;
let _btnCam       = null;
let _btnMic       = null;
let _camSelect    = null;   // selector de cámara (aparece tras dar permiso)

let _listeners = [];

// ── Init / Destroy ────────────────────────────────────────────────────────

export function initMedia(pc, containerEl) {
    _pc = pc;

    // ── Toolbar ──────────────────────────────────────────────────────────
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;";

    _btnCam = makeBtn("📷 Cámara");
    _btnMic = makeBtn("🎤 Micrófono");
    on(_btnCam, "click", toggleCam);
    on(_btnMic, "click", toggleMic);
    controls.append(_btnCam, _btnMic);

    // ── Sección de video ─────────────────────────────────────────────────
    _videoSection = document.createElement("div");
    _videoSection.style.cssText = "display:none;margin-bottom:12px;";

    const videosDiv = document.createElement("div");
    videosDiv.style.cssText = "display:flex;gap:8px;";

    const localBox  = makeVideoBox("Tú");
    const remoteBox = makeVideoBox("Remoto");
    _localVideo  = localBox.video;
    _remoteVideo = remoteBox.video;
    _localVideo.muted = true;

    videosDiv.append(localBox.el, remoteBox.el);
    _videoSection.appendChild(videosDiv);

    _wrapper = document.createElement("div");
    _wrapper.append(controls, _videoSection);
    containerEl.appendChild(_wrapper);

    // ── Track remoto ──────────────────────────────────────────────────────
    // ontrack se dispara al negociar transceivers; onunmute indica que
    // el peer realmente está mandando datos. Manejamos ambos casos.
    _pc.ontrack = e => {
        console.log("[media] ontrack:", e.track.kind, "| muted:", e.track.muted, "| streams:", e.streams.length);

        if (_remoteVideo) {
            if (e.streams[0]) {
                _remoteVideo.srcObject = e.streams[0];
            } else {
                // addTransceiver sin stream asociado → construir MediaStream manualmente
                if (!(_remoteVideo.srcObject instanceof MediaStream)) {
                    _remoteVideo.srcObject = new MediaStream();
                }
                _remoteVideo.srcObject.addTrack(e.track);
            }
        }

        const revealVideo = () => {
            if (e.track.kind === "video" && _videoSection) {
                _videoSection.style.display = "";
                console.log("[media] video remoto activo → mostrando sección");
            }
        };

        e.track.onunmute = revealVideo;

        // Algunos browsers ya tienen el track "unmuted" cuando llega ontrack
        // (especialmente en loopback/mismo equipo). Verificar de inmediato.
        if (!e.track.muted) revealVideo();
    };

    // Fallback: cuando el <video> realmente empieza a renderizar frames
    // (más confiable que onunmute cuando el sender activa cámara vía replaceTrack)
    _remoteVideo.addEventListener("playing", () => {
        if (_videoSection) {
            _videoSection.style.display = "";
            console.log("[media] remoteVideo playing → mostrando sección");
        }
    });

    console.log("[media] inicializado, pc.ontrack instalado");
}

export function destroyMedia() {
    stopStream();
    camEnabled = false;
    micEnabled = false;

    _listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    _listeners = [];

    _wrapper?.remove();
    _wrapper = _videoSection = _localVideo = _remoteVideo = null;
    _btnCam = _btnMic = _camSelect = null;
    _pc = null;

    console.log("[media] destruido");
}

// ── Toggles ───────────────────────────────────────────────────────────────

async function toggleCam() {
    const ok = await acquireStream();
    if (!ok) return;

    camEnabled = !camEnabled;
    const track = localStream.getVideoTracks()[0];
    if (track) track.enabled = camEnabled;

    if (_pc) {
        const sender = findSenderByKind("video");
        if (sender) await sender.replaceTrack(camEnabled ? track : null);
    }

    if (_localVideo) _localVideo.srcObject = camEnabled ? localStream : null;
    refreshVideoSectionVisibility();
    updateButtons();
}

async function toggleMic() {
    const ok = await acquireStream();
    if (!ok) return;

    micEnabled = !micEnabled;
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = micEnabled;

    if (_pc) {
        const sender = findSenderByKind("audio");
        if (sender) await sender.replaceTrack(micEnabled ? track : null);
    }

    updateButtons();
}

// ── Selector de cámara ────────────────────────────────────────────────────

async function buildCamSelector() {
    if (!_btnCam || _camSelect) return; // ya existe o UI destruida

    let devices;
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch { return; }

    const videoInputs = devices.filter(d => d.kind === "videoinput");
    if (videoInputs.length < 2) return; // con una sola cámara no hace falta

    _camSelect = document.createElement("select");
    _camSelect.style.cssText = [
        "background:#1e1e1e", "border:1px solid #333", "color:#e0e0e0",
        "border-radius:6px", "padding:5px 8px", "font-size:12px",
        "cursor:pointer", "max-width:160px",
    ].join(";");

    for (const [i, d] of videoInputs.entries()) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Cámara ${i + 1}`;
        // Pre-seleccionar la cámara actualmente en uso
        if (localStream?.getVideoTracks()[0]?.getSettings().deviceId === d.deviceId) {
            opt.selected = true;
        }
        _camSelect.appendChild(opt);
    }

    on(_camSelect, "change", e => switchCamera(e.target.value));

    // Insertar después de los botones
    _btnCam.parentElement.appendChild(_camSelect);
    console.log("[media] selector de cámara añadido:", videoInputs.length, "dispositivos");
}

async function switchCamera(deviceId) {
    if (!localStream) return;
    console.log("[media] cambiando cámara →", deviceId);

    let newTrack;
    try {
        const s = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId } },
            audio: false,
        });
        newTrack = s.getVideoTracks()[0];
    } catch (e) {
        console.error("[media] switchCamera error:", e);
        return;
    }

    // Parar y reemplazar el track viejo en el stream local
    localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
    newTrack.enabled = camEnabled;
    localStream.addTrack(newTrack);

    // Reemplazar en el peer connection (sin renegociación)
    if (_pc && camEnabled) {
        const sender = findSenderByKind("video");
        if (sender) await sender.replaceTrack(newTrack);
    }

    if (_localVideo && camEnabled) _localVideo.srcObject = localStream;
    console.log("[media] cámara cambiada OK");
}

// ── Helpers internos ──────────────────────────────────────────────────────

async function acquireStream() {
    if (localStream) return true;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStream.getTracks().forEach(t => { t.enabled = false; });
        // Mostrar selector de cámara después de obtener permiso (ahora los labels están disponibles)
        await buildCamSelector();
        return true;
    } catch (e) {
        console.warn("[media] getUserMedia error:", e.name, e.message);
        alert(`No se pudo acceder a cámara/micrófono:\n${e.message}`);
        return false;
    }
}

function stopStream() {
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;
}

function findSenderByKind(kind) {
    if (!_pc) return null;
    for (const t of _pc.getTransceivers()) {
        if (t.receiver.track?.kind === kind) return t.sender;
    }
    return null;
}

function refreshVideoSectionVisibility() {
    if (!_videoSection) return;
    const remoteHasVideo = !!_remoteVideo?.srcObject;
    _videoSection.style.display = (camEnabled || remoteHasVideo) ? "" : "none";
}

function updateButtons() {
    if (_btnCam) {
        _btnCam.textContent  = camEnabled ? "📷 Cámara ●" : "📷 Cámara";
        _btnCam.style.background = camEnabled ? "#16a34a" : "#374151";
    }
    if (_btnMic) {
        _btnMic.textContent  = micEnabled ? "🎤 Micrófono ●" : "🎤 Micrófono";
        _btnMic.style.background = micEnabled ? "#16a34a" : "#374151";
    }
}

// ── Constructores DOM ─────────────────────────────────────────────────────

function makeVideoBox(label) {
    const el = document.createElement("div");
    el.style.cssText = [
        "flex:1", "position:relative", "background:#000",
        "border-radius:6px", "border:1px solid #222", "overflow:hidden",
    ].join(";");

    const video = document.createElement("video");
    video.autoplay    = true;
    video.playsInline = true;
    video.style.cssText = "width:100%;display:block;aspect-ratio:4/3;object-fit:cover;";

    const lbl = document.createElement("span");
    lbl.textContent = label;
    lbl.style.cssText = [
        "position:absolute", "bottom:6px", "left:8px",
        "font-size:11px", "color:#aaa",
        "background:rgba(0,0,0,0.55)", "padding:2px 6px", "border-radius:3px",
    ].join(";");

    el.append(video, lbl);
    return { el, video };
}

function makeBtn(text) {
    const btn = document.createElement("button");
    btn.className   = "action secondary";
    btn.textContent = text;
    btn.style.cssText = "font-size:13px;";
    return btn;
}

function on(el, ev, fn) {
    el.addEventListener(ev, fn);
    _listeners.push([el, ev, fn]);
}
