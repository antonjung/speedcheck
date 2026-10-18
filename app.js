"use strict";

// ---------- Config ----------

const BUILD_VERSION = "1.0.24"; // kept in sync with VERSION / CACHE_NAME by deploy.sh on every deploy
const STORAGE_KEY = "speed-guard-settings";
const MPS_TO_MPH = 2.2369362920544;
const GPS_STALE_MS = 6000; // no fresh fix for this long -> show as stale
const ACCEL_WINDOW_MS = 3000; // history span used to measure acceleration
const SAMPLE_MS = 250;
const MIN_PROJECTION_SPAN_MS = 1000; // need at least this much history to trust an acceleration figure
const MIN_ACCEL_MPH_PER_S = 0.3; // ignore smaller "acceleration" as GPS noise
const MAX_PROJECTION_MPH = 10; // never project further ahead than this
const MIN_TONE_HZ = 500;
const MAX_TONE_HZ = 2500;
const VOICE_SPEEDS = [20, 30, 40, 50, 60, 70];
const VOICE_DROP_HYSTERESIS_MPH = 1; // must fall this far below a speed before the advice is given
const MAX_RECORDING_MS = 10000;

const DEFAULT_SETTINGS = {
  soundAlerts: true,
  tonePitch: 1200, // Hz, fundamental of the exceed-limit tone - user-adjustable in Settings
  wakeLock: true,
  speedLimit: null, // number, mph
  lookaheadSec: 3, // how far ahead to estimate speed, to offset GPS lag - user-adjustable in Settings
  autoMode: false, // voice mode: no limit buttons, spoken warning/advice at each of VOICE_SPEEDS
  testMode: false, // drive speed manually instead of via GPS, for exercising warnings
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = loadSettings();
// Migrate pitches saved under the old, much lower range.
if (settings.tonePitch < MIN_TONE_HZ) settings.tonePitch = DEFAULT_SETTINGS.tonePitch;

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ---------- DOM ----------

const buildVersionEl = document.getElementById("buildVersion");
buildVersionEl.textContent = `build ${BUILD_VERSION}`;

const mainView = document.getElementById("mainView");
const gpsInfo = document.getElementById("gpsInfo");
const stopBtn = document.getElementById("stopBtn");
const settingsBtn = document.getElementById("settingsBtn");

const statusPanel = document.getElementById("statusPanel");
const speedValueEl = document.getElementById("speedValue");
const statusMessageEl = document.getElementById("statusMessage");

const speedSigns = document.getElementById("speedSigns");

const testControls = document.getElementById("testControls");
const actualSpeedEl = document.getElementById("actualSpeed");
const testSpeedDown = document.getElementById("testSpeedDown");
const testSpeedUp = document.getElementById("testSpeedUp");
const testPresetUnder = document.getElementById("testPresetUnder");
const testPresetAt = document.getElementById("testPresetAt");
const testPresetOver = document.getElementById("testPresetOver");

const settingsPanel = document.getElementById("settingsPanel");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const setSoundAlerts = document.getElementById("setSoundAlerts");
const setTonePitch = document.getElementById("setTonePitch");
const valTonePitch = document.getElementById("valTonePitch");
const setLookahead = document.getElementById("setLookahead");
const valLookahead = document.getElementById("valLookahead");
const setWakeLock = document.getElementById("setWakeLock");
const setTestMode = document.getElementById("setTestMode");
const setAutoMode = document.getElementById("setAutoMode");
const voiceRecorder = document.getElementById("voiceRecorder");
const voiceRows = document.getElementById("voiceRows");
const manualEntry = document.querySelector(".manual-entry");

// ---------- State ----------

let watchId = null;
let lastPosition = null; // { latitude, longitude, timestamp } for haversine fallback
let lastFixAt = 0;
let hasSpeedFix = false; // never assert "within limit" off a speed we don't actually have
let displaySpeedMps = 0; // smoothed, as measured (lags real speed)
let speedHistory = []; // { t, mph } samples from the last ACCEL_WINDOW_MS, oldest first
let currentStatus = "no-fix"; // 'no-fix' | 'no-limit' | 'ok' | 'exceeding'
let wakeLockSentinel = null;

let audioCtx = null;

// ---------- Unit helpers (mph throughout) ----------

function mpsToMph(mps) {
  return mps * MPS_TO_MPH;
}

function mphToMps(mph) {
  return mph / MPS_TO_MPH;
}

// ---------- Geodesy fallback (when coords.speed is unavailable) ----------

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Rendering ----------

// The measured speed trails real speed by a few seconds, so the speed we
// report is an estimate of where it will be settings.lookaheadSec from now: measured
// speed plus current acceleration x lookahead. Only acceleration counts -
// steady or falling speed is reported as measured, so 39 in a 40 never alerts
// on its own and slowing down clears the alert at the plain limit.
function sampleSpeed() {
  const now = Date.now();
  speedHistory.push({ t: now, mph: mpsToMph(displaySpeedMps) });
  while (speedHistory.length > 1 && speedHistory[0].t < now - ACCEL_WINDOW_MS) {
    speedHistory.shift();
  }
}

function estimatedMph() {
  const actual = mpsToMph(displaySpeedMps);
  if (speedHistory.length < 2) return actual;
  const first = speedHistory[0];
  const last = speedHistory[speedHistory.length - 1];
  const spanMs = last.t - first.t;
  if (spanMs < MIN_PROJECTION_SPAN_MS) return actual;
  const accel = (last.mph - first.mph) / (spanMs / 1000); // mph per second
  if (accel < MIN_ACCEL_MPH_PER_S) return actual;
  return actual + Math.min(accel * settings.lookaheadSec, MAX_PROJECTION_MPH);
}

function renderSpeed() {
  speedValueEl.textContent = Math.round(estimatedMph()).toString();
  actualSpeedEl.hidden = !settings.testMode;
  actualSpeedEl.textContent = `actual ${Math.round(mpsToMph(displaySpeedMps))}`;
}

function renderLimit() {
  const noLimit = settings.speedLimit == null;
  testPresetUnder.disabled = noLimit;
  testPresetAt.disabled = noLimit;
  testPresetOver.disabled = noLimit;
  for (const btn of speedSigns.querySelectorAll(".speed-sign")) {
    btn.dataset.active = String(!noLimit && parseInt(btn.dataset.limit, 10) === settings.speedLimit);
  }
}

function renderGpsInfo(accuracyM) {
  if (accuracyM == null) {
    gpsInfo.textContent = "GPS —";
  } else {
    gpsInfo.textContent = `GPS ±${Math.round(accuracyM)}m`;
  }
}

function renderStatusMessage() {
  switch (currentStatus) {
    case "no-fix":
      statusMessageEl.textContent = "Waiting for GPS…";
      break;
    case "no-limit":
      statusMessageEl.textContent = "";
      break;
    case "ok":
      statusMessageEl.textContent = "Within limit.";
      break;
    case "exceeding":
      statusMessageEl.textContent = "Over the limit!";
      break;
  }
}

// ---------- Warning engine ----------

function evaluateStatus() {
  if (!hasSpeedFix) return "no-fix";
  if (settings.autoMode || settings.speedLimit == null) return "no-limit";
  return estimatedMph() > settings.speedLimit ? "exceeding" : "ok";
}

function updateStatus() {
  updateVoiceAlerts();
  const next = evaluateStatus();
  if (next !== currentStatus) {
    const prev = currentStatus;
    currentStatus = next;
    statusPanel.dataset.status = currentStatus;
    mainView.dataset.status = currentStatus;
    renderStatusMessage();
    onStatusTransition(prev, next);
  }
}

function onStatusTransition(prev, next) {
  if (next === "exceeding") {
    startExceedTone();
  } else {
    stopExceedTone();
  }
}

// ---------- Audio: exceed-limit alert ----------
//
// A single plain sine tone that plays continuously for as long as the
// current speed is over the limit, and stops the moment it drops back
// to or below it.

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state !== "running") {
    // "interrupted" (iOS) and "suspended" both need a resume().
    const p = audioCtx.resume();
    if (p && p.catch) p.catch(() => {});
    // A silent buffer played inside a gesture fully unlocks iOS Web Audio.
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, 22050);
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (err) {
      /* ignore */
    }
  }
  return audioCtx;
}

let exceedToneNode = null; // { osc, gain }

function startExceedTone() {
  if (exceedToneNode || !settings.soundAlerts) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const fundamental = settings.tonePitch || DEFAULT_SETTINGS.tonePitch;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = fundamental;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  exceedToneNode = { osc, gain };
}

function stopExceedTone() {
  if (!exceedToneNode) return;
  const ctx = audioCtx;
  const now = ctx ? ctx.currentTime : 0;
  const { osc, gain } = exceedToneNode;
  try {
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
    osc.stop(now + 0.15);
  } catch (err) {
    /* already stopped */
  }
  exceedToneNode = null;
}

// Short preview beep for auditioning a pitch in Settings, distinct from the
// sustained alarm so it doesn't linger.
function previewTone() {
  if (!settings.soundAlerts) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const fundamental = settings.tonePitch || DEFAULT_SETTINGS.tonePitch;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = fundamental;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.35, now + 0.02);
  gain.gain.setValueAtTime(0.35, now + 0.3);
  gain.gain.linearRampToValueAtTime(0.0001, now + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.42);
}

// ---------- Voice mode: spoken warning / advice per speed ----------
//
// Recordings live in IndexedDB (blobs are too big for localStorage). Each
// speed has a "warning" (played once when speed reaches it) and an "advice"
// (played when speed falls back below it). Unrecorded ones fall back to the
// device's speech synthesis.

const DB_NAME = "speed-guard-voice";
const DB_STORE = "clips";
const clipCache = new Map(); // key -> Blob | null

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

function clipKey(kind, speed) {
  return `${kind}-${speed}`;
}

async function loadClips() {
  try {
    for (const speed of VOICE_SPEEDS) {
      for (const kind of ["warning", "advice"]) {
        const blob = await dbOp("readonly", (st) => st.get(clipKey(kind, speed)));
        clipCache.set(clipKey(kind, speed), blob || null);
      }
    }
  } catch (err) {
    /* IndexedDB unavailable: everything falls back to speech */
  }
}

async function saveClip(kind, speed, blob) {
  clipCache.set(clipKey(kind, speed), blob);
  try {
    await dbOp("readwrite", (st) => st.put(blob, clipKey(kind, speed)));
  } catch (err) {
    /* kept in memory for this session */
  }
}

async function deleteClip(kind, speed) {
  clipCache.set(clipKey(kind, speed), null);
  try {
    await dbOp("readwrite", (st) => st.delete(clipKey(kind, speed)));
  } catch (err) {
    /* ignore */
  }
}

function fallbackText(kind, speed) {
  return kind === "warning"
    ? `Warning. ${speed} miles per hour.`
    : `You are now below ${speed} miles per hour.`;
}

let voiceSource = null;

function stopVoice() {
  if (voiceSource) {
    try {
      voiceSource.stop();
    } catch (err) {
      /* already stopped */
    }
    voiceSource = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

async function playVoice(kind, speed) {
  stopVoice();
  const blob = clipCache.get(clipKey(kind, speed));
  const ctx = blob ? ensureAudioCtx() : null;
  if (blob && ctx) {
    try {
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      voiceSource = src;
      return;
    } catch (err) {
      /* undecodable clip: fall through to speech */
    }
  }
  if ("speechSynthesis" in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(fallbackText(kind, speed)));
  }
}

const crossedSpeeds = new Set();

function resetVoiceState() {
  crossedSpeeds.clear();
  stopVoice();
}

function updateVoiceAlerts() {
  if (!settings.autoMode || !settings.soundAlerts || !hasSpeedFix) return;
  const mph = estimatedMph();
  let warn = null;
  let advise = null;
  for (const speed of VOICE_SPEEDS) {
    const crossed = crossedSpeeds.has(speed);
    if (!crossed && mph >= speed) {
      crossedSpeeds.add(speed);
      warn = speed; // keeps the highest newly reached
    } else if (crossed && mph < speed - VOICE_DROP_HYSTERESIS_MPH) {
      crossedSpeeds.delete(speed);
      if (advise == null) advise = speed; // keeps the lowest newly dropped below
    }
  }
  if (warn != null) playVoice("warning", warn);
  else if (advise != null) playVoice("advice", advise);
}

let recorder = null; // { kind, speed, mr, timer }

async function toggleRecording(kind, speed) {
  if (recorder) {
    recorder.mr.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert("Recording isn't supported in this browser.");
    return;
  }
  stopVoice();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access was denied.");
    return;
  }
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    clearTimeout(recorder.timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    if (chunks.length) await saveClip(kind, speed, new Blob(chunks, { type: mr.mimeType }));
    renderVoiceRows();
  };
  recorder = { kind, speed, mr, timer: setTimeout(() => mr.stop(), MAX_RECORDING_MS) };
  mr.start();
  renderVoiceRows();
}

function voiceButton(text, className, onClick, disabled) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  btn.disabled = disabled;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderVoiceRows() {
  voiceRows.textContent = "";
  for (const speed of VOICE_SPEEDS) {
    for (const kind of ["warning", "advice"]) {
      const row = document.createElement("div");
      row.className = "voice-row";
      const label = document.createElement("span");
      label.className = "voice-speed";
      label.textContent = kind === "warning" ? String(speed) : "";
      const kindEl = document.createElement("span");
      kindEl.className = "voice-kind";
      kindEl.textContent = kind === "warning" ? "Warning" : "Advice";
      row.append(label, kindEl);

      const isRecording = !!recorder && recorder.kind === kind && recorder.speed === speed;
      row.append(
        voiceButton(isRecording ? "Stop" : "Record", "btn small" + (isRecording ? " recording" : ""), () => toggleRecording(kind, speed), !!recorder && !isRecording),
        voiceButton("Play", "btn small", () => {
          ensureAudioCtx();
          playVoice(kind, speed);
        }, !!recorder)
      );
      if (clipCache.get(clipKey(kind, speed))) {
        row.append(
          voiceButton("Clear", "btn small", async () => {
            await deleteClip(kind, speed);
            renderVoiceRows();
          }, !!recorder)
        );
      } else {
        const has = document.createElement("span");
        has.className = "voice-has";
        has.textContent = "default voice";
        row.append(has);
      }
      voiceRows.append(row);
    }
  }
}

function applyAutoModeUI() {
  manualEntry.hidden = settings.autoMode;
  stopBtn.hidden = settings.autoMode;
  voiceRecorder.hidden = !settings.autoMode;
}

// ---------- Geolocation / speed tracking ----------

function onPosition(pos) {
  const { latitude, longitude, speed, accuracy } = pos.coords;
  const timestamp = pos.timestamp;
  lastFixAt = Date.now();

  let speedMps = null;
  if (typeof speed === "number" && !Number.isNaN(speed) && speed >= 0) {
    speedMps = speed;
  } else if (lastPosition) {
    const dt = (timestamp - lastPosition.timestamp) / 1000;
    if (dt > 0.4) {
      const dist = haversineDistanceMeters(lastPosition.latitude, lastPosition.longitude, latitude, longitude);
      speedMps = dist / dt;
    }
  }
  lastPosition = { latitude, longitude, timestamp };

  if (speedMps != null) {
    // Exponential smoothing to tame GPS jitter, snap to 0 when basically stopped.
    if (speedMps < 0.4) speedMps = 0;
    displaySpeedMps = displaySpeedMps * 0.55 + speedMps * 0.45;
    hasSpeedFix = true;
    renderSpeed();
    updateStatus();
  }

  renderGpsInfo(accuracy);
}

function onPositionError(err) {
  gpsInfo.textContent = err && err.code === 1 ? "GPS — blocked" : "GPS — no fix";
  hasSpeedFix = false;
  updateStatus();
  statusMessageEl.textContent = describeGeoError(err);
}

function startTracking() {
  if (settings.testMode) {
    startTestTracking();
    return;
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000,
  });
  requestWakeLock();
}

function startTestTracking() {
  gpsInfo.textContent = "TEST MODE";
  gpsInfo.classList.add("test-mode");
  hasSpeedFix = true;
  renderSpeed();
  updateStatus();
  requestWakeLock();
}

// Sample at a steady rate so a held speed ages out of the acceleration
// estimate, and re-evaluate between GPS fixes.
setInterval(() => {
  if (!hasSpeedFix) {
    speedHistory.length = 0;
    return;
  }
  sampleSpeed();
  renderSpeed();
  updateStatus();
}, SAMPLE_MS);

setInterval(() => {
  if (watchId != null && lastFixAt && Date.now() - lastFixAt > GPS_STALE_MS) {
    gpsInfo.textContent = "GPS — no fix";
    if (hasSpeedFix) {
      // Stop alerting off a speed reading that may now be seconds out of date.
      hasSpeedFix = false;
      updateStatus();
    }
  }
}, 2000);

// ---------- Wake Lock ----------

async function requestWakeLock() {
  if (!settings.wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
  } catch (err) {
    wakeLockSentinel = null;
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

document.addEventListener("visibilitychange", () => {
  // Re-acquire whenever the app comes back on screen, whether tracking is
  // real GPS or Test mode - the sentinel itself is released by the browser
  // whenever the tab goes out of view.
  if (document.visibilityState === "visible" && settings.wakeLock) {
    requestWakeLock();
  }
});

// ---------- Speed limit setting ----------

function setSpeedLimit(value) {
  settings.speedLimit = value;
  saveSettings();
  renderLimit();
  updateStatus();
}

speedSigns.addEventListener("click", (e) => {
  const btn = e.target.closest(".speed-sign");
  if (!btn) return;
  ensureAudioCtx(); // reliable audio-unlock gesture - there's no Start button to do this anymore
  setSpeedLimit(parseInt(btn.dataset.limit, 10));
});

// ---------- Settings panel ----------

function openSettings() {
  setSoundAlerts.checked = settings.soundAlerts;
  setTonePitch.value = settings.tonePitch;
  valTonePitch.textContent = `${settings.tonePitch} Hz`;
  setLookahead.value = settings.lookaheadSec;
  valLookahead.textContent = `${settings.lookaheadSec} s`;
  setWakeLock.checked = settings.wakeLock;
  setTestMode.checked = settings.testMode;
  setAutoMode.checked = settings.autoMode;
  applyAutoModeUI();
  renderVoiceRows();
  settingsPanel.hidden = false;
}

settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

setSoundAlerts.addEventListener("change", () => {
  settings.soundAlerts = setSoundAlerts.checked;
  saveSettings();
  if (!settings.soundAlerts) {
    stopExceedTone();
  } else if (currentStatus === "exceeding") {
    startExceedTone();
  }
});

setTonePitch.addEventListener("input", () => {
  settings.tonePitch = parseInt(setTonePitch.value, 10);
  valTonePitch.textContent = `${settings.tonePitch} Hz`;
  // Retune live if the alarm is already sounding while the slider is dragged.
  if (exceedToneNode) exceedToneNode.osc.frequency.value = settings.tonePitch;
});

setTonePitch.addEventListener("change", () => {
  saveSettings();
  ensureAudioCtx(); // this is a user gesture, safe to unlock audio here too
  if (currentStatus !== "exceeding") previewTone();
});

setLookahead.addEventListener("input", () => {
  settings.lookaheadSec = parseFloat(setLookahead.value);
  valLookahead.textContent = `${settings.lookaheadSec} s`;
  saveSettings();
  renderSpeed();
  updateStatus();
});

setAutoMode.addEventListener("change", () => {
  settings.autoMode = setAutoMode.checked;
  if (settings.autoMode) settings.speedLimit = null;
  saveSettings();
  ensureAudioCtx();
  resetVoiceState();
  applyAutoModeUI();
  renderLimit();
  updateStatus();
});

setWakeLock.addEventListener("change", () => {
  settings.wakeLock = setWakeLock.checked;
  saveSettings();
  if (settings.wakeLock) requestWakeLock();
  else releaseWakeLock();
});

// ---------- Test mode ----------

function applyTestModeUI() {
  testControls.hidden = !settings.testMode;
  renderSpeed();
}

function setTestSpeedMph(value) {
  const clamped = Math.max(0, Math.min(200, value));
  displaySpeedMps = mphToMps(clamped);
  hasSpeedFix = true;
  sampleSpeed();
  renderSpeed();
  updateStatus();
}

testSpeedDown.addEventListener("click", () => {
  setTestSpeedMph(Math.round(mpsToMph(displaySpeedMps)) - 1);
});
testSpeedUp.addEventListener("click", () => {
  setTestSpeedMph(Math.round(mpsToMph(displaySpeedMps)) + 1);
});

testPresetUnder.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedMph(settings.speedLimit - 5);
});
testPresetAt.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedMph(settings.speedLimit);
});
testPresetOver.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedMph(settings.speedLimit + 5);
});

setTestMode.addEventListener("change", () => {
  const wasTestMode = settings.testMode;
  settings.testMode = setTestMode.checked;
  saveSettings();

  if (wasTestMode !== settings.testMode) {
    if (settings.testMode) {
      // Switch live from real GPS to manual test control, keeping continuity.
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      startTestTracking();
    } else {
      // Switch back to real GPS; wait for a fresh fix before trusting the reading.
      gpsInfo.classList.remove("test-mode");
      gpsInfo.textContent = "GPS —";
      hasSpeedFix = false;
      updateStatus();
      startTracking();
    }
  }

  applyTestModeUI();
});

// ---------- Startup ----------

function describeGeoError(err) {
  switch (err && err.code) {
    case 1:
      return "Location permission was denied. Click the icon at the left of the address bar, set Location to Allow, then reload the page.";
    case 2:
      return "Your device couldn't get a position fix. On a desktop PC check Windows Settings → Privacy & security → Location is on. This works best on a phone, outdoors.";
    case 3:
      return "Timed out waiting for a location fix. Trying again in the background — this is normal indoors.";
    default:
      return err && err.message ? err.message : "Location is unavailable.";
  }
}

// The top-right button clears the current limit (and so silences any alarm)
// rather than stopping the app - there's no separate start/stop screen to
// return to, tracking just runs continuously from page load.
stopBtn.addEventListener("click", () => {
  ensureAudioCtx();
  settings.speedLimit = null;
  saveSettings();
  renderLimit();
  updateStatus();
});

// AudioContext needs a user gesture to unlock, and there's no Start button
// to hang that off anymore. The speed-sign and clear buttons above already
// unlock it on the click a driver is most likely to make first; these are a
// fallback for any other first interaction (e.g. opening Settings), covering
// multiple gesture types since browsers (notably iOS Safari) vary on which
// one they'll actually accept for unlocking Web Audio.
// Keep retrying on every gesture until the context is actually running, and
// re-arm if the OS suspends it again (e.g. after backgrounding the app).
for (const type of ["pointerdown", "touchend", "click", "keydown"]) {
  document.addEventListener(type, () => ensureAudioCtx());
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && audioCtx && audioCtx.state !== "running") {
    audioCtx.resume().catch(() => {});
  }
});

// Never carry a limit over from a previous session - opening the app should
// never immediately start warning off a stale choice.
settings.speedLimit = null;
saveSettings();

applyTestModeUI();
applyAutoModeUI();
loadClips().then(renderVoiceRows);
statusPanel.dataset.status = currentStatus;
mainView.dataset.status = currentStatus;
renderSpeed();
renderLimit();
renderStatusMessage();

if (!settings.testMode && !("geolocation" in navigator)) {
  statusMessageEl.textContent = "This browser doesn't support geolocation.";
} else {
  startTracking();
}

// ---------- Service worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
  // Pick up a freshly deployed build right away instead of on the next launch.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

// After a rotation, iOS can leave the page scrolled/offset; snap it back.
function resetViewportScroll() {
  window.scrollTo(0, 0);
  setTimeout(() => window.scrollTo(0, 0), 300);
}
window.addEventListener("orientationchange", resetViewportScroll);
window.addEventListener("resize", () => window.scrollTo(0, 0));
