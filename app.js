"use strict";

// ---------- Config ----------

const BUILD_VERSION = "1.0.37"; // kept in sync with VERSION / CACHE_NAME by deploy.sh on every deploy
const STORAGE_KEY = "speed-guard-settings";
const MPS_TO_MPH = 2.2369362920544;
const GPS_STALE_MS = 6000; // no fresh fix for this long -> reading is not trusted
const DIAL_MAX_MPH = 100;
const DIAL_START_DEG = -135; // needle angle at 0 mph (0 = straight up)
const DIAL_SWEEP_DEG = 270;
const MAX_ANNOUNCE_MPH = 100; // highest recorded clip

const DEFAULT_SETTINGS = {
  intervalSec: 10, // seconds between spoken speed announcements
  muted: false, // "Silent" switch: no spoken announcements at all
  silentBelowMph: 0, // no announcements while slower than this
  volume: 100, // announcement volume, 0-100
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
let testMode = false; // drive speed manually instead of via GPS; toggled by holding the dial

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ---------- DOM ----------

document.getElementById("buildVersion").textContent = `build ${BUILD_VERSION}`;

const gpsInfo = document.getElementById("gpsInfo");
const speedValueEl = document.getElementById("speedValue");
const statusMessageEl = document.getElementById("statusMessage");
const dialEl = document.getElementById("dial");

const testControls = document.getElementById("testControls");
const testSpeedDown = document.getElementById("testSpeedDown");
const testSpeedUp = document.getElementById("testSpeedUp");
const testSpeedDown10 = document.getElementById("testSpeedDown10");
const testSpeedUp10 = document.getElementById("testSpeedUp10");

const setIntervalEl = document.getElementById("setInterval");
const valInterval = document.getElementById("valInterval");
const setMuted = document.getElementById("setMuted");
const setSilent = document.getElementById("setSilent");
const valSilent = document.getElementById("valSilent");
const setVolume = document.getElementById("setVolume");
const valVolume = document.getElementById("valVolume");

// ---------- State ----------

let watchId = null;
let lastPosition = null; // { latitude, longitude, timestamp } for haversine fallback
let lastFixAt = 0;
let hasSpeedFix = false;
let displaySpeedMps = 0; // smoothed
let wakeLockSentinel = null;
let audioCtx = null;

// ---------- Unit helpers (mph throughout) ----------

function mpsToMph(mps) {
  return mps * MPS_TO_MPH;
}

function mphToMps(mph) {
  return mph / MPS_TO_MPH;
}

function currentMph() {
  return mpsToMph(displaySpeedMps);
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

// ---------- Dial ----------

const SVG_NS = "http://www.w3.org/2000/svg";
let needleEl = null;

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function polar(r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [100 + r * Math.cos(rad), 100 + r * Math.sin(rad)];
}

function buildDial() {
  const [x0, y0] = polar(86, DIAL_START_DEG);
  const [x1, y1] = polar(86, DIAL_START_DEG + DIAL_SWEEP_DEG);
  dialEl.append(svgEl("path", { class: "track", d: `M ${x0} ${y0} A 86 86 0 1 1 ${x1} ${y1}` }));
  for (let mph = 0; mph <= DIAL_MAX_MPH; mph += 5) {
    const deg = DIAL_START_DEG + (mph / DIAL_MAX_MPH) * DIAL_SWEEP_DEG;
    const major = mph % 10 === 0;
    const [ax, ay] = polar(major ? 76 : 80, deg);
    const [bx, by] = polar(86, deg);
    dialEl.append(svgEl("line", { class: "tick" + (major ? " major" : ""), x1: ax, y1: ay, x2: bx, y2: by }));
    if (major) {
      const [lx, ly] = polar(65, deg);
      const label = svgEl("text", { class: "label", x: lx, y: ly });
      label.textContent = String(mph);
      dialEl.append(label);
    }
  }
  needleEl = svgEl("g", { style: "transition: transform 0.4s ease-out; transform-origin: 100px 100px;" });
  needleEl.append(svgEl("line", { class: "needle", x1: 100, y1: 100, x2: 100, y2: 28 }));
  dialEl.append(needleEl, svgEl("circle", { class: "hub", cx: 100, cy: 100, r: 6 }));
}

// Reaching the "silent below" speed from under it announces straight away.
let wasBelowSilent = true;

function checkSilentCrossing() {
  const threshold = settings.silentBelowMph;
  const below = threshold > 0 && currentMph() < threshold;
  if (threshold > 0 && wasBelowSilent && !below && hasSpeedFix) {
    // Skip if this same speed was already announced within the interval,
    // e.g. dipping to 19 and straight back to 20.
    const n = Math.min(Math.round(currentMph()), MAX_ANNOUNCE_MPH);
    const last = lastSpokenAt.get(n);
    if (last === undefined || Date.now() - last >= settings.intervalSec * 1000) {
      announceSpeed();
      restartAnnounceTimer();
    }
  }
  wasBelowSilent = below || threshold === 0;
}

function renderSpeed() {
  const mph = currentMph();
  speedValueEl.textContent = Math.round(mph).toString();
  const frac = Math.max(0, Math.min(1, mph / DIAL_MAX_MPH));
  needleEl.style.transform = `rotate(${DIAL_START_DEG + frac * DIAL_SWEEP_DEG}deg)`;
  checkSilentCrossing();
}

function renderGpsInfo(accuracyM) {
  gpsInfo.textContent = accuracyM == null ? "GPS —" : `GPS ±${Math.round(accuracyM)}m`;
}

// ---------- Audio ----------

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

// ---------- Spoken speed ----------
//
// audio/1.mp3 ... audio/100.mp3 are pre-generated recordings (British male
// voice) of each number. Every settings.intervalSec seconds the current speed
// is played if it is above zero.

const clipBuffers = new Map(); // number -> AudioBuffer

async function loadClip(n) {
  if (clipBuffers.has(n)) return clipBuffers.get(n);
  const ctx = ensureAudioCtx();
  if (!ctx) return null;
  const res = await fetch(`audio/${n}.mp3`);
  if (!res.ok) throw new Error(`clip ${n}`);
  const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
  clipBuffers.set(n, buffer);
  return buffer;
}

const lastSpokenAt = new Map(); // number -> time it was last announced

async function announceSpeed() {
  if (!hasSpeedFix) return;
  const n = Math.min(Math.round(currentMph()), MAX_ANNOUNCE_MPH);
  if (settings.muted || n < 1 || currentMph() < settings.silentBelowMph) return;
  lastSpokenAt.set(n, Date.now());
  try {
    const buffer = await loadClip(n);
    if (!buffer) return;
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const gain = audioCtx.createGain();
    gain.gain.value = settings.volume / 100;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start();
  } catch (err) {
    /* clip unavailable (e.g. offline and not cached): stay silent */
  }
}

let announceTimer = null;

function restartAnnounceTimer() {
  clearInterval(announceTimer);
  announceTimer = setInterval(announceSpeed, settings.intervalSec * 1000);
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
    statusMessageEl.textContent = "";
    renderSpeed();
  }

  renderGpsInfo(accuracy);
}

function onPositionError(err) {
  gpsInfo.textContent = err && err.code === 1 ? "GPS — blocked" : "GPS — no fix";
  hasSpeedFix = false;
  statusMessageEl.textContent = describeGeoError(err);
}

function startTracking() {
  if (testMode) {
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
  statusMessageEl.textContent = "";
  hasSpeedFix = true;
  renderSpeed();
  requestWakeLock();
}

setInterval(() => {
  if (watchId != null && lastFixAt && Date.now() - lastFixAt > GPS_STALE_MS) {
    gpsInfo.textContent = "GPS — no fix";
    // Stop announcing a speed reading that may now be seconds out of date.
    hasSpeedFix = false;
  }
}, 2000);

// ---------- Wake Lock ----------

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
  } catch (err) {
    wakeLockSentinel = null;
  }
}

document.addEventListener("visibilitychange", () => {
  // The sentinel is released by the browser whenever the tab goes out of view.
  if (document.visibilityState === "visible") {
    requestWakeLock();
  }
});

// ---------- Settings panel ----------

function initControls() {
  setMuted.checked = settings.muted;
  setIntervalEl.value = settings.intervalSec;
  valInterval.textContent = `${settings.intervalSec} s`;
  setSilent.value = settings.silentBelowMph;
  valSilent.textContent = `${settings.silentBelowMph} mph`;
  setVolume.value = settings.volume;
  valVolume.textContent = `${settings.volume}%`;
}

setVolume.addEventListener("input", () => {
  settings.volume = parseInt(setVolume.value, 10);
  valVolume.textContent = `${settings.volume}%`;
  saveSettings();
});

setSilent.addEventListener("input", () => {
  settings.silentBelowMph = parseInt(setSilent.value, 10);
  valSilent.textContent = `${settings.silentBelowMph} mph`;
  saveSettings();
  // Re-arm against the new threshold without announcing.
  wasBelowSilent = settings.silentBelowMph === 0 || currentMph() < settings.silentBelowMph;
});

setMuted.addEventListener("change", () => {
  settings.muted = setMuted.checked;
  saveSettings();
  if (!settings.muted) {
    // Coming out of silent mode: announce now and restart the interval.
    announceSpeed();
    restartAnnounceTimer();
  }
});

setIntervalEl.addEventListener("input", () => {
  settings.intervalSec = parseInt(setIntervalEl.value, 10);
  valInterval.textContent = `${settings.intervalSec} s`;
  saveSettings();
  restartAnnounceTimer();
});

// ---------- Test mode ----------

function applyTestModeUI() {
  testControls.hidden = !testMode;
  renderSpeed();
}

function setTestSpeedMph(value) {
  displaySpeedMps = mphToMps(Math.max(0, Math.min(200, value)));
  hasSpeedFix = true;
  renderSpeed();
}

function nudgeTestSpeed(delta) {
  setTestSpeedMph(Math.round(currentMph()) + delta);
}
testSpeedDown.addEventListener("click", () => nudgeTestSpeed(-1));
testSpeedUp.addEventListener("click", () => nudgeTestSpeed(1));
testSpeedDown10.addEventListener("click", () => nudgeTestSpeed(-10));
testSpeedUp10.addEventListener("click", () => nudgeTestSpeed(10));

function setTestMode(on) {
  if (on === testMode) return;
  testMode = on;
  if (testMode) {
    // Switch live from real GPS to manual test control.
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
    displaySpeedMps = 0;
    statusMessageEl.textContent = "Waiting for GPS…";
    startTracking();
  }
  applyTestModeUI();
}

// Hold the dial for 3 seconds to switch test mode on or off.
const LONG_PRESS_MS = 3000;
let longPressTimer = null;
const dialWrap = document.querySelector(".dial-wrap");
function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
}
dialWrap.addEventListener("pointerdown", () => {
  cancelLongPress();
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    setTestMode(!testMode);
  }, LONG_PRESS_MS);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) dialWrap.addEventListener(type, cancelLongPress);
// No copy / select / share callouts anywhere in the app.
for (const type of ["contextmenu", "selectstart", "dragstart"]) {
  document.addEventListener(type, (e) => e.preventDefault());
}

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

// AudioContext needs a user gesture to unlock. Keep retrying on every gesture
// until the context is actually running (iOS Safari varies on which gesture it
// accepts), and re-arm if the OS suspends it again after backgrounding.
for (const type of ["pointerdown", "touchend", "click", "keydown"]) {
  document.addEventListener(type, () => ensureAudioCtx());
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && audioCtx && audioCtx.state !== "running") {
    audioCtx.resume().catch(() => {});
  }
});

buildDial();
initControls();
applyTestModeUI();
restartAnnounceTimer();
statusMessageEl.textContent = "Waiting for GPS…";

if (!testMode && !("geolocation" in navigator)) {
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
