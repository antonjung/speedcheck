"use strict";

// ---------- Config ----------

const BUILD_VERSION = "1.0.4"; // kept in sync with VERSION / CACHE_NAME by deploy.sh on every deploy
const STORAGE_KEY = "speed-guard-settings";
const MPS_TO_KMH = 3.6;
const MPS_TO_MPH = 2.2369362920544;
const GPS_STALE_MS = 6000; // no fresh fix for this long -> show as stale
const RECOGNITION_RESTART_DELAY_MS = 300;
const MAX_BONG_INTERVAL_MS = 900; // beep rate just as you enter the warn band
const MIN_BONG_INTERVAL_MS = 160; // beep rate right at the limit, just before it goes solid

const DEFAULT_SETTINGS = {
  unit: "kmh", // 'kmh' | 'mph'
  warnBufferPercent: 10, // amber warning band below the limit
  soundAlerts: true,
  voiceAnnounce: true,
  wakeLock: true,
  speedLimit: null, // number, in `unit`
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
const speedUnitEl = document.getElementById("speedUnit");
const limitValueEl = document.getElementById("limitValue");
const statusMessageEl = document.getElementById("statusMessage");
const micBtn = document.getElementById("micBtn");
const transcriptEl = document.getElementById("transcript");

const manualLimitInput = document.getElementById("manualLimitInput");
const manualSetBtn = document.getElementById("manualSetBtn");
const manualClearBtn = document.getElementById("manualClearBtn");

const testControls = document.getElementById("testControls");
const testSpeedSlider = document.getElementById("testSpeedSlider");
const testPresetUnder = document.getElementById("testPresetUnder");
const testPresetAt = document.getElementById("testPresetAt");
const testPresetOver = document.getElementById("testPresetOver");

const settingsPanel = document.getElementById("settingsPanel");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const unitSegmented = document.getElementById("unitSegmented");
const setWarnBuffer = document.getElementById("setWarnBuffer");
const valWarnBuffer = document.getElementById("valWarnBuffer");
const setSoundAlerts = document.getElementById("setSoundAlerts");
const setVoiceAnnounce = document.getElementById("setVoiceAnnounce");
const setWakeLock = document.getElementById("setWakeLock");
const setTestMode = document.getElementById("setTestMode");

// ---------- State ----------

let watchId = null;
let lastPosition = null; // { latitude, longitude, timestamp } for haversine fallback
let lastFixAt = 0;
let hasSpeedFix = false; // never assert "within limit" off a speed we don't actually have
let displaySpeedMps = 0; // smoothed
let currentStatus = "no-fix"; // 'no-fix' | 'no-limit' | 'ok' | 'approaching' | 'exceeding'
let wakeLockSentinel = null;

let recognition = null;
let micEnabled = false;
let recognitionShouldRun = false;

let audioCtx = null;

// ---------- Unit helpers ----------

function mpsToUnit(mps, unit) {
  return unit === "mph" ? mps * MPS_TO_MPH : mps * MPS_TO_KMH;
}

function unitLabel(unit) {
  return unit === "mph" ? "mph" : "km/h";
}

function unitToMps(value, unit) {
  return unit === "mph" ? value / MPS_TO_MPH : value / MPS_TO_KMH;
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
  const displayUnit = settings.unit;
  const value = mpsToUnit(displaySpeedMps, displayUnit);
  speedValueEl.textContent = Math.round(value).toString();
  speedUnitEl.textContent = unitLabel(displayUnit);
}

function renderLimit() {
  limitValueEl.textContent =
    settings.speedLimit == null ? "—" : `${settings.speedLimit} ${unitLabel(settings.unit)}`;
  const noLimit = settings.speedLimit == null;
  testPresetUnder.disabled = noLimit;
  testPresetAt.disabled = noLimit;
  testPresetOver.disabled = noLimit;
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
      statusMessageEl.textContent = "Say a speed limit, or set one below.";
      break;
    case "ok":
      statusMessageEl.textContent = "Within limit.";
      break;
    case "approaching":
      statusMessageEl.textContent = "Approaching the limit.";
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
  const currentInUnit = mpsToUnit(displaySpeedMps, settings.unit);
  const warnThreshold = settings.speedLimit * (1 - settings.warnBufferPercent / 100);
  if (currentInUnit > settings.speedLimit) return "exceeding";
  if (currentInUnit >= warnThreshold) return "approaching";
  return "ok";
}

function updateStatus() {
  const next = evaluateStatus();
  if (next !== currentStatus) {
    const prev = currentStatus;
    currentStatus = next;
    statusPanel.dataset.status = currentStatus;
    renderStatusMessage();
    onStatusTransition(prev, next);
  }
}

function onStatusTransition(prev, next) {
  if (next === "exceeding") {
    speak("Warning. Speed limit exceeded.");
    startAlertLoop();
  } else if (next === "approaching") {
    startAlertLoop();
  } else {
    stopAlertLoop();
  }
}

// ---------- Audio: proximity alert ----------
//
// A soft two-partial "bong" (like a mellow bell) repeats faster the closer
// the current speed gets to the limit within the warn band, then becomes an
// unbroken sustained tone once at or over the limit. The pitch never
// changes - only the repeat rate does - so it reads as urgency, not alarm.

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

const BONG_FUNDAMENTAL_HZ = 660;
const BONG_PARTIALS = [
  { ratio: 1, gain: 0.22 },
  { ratio: 2.01, gain: 0.11 }, // slightly detuned octave gives it a bell-like shimmer
];

function playBong() {
  if (!settings.soundAlerts) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const { ratio, gain: peakGain } of BONG_PARTIALS) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = BONG_FUNDAMENTAL_HZ * ratio;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.42);
  }
}

let exceedToneNodes = null;

function startExceedTone() {
  if (exceedToneNodes || !settings.soundAlerts) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  exceedToneNodes = BONG_PARTIALS.map(({ ratio, gain: peakGain }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = BONG_FUNDAMENTAL_HZ * ratio;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain * 0.8, now + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    return { osc, gain };
  });
}

function stopExceedTone() {
  if (!exceedToneNodes) return;
  const ctx = audioCtx;
  const now = ctx ? ctx.currentTime : 0;
  for (const { osc, gain } of exceedToneNodes) {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
      osc.stop(now + 0.15);
    } catch (err) {
      /* already stopped */
    }
  }
  exceedToneNodes = null;
}

let alertTimer = null;

function alertTick() {
  alertTimer = null;

  if (currentStatus === "exceeding") {
    startExceedTone();
    return;
  }
  stopExceedTone();

  if (currentStatus !== "approaching" || settings.speedLimit == null) return;

  const currentInUnit = mpsToUnit(displaySpeedMps, settings.unit);
  const warnThreshold = settings.speedLimit * (1 - settings.warnBufferPercent / 100);
  const span = Math.max(0.001, settings.speedLimit - warnThreshold);
  const proximity = Math.min(1, Math.max(0, (currentInUnit - warnThreshold) / span));
  const interval = MAX_BONG_INTERVAL_MS - (MAX_BONG_INTERVAL_MS - MIN_BONG_INTERVAL_MS) * proximity;

  playBong();
  alertTimer = setTimeout(alertTick, interval);
}

function startAlertLoop() {
  if (alertTimer) {
    clearTimeout(alertTimer);
    alertTimer = null;
  }
  alertTick();
}

function stopAlertLoop() {
  if (alertTimer) {
    clearTimeout(alertTimer);
    alertTimer = null;
  }
  stopExceedTone();
}

// ---------- Speech synthesis ----------

function speak(text) {
  if (!settings.voiceAnnounce) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  window.speechSynthesis.speak(utter);
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
  stopAlertLoop();
  stopRecognition();
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
  if (document.visibilityState === "visible" && watchId != null && settings.wakeLock) {
    requestWakeLock();
  }
});

// ---------- Speed limit setting ----------

function setSpeedLimit(value, unit) {
  if (unit && unit !== settings.unit) {
    settings.unit = unit;
    applyUnitUI();
  }
  settings.speedLimit = value;
  saveSettings();
  renderLimit();
  updateStatus();
  speak(`Speed limit set to ${value} ${unitLabel(settings.unit)}.`);
}

function clearSpeedLimit() {
  settings.speedLimit = null;
  saveSettings();
  renderLimit();
  updateStatus();
  speak("Speed limit cleared.");
}

manualSetBtn.addEventListener("click", () => {
  const val = parseInt(manualLimitInput.value, 10);
  if (Number.isFinite(val) && val > 0 && val <= 300) {
    setSpeedLimit(val, null);
    manualLimitInput.value = "";
    manualLimitInput.blur();
  }
});

manualClearBtn.addEventListener("click", () => {
  clearSpeedLimit();
  manualLimitInput.value = "";
});

manualLimitInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") manualSetBtn.click();
});

// ---------- Voice command parsing ----------

const ONES = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function extractNumbers(tokens) {
  const numbers = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^\d+(\.\d+)?$/.test(tok)) {
      numbers.push({ value: Math.round(parseFloat(tok)), start: i, end: i });
      i++;
      continue;
    }
    if (tok in ONES || tok in TENS || tok === "hundred") {
      const start = i;
      let j = i;
      let current = 0;
      let any = false;
      while (j < tokens.length) {
        const w = tokens[j];
        if (w in ONES) {
          current += ONES[w];
          any = true;
          j++;
        } else if (w in TENS) {
          current += TENS[w];
          any = true;
          j++;
        } else if (w === "hundred") {
          current = (current || 1) * 100;
          any = true;
          j++;
        } else if (w === "and" && any) {
          j++;
        } else {
          break;
        }
      }
      if (any) {
        numbers.push({ value: current, start, end: j - 1 });
        i = j;
        continue;
      }
    }
    i++;
  }
  return numbers;
}

function parseVoiceCommand(transcript) {
  const cleaned = transcript.toLowerCase().replace(/[^\w\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  if (
    tokens.includes("clear") ||
    tokens.includes("cancel") ||
    (tokens.includes("no") && tokens.includes("limit")) ||
    (tokens.includes("remove") && tokens.includes("limit"))
  ) {
    return { type: "clear" };
  }

  let unit = null;
  if (tokens.includes("mph") || tokens.includes("miles")) unit = "mph";
  else if (
    tokens.includes("kph") || tokens.includes("kmh") || tokens.includes("km") ||
    tokens.includes("kilometers") || tokens.includes("kilometres") || tokens.includes("kmph")
  ) {
    unit = "kmh";
  }

  const numbers = extractNumbers(tokens);
  if (numbers.length === 0) {
    if (unit) return { type: "unit", unit };
    return null;
  }

  const value = numbers[numbers.length - 1].value;
  if (value <= 0 || value > 300) return null;

  return { type: "limit", value, unit };
}

function handleTranscript(transcript) {
  transcriptEl.textContent = `Heard: “${transcript}”`;
  const cmd = parseVoiceCommand(transcript);
  if (!cmd) return;

  if (cmd.type === "clear") {
    clearSpeedLimit();
  } else if (cmd.type === "unit") {
    settings.unit = cmd.unit;
    saveSettings();
    applyUnitUI();
    renderSpeed();
    renderLimit();
    updateStatus();
    syncTestSlider();
    speak(`Switched to ${unitLabel(cmd.unit)}.`);
  } else if (cmd.type === "limit") {
    setSpeedLimit(cmd.value, cmd.unit);
  }
}

// ---------- Speech recognition ----------

function getRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function initRecognition() {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;
  const r = new Ctor();
  r.continuous = true;
  r.interimResults = false;
  r.lang = navigator.language || "en-GB";

  r.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        handleTranscript(result[0].transcript.trim());
      }
    }
  };

  r.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      micEnabled = false;
      recognitionShouldRun = false;
      micBtn.dataset.listening = "false";
      transcriptEl.textContent = "Microphone permission denied.";
    }
    // 'no-speech' / 'network' etc. are recovered by onend's restart logic.
  };

  r.onend = () => {
    if (recognitionShouldRun) {
      setTimeout(() => {
        if (recognitionShouldRun) {
          try {
            r.start();
          } catch (err) {
            /* already started; ignore */
          }
        }
      }, RECOGNITION_RESTART_DELAY_MS);
    }
  };

  return r;
}

function startRecognition() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) {
    transcriptEl.textContent = "Voice input isn't supported in this browser.";
    return;
  }
  recognitionShouldRun = true;
  try {
    recognition.start();
  } catch (err) {
    /* already running */
  }
  micEnabled = true;
  micBtn.dataset.listening = "true";
}

function stopRecognition() {
  recognitionShouldRun = false;
  micEnabled = false;
  micBtn.dataset.listening = "false";
  if (recognition) {
    try {
      recognition.stop();
    } catch (err) {
      /* ignore */
    }
  }
}

micBtn.addEventListener("click", () => {
  ensureAudioCtx(); // unlock audio on the same user gesture
  if (micEnabled) {
    stopRecognition();
  } else {
    startRecognition();
  }
});

// ---------- Settings panel ----------

function applyUnitUI() {
  for (const seg of unitSegmented.querySelectorAll(".segment")) {
    seg.dataset.active = String(seg.dataset.unit === settings.unit);
  }
}

function openSettings() {
  applyUnitUI();
  setWarnBuffer.value = settings.warnBufferPercent;
  valWarnBuffer.textContent = `${settings.warnBufferPercent}%`;
  setSoundAlerts.checked = settings.soundAlerts;
  setVoiceAnnounce.checked = settings.voiceAnnounce;
  setWakeLock.checked = settings.wakeLock;
  setTestMode.checked = settings.testMode;
  settingsPanel.hidden = false;
}

settingsBtn.addEventListener("click", openSettings);
settingsBtnStart.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

unitSegmented.addEventListener("click", (e) => {
  const btn = e.target.closest(".segment");
  if (!btn) return;
  settings.unit = btn.dataset.unit;
  saveSettings();
  applyUnitUI();
  renderSpeed();
  renderLimit();
  updateStatus();
  syncTestSlider();
});

setWarnBuffer.addEventListener("input", () => {
  settings.warnBufferPercent = parseInt(setWarnBuffer.value, 10);
  valWarnBuffer.textContent = `${settings.warnBufferPercent}%`;
  saveSettings();
  updateStatus();
});

setSoundAlerts.addEventListener("change", () => {
  settings.soundAlerts = setSoundAlerts.checked;
  saveSettings();
  if (!settings.soundAlerts) {
    stopAlertLoop();
  } else if (currentStatus === "approaching" || currentStatus === "exceeding") {
    startAlertLoop();
  }
});

setVoiceAnnounce.addEventListener("change", () => {
  settings.voiceAnnounce = setVoiceAnnounce.checked;
  saveSettings();
});

setWakeLock.addEventListener("change", () => {
  settings.wakeLock = setWakeLock.checked;
  saveSettings();
  if (settings.wakeLock && watchId != null) requestWakeLock();
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
  testSpeedSlider.value = String(Math.round(mpsToUnit(displaySpeedMps, settings.unit)));
}

function setTestSpeedToUnit(value) {
  const clamped = Math.max(0, Math.min(200, value));
  testSpeedSlider.value = String(clamped);
  displaySpeedMps = unitToMps(clamped, settings.unit);
  hasSpeedFix = true;
  renderSpeed();
  updateStatus();
}

testSpeedSlider.addEventListener("input", () => {
  displaySpeedMps = unitToMps(parseFloat(testSpeedSlider.value), settings.unit);
  hasSpeedFix = true;
  renderSpeed();
  updateStatus();
});

testPresetUnder.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedToUnit(settings.speedLimit - 5);
});
testPresetAt.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedToUnit(settings.speedLimit);
});
testPresetOver.addEventListener("click", () => {
  if (settings.speedLimit == null) return;
  setTestSpeedToUnit(settings.speedLimit + 5);
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
  applyUnitUI();
  applyTestModeUI();
  statusPanel.dataset.status = currentStatus;
  renderSpeed();
  renderLimit();
  renderStatusMessage();
  startTracking();
  startRecognition(); // listen for spoken limits from the moment you're on the road
}

stopBtn.addEventListener("click", () => {
  stopTracking();
  mainView.hidden = true;
  startScreen.hidden = false;
  displaySpeedMps = 0;
  currentStatus = "no-fix";
  hasSpeedFix = false;
  lastPosition = null;
  transcriptEl.textContent = "";
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
