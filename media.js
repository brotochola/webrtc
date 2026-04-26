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
let pipVisible   = false;  // si el recuadro de video local está visible

let _wrapper      = null;
let _videoSection = null;
let _localVideo   = null;
let _remoteVideo  = null;
let _btnCam       = null;
let _btnMic       = null;
let _btnPip       = null;   // botón "ver mi cámara" cuando PiP está oculto
let _pipBox       = null;   // recuadro PiP del video local
let _camSelect    = null;

let _listeners = [];

// ── Init / Destroy ────────────────────────────────────────────────────────

export function initMedia(pc, containerEl) {
    _pc = pc;

    // ── Toolbar de controles ─────────────────────────────────────────────
    const controls = document.createElement("div");
    controls.className = "media-controls";

    _btnCam = makeBtn("📷 Cámara");
    _btnMic = makeBtn("🎤 Micrófono");
    on(_btnCam, "click", toggleCam);
    on(_btnMic, "click", toggleMic);

    _btnPip = makeBtn("👁 Mi cámara");
    _btnPip.style.display = "none";
    on(_btnPip, "click", showPip);

    controls.append(_btnCam, _btnMic, _btnPip);

    // ── Sección de video ─────────────────────────────────────────────────
    _videoSection = document.createElement("div");
    _videoSection.className = "media-video-section";
    _videoSection.style.display = "none";

    // Video remoto (principal, grande)
    const remoteBox = document.createElement("div");
    remoteBox.className = "media-remote-box";

    _remoteVideo = document.createElement("video");
    _remoteVideo.autoplay    = true;
    _remoteVideo.playsInline = true;
    _remoteVideo.className   = "media-remote-video";

    const remoteLbl = makeLbl("Remoto");
    remoteBox.append(_remoteVideo, remoteLbl);

    // Video local (PiP overlay)
    _pipBox = document.createElement("div");
    _pipBox.className = "media-pip";
    _pipBox.style.display = "none";

    _localVideo = document.createElement("video");
    _localVideo.autoplay    = true;
    _localVideo.playsInline = true;
    _localVideo.muted       = true;
    _localVideo.className   = "media-pip-video";

    const pipLbl = makeLbl("Tú");

    const pipCloseBtn = document.createElement("button");
    pipCloseBtn.className   = "media-pip-close";
    pipCloseBtn.title       = "Ocultar mi video";
    pipCloseBtn.textContent = "×";
    on(pipCloseBtn, "click", hidePip);

    _pipBox.append(_localVideo, pipLbl, pipCloseBtn);
    remoteBox.appendChild(_pipBox);

    _videoSection.appendChild(remoteBox);

    _wrapper = document.createElement("div");
    _wrapper.className = "media-wrap";
    _wrapper.append(controls, _videoSection);
    containerEl.appendChild(_wrapper);

    // ── Track remoto ──────────────────────────────────────────────────────
    _pc.ontrack = e => {
        console.log("[media] ontrack:", e.track.kind, "| muted:", e.track.muted);

        if (_remoteVideo) {
            if (e.streams[0]) {
                _remoteVideo.srcObject = e.streams[0];
            } else {
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
        if (!e.track.muted) revealVideo();
    };

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
    pipVisible = false;

    _listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    _listeners = [];

    _wrapper?.remove();
    _wrapper = _videoSection = _localVideo = _remoteVideo = null;
    _pipBox = _btnCam = _btnMic = _btnPip = _camSelect = null;
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

    if (camEnabled) {
        if (_localVideo) _localVideo.srcObject = localStream;
        pipVisible = true;
        if (_pipBox)  _pipBox.style.display = "";
        if (_btnPip)  _btnPip.style.display = "none";
        if (_videoSection) _videoSection.style.display = "";
    } else {
        if (_localVideo) _localVideo.srcObject = null;
        pipVisible = false;
        if (_pipBox)  _pipBox.style.display = "none";
        if (_btnPip)  _btnPip.style.display = "none";
        refreshVideoSectionVisibility();
    }

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

function hidePip() {
    pipVisible = false;
    if (_pipBox) _pipBox.style.display = "none";
    if (_btnPip) _btnPip.style.display = "";
}

function showPip() {
    if (!camEnabled) return;
    pipVisible = true;
    if (_pipBox) _pipBox.style.display = "";
    if (_btnPip) _btnPip.style.display = "none";
}

// ── Selector de cámara ────────────────────────────────────────────────────

async function buildCamSelector() {
    if (!_btnCam || _camSelect) return;

    let devices;
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch { return; }

    const videoInputs = devices.filter(d => d.kind === "videoinput");
    if (videoInputs.length < 2) return;

    _camSelect = document.createElement("select");
    _camSelect.className = "media-cam-select";

    for (const [i, d] of videoInputs.entries()) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Cámara ${i + 1}`;
        if (localStream?.getVideoTracks()[0]?.getSettings().deviceId === d.deviceId) {
            opt.selected = true;
        }
        _camSelect.appendChild(opt);
    }

    on(_camSelect, "change", e => switchCamera(e.target.value));
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

    localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
    newTrack.enabled = camEnabled;
    localStream.addTrack(newTrack);

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
        _btnCam.textContent = camEnabled ? "📷 Cámara ●" : "📷 Cámara";
        _btnCam.classList.toggle("active", camEnabled);
    }
    if (_btnMic) {
        _btnMic.textContent = micEnabled ? "🎤 Mic ●" : "🎤 Micrófono";
        _btnMic.classList.toggle("active", micEnabled);
    }
    if (_btnPip) {
        _btnPip.style.display = (camEnabled && !pipVisible) ? "" : "none";
    }
}

// ── Constructores DOM ─────────────────────────────────────────────────────

function makeBtn(text) {
    const btn = document.createElement("button");
    btn.className   = "action secondary";
    btn.textContent = text;
    return btn;
}

function makeLbl(text) {
    const lbl = document.createElement("span");
    lbl.className   = "media-label";
    lbl.textContent = text;
    return lbl;
}

function on(el, ev, fn) {
    el.addEventListener(ev, fn);
    _listeners.push([el, ev, fn]);
}
