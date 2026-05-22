// ── Speaker colour palette ───────────────────────────────────────────────────
const COLORS = [
    { accent: "#3b82f6", bg: "#0f2040" },
    { accent: "#10b981", bg: "#0a2e1e" },
    { accent: "#f59e0b", bg: "#2e1f0a" },
    { accent: "#8b5cf6", bg: "#1e0e3d" },
    { accent: "#ef4444", bg: "#2e0e0e" },
    { accent: "#06b6d4", bg: "#0a2832" },
    { accent: "#ec4899", bg: "#2e0e22" },
    { accent: "#84cc16", bg: "#162610" },
];

// ── Application state ────────────────────────────────────────────────────────
const state = {
    ws: null,
    audioContext: null,
    mediaStream: null,
    workletNode: null,
    connected: false,
    capturing: false,
    focusedSpeaker: null,
    /** @type {Map<string, number>} speakerId → colour index */
    speakerColorIndex: new Map(),
    /** @type {HTMLElement|null} current partial-segment DOM node */
    partialEl: null,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $status       = document.getElementById("status");
const $statusText   = document.getElementById("status-text");
const $btnStart     = document.getElementById("btn-start");
const $btnStop      = document.getElementById("btn-stop");
const $btnClearFocus= document.getElementById("btn-clear-focus");
const $btnClearLog  = document.getElementById("btn-clear-transcript");
const $speakerList  = document.getElementById("speaker-list");
const $noSpeakers   = document.getElementById("no-speakers");
const $transcript   = document.getElementById("transcript");
const $noTranscript = document.getElementById("no-transcript");
const $focusLabel      = document.getElementById("focus-label");
const $preFocusSection = document.getElementById("pre-focus-section");
const $preFocusSelect  = document.getElementById("pre-focus-select");

// ── Utilities ────────────────────────────────────────────────────────────────

function speakerColor(id) {
    if (!state.speakerColorIndex.has(id)) {
        state.speakerColorIndex.set(id, state.speakerColorIndex.size % COLORS.length);
    }
    return COLORS[state.speakerColorIndex.get(id)];
}

function setStatus(text, type = "idle") {
    $statusText.textContent = text;
    $status.className = `status ${type}`;
}

function sendWS(payload) {
    if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(payload));
    }
}

// ── Pre-focus (enrolled speaker selector) ────────────────────────────────────

async function loadPreFocusSpeakers() {
    try {
        const res  = await fetch("/api/enrolled-speakers");
        const data = await res.json();
        const names = data.speakers ?? [];

        // Rebuild options (keep blank "no focus" first)
        $preFocusSelect.innerHTML = `<option value="">— no pre-set focus —</option>`;
        names.forEach((name) => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            $preFocusSelect.appendChild(opt);
        });

        $preFocusSection.style.display = names.length > 0 ? "" : "none";
    } catch {
        $preFocusSection.style.display = "none";
    }
}

// ── Session lifecycle ────────────────────────────────────────────────────────

async function startSession() {
    $btnStart.disabled = true;
    setStatus("Requesting microphone…", "connecting");

    try {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
        setStatus(`Mic error: ${err.message}`, "error");
        $btnStart.disabled = false;
        return;
    }

    setStatus("Connecting…", "connecting");

    const proto = location.protocol === "https:" ? "wss" : "ws";
    state.ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws.binaryType = "arraybuffer";

    state.ws.onmessage = (ev) => handleServerMessage(JSON.parse(ev.data));
    state.ws.onerror   = () => { setStatus("Connection error", "error"); stopSession(); };
    state.ws.onclose   = () => { if (state.connected) stopSession(false); };
}

async function startAudioCapture() {
    state.capturing = true;  // set early — guard against re-entry before first await

    try {
        state.audioContext = new AudioContext({ sampleRate: 16000 });
    } catch {
        state.audioContext = new AudioContext();
    }

    await state.audioContext.resume();
    await state.audioContext.audioWorklet.addModule("/static/audio-processor.js");

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.workletNode = new AudioWorkletNode(state.audioContext, "audio-processor", {
        processorOptions: { targetSampleRate: 16000 },
    });

    state.workletNode.port.onmessage = (ev) => {
        if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(ev.data);
        }
    };

    source.connect(state.workletNode);
}

function stopSession(closeWS = true) {
    state.connected = false;
    state.capturing = false;

    state.workletNode?.disconnect();
    state.workletNode = null;

    state.audioContext?.close();
    state.audioContext = null;

    state.mediaStream?.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;

    if (closeWS) {
        state.ws?.close();
        state.ws = null;
    }

    $btnStart.disabled = false;
    $btnStop.disabled  = true;
    setStatus("Stopped", "idle");
    loadPreFocusSpeakers();
}

// ── Focus control ────────────────────────────────────────────────────────────

function setFocus(speakerId) {
    if (state.focusedSpeaker === speakerId) {
        clearFocus();
        return;
    }
    state.focusedSpeaker = speakerId;
    sendWS({ type: "set_focus", speaker_id: speakerId });
    refreshSpeakerCards();
    refreshTranscriptDim();
    $btnClearFocus.style.display = "inline-flex";
    $focusLabel.textContent = `Focused: ${speakerId}`;
    $focusLabel.style.display = "inline";
}

function clearFocus() {
    state.focusedSpeaker = null;
    sendWS({ type: "set_focus", speaker_id: null });
    refreshSpeakerCards();
    refreshTranscriptDim();
    $btnClearFocus.style.display = "none";
    $focusLabel.style.display    = "none";
}

// ── Server message handler ───────────────────────────────────────────────────

function handleServerMessage(msg) {
    switch (msg.type) {
        case "connected":
        case "session_started":
            state.connected = true;
            setStatus("Live", "connected");
            $btnStop.disabled = false;
            $preFocusSection.style.display = "none";
            if (!state.capturing) startAudioCapture().catch(err => {
                console.error("Audio capture failed:", err);
                setStatus("Mic error: " + err.message, "error");
            });
            // Apply pre-set focus chosen before session started
            {
                const preSelected = $preFocusSelect.value;
                if (preSelected) setFocus(preSelected);
            }
            break;

        case "segment":
            removePartial();
            appendSegment(msg.speaker, msg.text, false);
            if (msg.speakers?.length) syncSpeakers(msg.speakers);
            break;

        case "partial":
            updatePartial(msg.speaker, msg.text);
            break;

        case "end_of_turn":
            removePartial();
            break;

        case "focus_updated":
            console.log("[focus_updated]", msg);
            state.focusedSpeaker = msg.focused_speaker ?? null;
            refreshSpeakerCards();
            refreshTranscriptDim();
            if (state.focusedSpeaker) {
                $btnClearFocus.style.display = "inline-flex";
                $focusLabel.textContent = `Focused: ${state.focusedSpeaker}`;
                $focusLabel.style.display = "inline";
            } else {
                $btnClearFocus.style.display = "none";
                $focusLabel.style.display    = "none";
            }
            break;

        case "error":
            setStatus(`Error: ${msg.message}`, "error");
            console.error("[server]", msg.message);
            break;

        case "ping":
            sendWS({ type: "pong" });
            break;
    }
}

// ── Transcript helpers ───────────────────────────────────────────────────────

function appendSegment(speaker, text, isPartial) {
    if (!text?.trim()) return;

    $noTranscript.style.display = "none";

    const color    = speaker ? speakerColor(speaker) : null;
    const dimmed   = state.focusedSpeaker && state.focusedSpeaker !== speaker;
    const entry    = document.createElement("div");

    entry.className = ["transcript-entry", isPartial && "partial", dimmed && "dimmed"]
        .filter(Boolean).join(" ");
    entry.dataset.speaker = speaker ?? "";

    if (speaker && color) {
        const lbl = document.createElement("span");
        lbl.className = "speaker-label";
        lbl.textContent = speaker;
        lbl.style.cssText = `background:${color.bg};color:${color.accent};border-color:${color.accent}`;
        lbl.title = "Click to focus on this speaker";
        lbl.addEventListener("click", () => setFocus(speaker));
        entry.appendChild(lbl);
    }

    const txt = document.createElement("span");
    txt.className = "entry-text";
    txt.textContent = text;
    entry.appendChild(txt);

    $transcript.appendChild(entry);
    $transcript.scrollTop = $transcript.scrollHeight;
    return entry;
}

function updatePartial(speaker, text) {
    removePartial();
    if (!text?.trim()) return;
    state.partialEl = appendSegment(speaker, text, true);
}

function removePartial() {
    state.partialEl?.remove();
    state.partialEl = null;
}

function refreshTranscriptDim() {
    $transcript.querySelectorAll(".transcript-entry").forEach((el) => {
        const spk = el.dataset.speaker;
        el.classList.toggle("dimmed", Boolean(state.focusedSpeaker && state.focusedSpeaker !== spk));
    });
}

// ── Speaker sidebar helpers ──────────────────────────────────────────────────

function syncSpeakers(ids) {
    ids.forEach((id) => {
        if (!$speakerList.querySelector(`[data-id="${id}"]`)) {
            addSpeakerCard(id);
        }
    });
    $noSpeakers.style.display = "none";
}

function addSpeakerCard(id) {
    const color = speakerColor(id);
    const card  = document.createElement("div");
    card.className = "speaker-card";
    card.dataset.id = id;
    card.style.setProperty("--card-accent", color.accent);
    card.style.setProperty("--card-bg", color.bg);

    card.innerHTML = `
        <div class="speaker-avatar"
             style="background:${color.bg};border-color:${color.accent};color:${color.accent}">
            ${id}
        </div>
        <div class="speaker-info">
            <div class="speaker-name">${id}</div>
            <div class="speaker-status">Detected</div>
        </div>
        <div class="speaker-focus-icon" title="Focus on ${id}">🎯</div>
    `;

    card.addEventListener("click", () => setFocus(id));
    $speakerList.appendChild(card);
}

function refreshSpeakerCards() {
    $speakerList.querySelectorAll(".speaker-card").forEach((card) => {
        const id      = card.dataset.id;
        const focused = state.focusedSpeaker === id;
        const dimmed  = state.focusedSpeaker && !focused;
        card.classList.toggle("focused",      focused);
        card.classList.toggle("dimmed-card",  dimmed);

        const statusEl = card.querySelector(".speaker-status");
        if (statusEl) {
            statusEl.textContent = focused ? "Focused ✓" : "Detected";
        }
    });
}

// ── Button listeners ─────────────────────────────────────────────────────────

$btnStart.addEventListener("click", startSession);
$btnStop.addEventListener("click", () => stopSession());
$btnClearFocus.addEventListener("click", clearFocus);
$btnClearLog.addEventListener("click", () => {
    $transcript.innerHTML = "";
    $transcript.appendChild($noTranscript);
    $noTranscript.style.display = "";
});

// ── Tab bar ──────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const target = tab.dataset.tab;
        document.getElementById("tab-live").style.display   = target === "live"   ? "" : "none";
        document.getElementById("tab-enroll").style.display = target === "enroll" ? "" : "none";
        if (target === "enroll") loadEnrolledSpeakers();
        if (target === "live" && !state.connected) loadPreFocusSpeakers();
    });
});

// Load enrolled speakers for the pre-focus selector on initial page load
loadPreFocusSpeakers();

// ── Enrollment state & refs ──────────────────────────────────────────────────

const enrollState = {
    ws:          null,
    audioContext: null,
    mediaStream:  null,
    workletNode:  null,
};

const $enrollName     = document.getElementById("enroll-name");
const $btnEnrollStart = document.getElementById("btn-enroll-start");
const $btnEnrollStop  = document.getElementById("btn-enroll-stop");
const $enrollStatus   = document.getElementById("enroll-status");
const $enrolledList   = document.getElementById("enrolled-list");
const $noEnrolled     = document.getElementById("no-enrolled");

function setEnrollStatus(msg, type = "") {
    $enrollStatus.textContent = msg;
    $enrollStatus.className = `enroll-status ${type}`;
}

// ── Enrolled speakers list ───────────────────────────────────────────────────

async function loadEnrolledSpeakers() {
    try {
        const res  = await fetch("/api/enrolled-speakers");
        const data = await res.json();
        renderEnrolledSpeakers(data.speakers ?? []);
    } catch {
        // silently fail — server may not be running yet
    }
}

function renderEnrolledSpeakers(names) {
    $enrolledList.querySelectorAll(".enrolled-item").forEach((el) => el.remove());
    $noEnrolled.style.display = names.length === 0 ? "" : "none";
    names.forEach((name) => {
        const initials = name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
        const item = document.createElement("div");
        item.className = "enrolled-item";
        item.dataset.name = name;
        item.innerHTML = `
            <div class="enrolled-avatar">${initials}</div>
            <div class="enrolled-name">${name}</div>
            <button class="btn-icon enrolled-delete" title="Remove ${name}">✕</button>
        `;
        item.querySelector(".enrolled-delete").addEventListener("click", () => deleteEnrolledSpeaker(name));
        $enrolledList.appendChild(item);
    });
}

async function deleteEnrolledSpeaker(name) {
    try {
        await fetch(`/api/enrolled-speakers/${encodeURIComponent(name)}`, { method: "DELETE" });
        await loadEnrolledSpeakers();
    } catch {
        // silently fail
    }
}

// ── Enrollment recording ─────────────────────────────────────────────────────

async function startEnrollRecording() {
    const name = $enrollName.value.trim();
    if (!name) {
        setEnrollStatus("Enter a speaker name first.", "error");
        return;
    }

    $btnEnrollStart.disabled = true;
    setEnrollStatus("Requesting microphone…", "info");

    try {
        enrollState.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
        setEnrollStatus(`Mic error: ${err.message}`, "error");
        $btnEnrollStart.disabled = false;
        return;
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    enrollState.ws = new WebSocket(`${proto}://${location.host}/ws/enroll?name=${encodeURIComponent(name)}`);
    enrollState.ws.binaryType = "arraybuffer";

    enrollState.ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "recording") {
            setEnrollStatus("Recording… speak clearly for at least 5 seconds.", "info");
            $btnEnrollStop.disabled = false;
            await startEnrollAudio();
        } else if (msg.type === "enrolled") {
            setEnrollStatus(`"${msg.name}" enrolled successfully.`, "success");
            $btnEnrollStop.disabled = true;
            $btnEnrollStart.disabled = false;
            stopEnrollAudio();
            $enrollName.value = "";
            await loadEnrolledSpeakers();
        } else if (msg.type === "error") {
            setEnrollStatus(`Error: ${msg.message}`, "error");
            $btnEnrollStop.disabled = true;
            $btnEnrollStart.disabled = false;
            stopEnrollAudio();
        }
    };

    enrollState.ws.onerror = () => {
        setEnrollStatus("Connection error.", "error");
        $btnEnrollStart.disabled = false;
        $btnEnrollStop.disabled = true;
        stopEnrollAudio();
    };

    enrollState.ws.onclose = () => stopEnrollAudio();
}

async function startEnrollAudio() {
    try {
        enrollState.audioContext = new AudioContext({ sampleRate: 16000 });
    } catch {
        enrollState.audioContext = new AudioContext();
    }

    await enrollState.audioContext.audioWorklet.addModule("/static/audio-processor.js");

    const source = enrollState.audioContext.createMediaStreamSource(enrollState.mediaStream);
    enrollState.workletNode = new AudioWorkletNode(enrollState.audioContext, "audio-processor", {
        processorOptions: { targetSampleRate: 16000 },
    });

    enrollState.workletNode.port.onmessage = (ev) => {
        if (enrollState.ws?.readyState === WebSocket.OPEN) {
            enrollState.ws.send(ev.data);
        }
    };

    source.connect(enrollState.workletNode);
}

function stopEnrollAudio() {
    enrollState.workletNode?.disconnect();
    enrollState.workletNode = null;
    enrollState.audioContext?.close();
    enrollState.audioContext = null;
    enrollState.mediaStream?.getTracks().forEach((t) => t.stop());
    enrollState.mediaStream = null;
}

function stopEnrollRecording() {
    $btnEnrollStop.disabled = true;
    $btnEnrollStart.disabled = true;
    setEnrollStatus("Processing…", "info");
    if (enrollState.ws?.readyState === WebSocket.OPEN) {
        enrollState.ws.send(JSON.stringify({ type: "stop" }));
    }
}

$btnEnrollStart.addEventListener("click", startEnrollRecording);
$btnEnrollStop.addEventListener("click", stopEnrollRecording);
