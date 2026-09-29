"use strict";

// ---------- Config ----------

const BUILD_VERSION = "1.0.13"; // kept in sync with VERSION / CACHE_NAME by deploy.sh on every deploy
const STORAGE_KEY = "speed-guard-settings";
const MPS_TO_MPH = 2.2369362920544;
const GPS_STALE_MS = 6000; // no fresh fix for this long -> show as stale
const MIN_TONE_HZ = 500;
const MAX_TONE_HZ = 2500;

const DEFAULT_SETTINGS = {
  soundAlerts: true,
  tonePitch: 1200, // Hz, fundamental of the exceed-limit tone - user-adjustable in Settings
  wakeLock: true,
  speedLimit: null, // number, mph
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

const startScreen = document.getElementById("startScreen");
const startBtn = document.getElementById("startBtn");
const startError = document.getElementById("startError");
const permLocation = document.getElementById("permLocation");
const settingsBtnStart = document.getElementById("settingsBtnStart");
const testModeBadge = document.getElementById("testModeBadge");
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
const testSpeedSlider = document.getElementById("testSpeedSlider");
const testPresetUnder = document.getElementById("testPresetUnder");
const testPresetAt = document.getElementById("testPresetAt");
const testPresetOver = document.getElementById("testPresetOver");

const settingsPanel = document.getElementById("settingsPanel");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const setSoundAlerts = document.getElementById("setSoundAlerts");
const setTonePitch = document.getElementById("setTonePitch");
const valTonePitch = document.getElementById("valTonePitch");
const setWakeLock = document.getElementById("setWakeLock");
const setTestMode = document.getElementById("setTestMode");

// ---------- State ----------

let watchId = null;
let lastPosition = null; // { latitude, longitude, timestamp } for haversine fallback
let lastFixAt = 0;
let hasSpeedFix = false; // never assert "within limit" off a speed we don't actually have
let displaySpeedMps = 0; // smoothed
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

function renderSpeed() {
  speedValueEl.textContent = Math.round(mpsToMph(displaySpeedMps)).toString();
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
      statusMessageEl.textContent = "Pick a speed limit below.";
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
  if (settings.speedLimit == null) return "no-limit";
  const currentMph = mpsToMph(displaySpeedMps);
  return currentMph > settings.speedLimit ? "exceeding" : "ok";
}

function updateStatus() {
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
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
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

function stopTracking() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
  stopExceedTone();
}

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
  // Re-acquire whenever the app is on screen and tracking, whether that's
  // real GPS or Test mode - the sentinel itself is released by the browser
  // whenever the tab goes out of view.
  if (document.visibilityState === "visible" && !mainView.hidden && settings.wakeLock) {
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
  setSpeedLimit(parseInt(btn.dataset.limit, 10));
});

// ---------- Settings panel ----------

function openSettings() {
  setSoundAlerts.checked = settings.soundAlerts;
  setTonePitch.value = settings.tonePitch;
  valTonePitch.textContent = `${settings.tonePitch} Hz`;
  setWakeLock.checked = settings.wakeLock;
  setTestMode.checked = settings.testMode;
  settingsPanel.hidden = false;
}

settingsBtn.addEventListener("click", openSettings);
settingsBtnStart.addEventListener("click", openSettings);
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

setWakeLock.addEventListener("change", () => {
  settings.wakeLock = setWakeLock.checked;
  saveSettings();
  if (settings.wakeLock && !mainView.hidden) requestWakeLock();
  else releaseWakeLock();
});

// ---------- Test mode ----------

function applyTestModeUI() {
  testControls.hidden = !settings.testMode;
  testModeBadge.hidden = !(settings.testMode && startScreen.hidden === false);
  if (settings.testMode) syncTestSlider();
}

function syncTestSlider() {
  if (!settings.testMode) return;
  testSpeedSlider.value = String(Math.round(mpsToMph(displaySpeedMps)));
}

function setTestSpeedMph(value) {
  const clamped = Math.max(0, Math.min(200, value));
  testSpeedSlider.value = String(clamped);
  displaySpeedMps = mphToMps(clamped);
  hasSpeedFix = true;
  renderSpeed();
  updateStatus();
}

testSpeedSlider.addEventListener("input", () => {
  displaySpeedMps = mphToMps(parseFloat(testSpeedSlider.value));
  hasSpeedFix = true;
  renderSpeed();
  updateStatus();
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

  if (mainView.hidden === false && wasTestMode !== settings.testMode) {
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

// ---------- Start / stop ----------

// Reflect the current geolocation permission state on the start screen, so it's
// obvious whether the browser will prompt, has already granted, or is blocking.
async function refreshLocationPermission() {
  if (!navigator.permissions || !navigator.permissions.query) return null;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    const apply = () => {
      if (status.state === "granted") permLocation.dataset.state = "granted";
      else if (status.state === "denied") permLocation.dataset.state = "denied";
      else permLocation.dataset.state = "pending";
      if (status.state === "denied") {
        startError.textContent =
          "Location is blocked for this site. Click the icon at the left of the address bar, set Location to Allow, then reload.";
        startError.hidden = false;
      }
    };
    apply();
    status.onchange = apply;
    return status.state;
  } catch (err) {
    return null;
  }
}

refreshLocationPermission();

function describeGeoError(err) {
  switch (err && err.code) {
    case 1:
      return "Location permission was denied. Click the icon at the left of the address bar, set Location to Allow, then press Start again.";
    case 2:
      return "Your device couldn't get a position fix. On a desktop PC check Windows Settings → Privacy & security → Location is on. This works best on a phone, outdoors.";
    case 3:
      return "Timed out waiting for a location fix. Trying again in the background — this is normal indoors.";
    default:
      return err && err.message ? err.message : "Location is unavailable.";
  }
}

startBtn.addEventListener("click", async () => {
  startError.hidden = true;

  if (settings.testMode) {
    ensureAudioCtx(); // unlock audio on this user gesture
    enterMainView();
    return;
  }

  if (!("geolocation" in navigator)) {
    startError.textContent = "This browser doesn't support geolocation.";
    startError.hidden = false;
    return;
  }

  ensureAudioCtx(); // unlock audio on this user gesture
  startBtn.disabled = true;
  startBtn.textContent = "Requesting location…";

  const finish = () => {
    startBtn.disabled = false;
    startBtn.textContent = "Start";
  };

  // This call is what triggers the browser's permission prompt.
  navigator.geolocation.getCurrentPosition(
    () => {
      permLocation.dataset.state = "granted";
      finish();
      enterMainView();
    },
    (err) => {
      finish();
      startError.textContent = describeGeoError(err);
      startError.hidden = false;
      if (err && err.code === 1) {
        permLocation.dataset.state = "denied";
      } else {
        // Permission is fine, we just have no fix yet - let the watch keep
        // trying rather than trapping the user on the start screen.
        permLocation.dataset.state = "granted";
        enterMainView();
      }
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

function enterMainView() {
  startScreen.hidden = true;
  mainView.hidden = false;
  applyTestModeUI();
  statusPanel.dataset.status = currentStatus;
  mainView.dataset.status = currentStatus;
  renderSpeed();
  renderLimit();
  renderStatusMessage();
  startTracking();
}

stopBtn.addEventListener("click", () => {
  stopTracking();
  mainView.hidden = true;
  startScreen.hidden = false;
  displaySpeedMps = 0;
  currentStatus = "no-fix";
  hasSpeedFix = false;
  lastPosition = null;
  gpsInfo.classList.remove("test-mode");
  testSpeedSlider.value = "0";
  applyTestModeUI();
});

applyTestModeUI(); // reflect a persisted test-mode setting on the start screen badge

// ---------- Service worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
