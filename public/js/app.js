import { evaluateFrame, FaceMemory, MotionMeter, PickingTracker, FACE_OVAL, settingsFor } from "./detector.js";
import { createRecorder } from "./recorder.js";
import { createLearner } from "./learner.js";
import { chime, closeNotification, flashTitle, message, notify, requestNotifications, alarmSounding, startAlarm, stopAlarm, stopFlashing, unlockAudio } from "./alerts.js";
import { createFrameSource } from "./framesource.js";
import { Stats, formatAgo } from "./stats.js";

const VISION_VERSION = "1.2.2";
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODELS = {
  hand: ["models/hand_landmarker.task", "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"],
  face: ["models/face_landmarker.task", "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"],
};
const TARGET_FPS = 15;
const SETTINGS_KEY = "skinshield.settings.v1";

const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const g = canvas.getContext("2d");
const frameSource = createFrameSource(video);

const stats = new Stats();
const motion = new MotionMeter();
const tracker = new PickingTracker();
const faceMemory = new FaceMemory();

const prefs = loadPrefs();
let handLandmarker = null;
let faceLandmarker = null;
let running = false;
let paused = false;
let snoozeUntil = 0;
let alertOpen = false;
let currentEventId = null;
let ticker = null;
let frames = 0;
let totalFrames = 0; // frames analysed since start (used by tests)
let fpsAt = performance.now();

// ---------- settings ----------

function loadPrefs() {
  const defaults = {
    sensitivity: 6,
    spreadMin: 0.4,
    dwell: 1.5,
    cooldown: 10,
    sound: true,
    notify: true,
    includeMouth: true,
    requirePinch: true,
    showOverlay: true,
    learn: true,
    autoLearn: true,
    anyTouch: false,
    persistentAlarm: true,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

// Sensitivity 1..10 trades false alarms against missed episodes.
const detectorSettings = () => settingsFor(prefs);

const settingRenders = [];

// Puts saved values into the settings controls (also used after learning
// changes a setting).
function syncSettingsForm() {
  for (const form of [$("settings"), $("learnSettings")]) {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") el.checked = !!prefs[el.name];
      else el.value = prefs[el.name];
    }
  }
  settingRenders.forEach((r) => r());
  syncAnyTouch();
}

// In any-touch mode the picking-specific options don't apply, so grey them out.
function syncAnyTouch() {
  for (const name of ["sensitivity", "dwell", "includeMouth", "requirePinch"]) {
    const el = $("settings").elements[name];
    el.disabled = prefs.anyTouch;
    el.closest("label").classList.toggle("is-disabled", prefs.anyTouch);
  }
  $("anyTouchNote").hidden = !prefs.anyTouch;
}

function bindSettings() {
  const labels = {
    sensitivity: (v) => (v <= 3 ? "Low: fewer false alarms" : v >= 8 ? "High: catches more, may misfire" : "Balanced"),
    dwell: (v) => `${v} s of picking`,
    cooldown: (v) => `${v} s`,
  };
  for (const form of [$("settings"), $("learnSettings")]) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const out = form.querySelector(`[data-for="${el.name}"]`);
      const render = () => out && (out.textContent = labels[el.name](Number(el.value)));
      settingRenders.push(render);
      el.addEventListener("input", async () => {
        prefs[el.name] = el.type === "checkbox" ? el.checked : Number(el.value);
        render();
        savePrefs();
        tracker.update(detectorSettings());
        if (el.name === "anyTouch") {
          syncAnyTouch();
          tracker.reset();
          motion.clear();
        }
        learner?.render();
        if (el.name === "notify" && el.checked) await requestNotifications();
      });
    }
  }
  syncSettingsForm();
  const show = $("showOverlay");
  show.checked = prefs.showOverlay;
  show.addEventListener("change", () => {
    prefs.showOverlay = show.checked;
    savePrefs();
    if (!show.checked) g.clearRect(0, 0, canvas.width, canvas.height);
  });
  tracker.update(detectorSettings());
}

// ---------- model loading ----------

async function firstAvailable(urls) {
  for (const url of urls) {
    if (!url.startsWith("http")) {
      try {
        const r = await fetch(url, { method: "HEAD" });
        if (r.ok) return url;
      } catch {
        /* try next */
      }
    } else {
      return url;
    }
  }
  return urls[urls.length - 1];
}

async function loadVision() {
  // Prefer the copy served from node_modules by server.js, fall back to the CDN.
  try {
    const mod = await import("/vendor/tasks-vision/vision_bundle.mjs");
    return { mod, wasm: "/vendor/tasks-vision/wasm" };
  } catch {
    const mod = await import(`${CDN}/vision_bundle.mjs`);
    return { mod, wasm: `${CDN}/wasm` };
  }
}

async function createModels(setMsg) {
  setMsg("Loading the vision engine...");
  const { mod, wasm } = await loadVision();
  const fileset = await mod.FilesetResolver.forVisionTasks(wasm);
  const [handUrl, faceUrl] = await Promise.all([firstAvailable(MODELS.hand), firstAvailable(MODELS.face)]);
  setMsg("Loading hand and face models (first run downloads about 8 MB)...");

  const make = async (delegate) =>
    Promise.all([
      mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: handUrl, delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      mod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: faceUrl, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ]);

  try {
    [handLandmarker, faceLandmarker] = await make("GPU");
  } catch (err) {
    console.warn("GPU delegate unavailable, using CPU", err);
    [handLandmarker, faceLandmarker] = await make("CPU");
  }
}

// ---------- camera + loop ----------

function stopCamera() {
  frameSource.stop();
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

// Opens the chosen camera, or the default one if none was chosen or the saved
// one is no longer plugged in.
async function startCamera(deviceId = prefs.cameraId) {
  const base = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  stopCamera();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    const missing = ["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(err?.name);
    if (!deviceId || !missing) throw err;
    console.warn("Saved camera unavailable, using the default one", err);
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: "user" }, audio: false });
  }
  video.srcObject = stream;
  await video.play();
  frameSource.start(stream);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const actual = stream.getVideoTracks()[0]?.getSettings().deviceId;
  if (actual) {
    prefs.cameraId = actual;
    savePrefs();
  }
  await listCameras();
}

// Device names are only revealed after camera permission is granted, so this
// runs again once the camera is open and whenever a camera is plugged in or out.
async function listCameras() {
  const select = $("cameraSelect");
  let cams = [];
  try {
    cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    /* keep the default entry */
  }
  const current = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId || prefs.cameraId || "";
  select.replaceChildren(
    ...(cams.length ? cams : [{ deviceId: "", label: "Default camera" }]).map((c, i) => {
      const opt = document.createElement("option");
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${i + 1}`;
      return opt;
    }),
  );
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  select.disabled = switching || cams.length < 2;
}

let switching = false;

async function switchCamera(deviceId) {
  if (switching) return;
  prefs.cameraId = deviceId;
  savePrefs();
  if (!running) return; // used on the next Start
  recorder.cancel(); // a clip must come from one camera
  switching = true;
  $("cameraSelect").disabled = true;
  setStatus("Switching camera...", "off");
  try {
    await startCamera(deviceId);
  } catch (err) {
    console.error(err);
    setStatus("Couldn't open that camera", "warn");
    try {
      await startCamera("");
    } catch {
      /* nothing else to fall back to */
    }
  } finally {
    // Start fresh: tracking from the old camera means nothing for the new view.
    tracker.reset();
    motion.clear();
    faceMemory.reset();
    g.clearRect(0, 0, canvas.width, canvas.height);
    switching = false;
    await listCameras();
  }
}

// Timers in a worker keep firing when this tab is in the background, unlike
// requestAnimationFrame, so detection keeps running while you work elsewhere.
// The loop is self-paced: the next tick is only requested once a frame is done,
// so a slow machine drops frames instead of piling up work.
function startTicker(fn) {
  const src = `let id;onmessage=e=>{clearTimeout(id);if(e.data>=0)id=setTimeout(()=>postMessage(0),e.data)}`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const interval = 1000 / TARGET_FPS;
  worker.onmessage = () => {
    const t0 = performance.now();
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
    if (running) worker.postMessage(Math.max(4, Math.round(interval - (performance.now() - t0))));
  };
  worker.postMessage(0);
  return worker;
}

let frameNo = 0;
let lastFaces = { faceLandmarks: [] };

function tick() {
  if (!running || switching) return;
  const image = frameSource.next();
  if (!image) return;
  const now = performance.now();

  const hands = handLandmarker.detectForVideo(image, now);
  // Faces move slowly compared to fingers; tracking them every other frame
  // roughly halves the cost with no visible loss.
  if (frameNo++ % 2 === 0 || !faceMemory.face) lastFaces = faceLandmarker.detectForVideo(image, now);
  const rawFace = lastFaces.faceLandmarks?.[0] || null;
  const face = faceMemory.update(rawFace, hands.landmarks?.length > 0, now);

  const aspect = video.videoWidth / video.videoHeight || 4 / 3;
  // While recording a test clip the detector always runs, but alerts are only
  // noted in the clip, not shown, so they don't interrupt the recording.
  const recording = recorder.recording;
  const active = recording || (!paused && now >= snoozeUntil && !alertOpen);
  const result = evaluateFrame(face, hands.landmarks, detectorSettings(), aspect, motion, now);
  const out = active ? tracker.push(result.score, result.zone, now) : { state: "idle", progress: 0, alert: null };
  recorder.captureFrame(now, rawFace, hands.landmarks, out.alert);
  learner.captureFrame(now, rawFace, hands.landmarks);
  if (recording) out.alert = null;

  if (out.alert) {
    raiseAlert(out.alert);
    learner.onAlert(now);
  }
  $("meterFill").style.width = `${Math.round(out.progress * 100)}%`;
  updateStatus(face, out.state);
  if (!document.hidden) draw(face, hands.landmarks, result, out);

  frames++;
  totalFrames++;
  if (now - fpsAt > 1000) {
    $("fps").textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps`;
    frames = 0;
    fpsAt = now;
  }
}

// ---------- drawing ----------

const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function draw(face, hands, result, out) {
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  if (!prefs.showOverlay) return;
  const hot = out.state === "suspect" || out.state === "alert";

  if (face) {
    g.beginPath();
    FACE_OVAL.forEach((i, k) => (k ? g.lineTo(face[i].x * W, face[i].y * H) : g.moveTo(face[i].x * W, face[i].y * H)));
    g.closePath();
    g.strokeStyle = hot ? "rgba(240,138,93,0.95)" : "rgba(92,191,169,0.8)";
    g.lineWidth = 2;
    g.stroke();
  }

  (hands || []).forEach((hand, n) => {
    const score = result.hands?.[n]?.score ?? 0;
    g.strokeStyle = score >= detectorSettings().threshold ? "rgba(240,138,93,0.95)" : "rgba(255,255,255,0.6)";
    g.lineWidth = 2;
    for (const [a, b] of HAND_LINKS) {
      g.beginPath();
      g.moveTo(hand[a].x * W, hand[a].y * H);
      g.lineTo(hand[b].x * W, hand[b].y * H);
      g.stroke();
    }
    g.fillStyle = "white";
    for (const p of hand) {
      g.beginPath();
      g.arc(p.x * W, p.y * H, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  });

  if (hot && result.tip) {
    g.beginPath();
    g.arc(result.tip.x * W, result.tip.y * H, 14 + 10 * out.progress, 0, Math.PI * 2);
    g.strokeStyle = "rgba(240,138,93,0.9)";
    g.lineWidth = 3;
    g.stroke();
  }
}

// ---------- status + alerts ----------

let breathTimer = null;

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

function updateStatus(face, state) {
  if (paused) return setStatus("Paused", "off");
  if (performance.now() < snoozeUntil) return setStatus("Snoozed", "off");
  if (state === "suspect") return setStatus("Hands near face...", "warn");
  if (!face) return setStatus("Looking for your face", "off");
  setStatus("Watching", "on");
}

function raiseAlert({ zone, durationMs }) {
  const text = message(zone);
  const event = stats.add({ at: Date.now(), zone, durationMs: Math.round(durationMs) });
  currentEventId = event.id;
  renderStats();

  // With "Keep alarming", the alarm, notification and flashing title carry on
  // until the alert is answered, even with the window minimized.
  const keepGoing = prefs.persistentAlarm;
  if (prefs.sound) keepGoing ? startAlarm() : chime();
  if (prefs.notify && (keepGoing || document.hidden)) notify("Picking detected", keepGoing ? `${text} Open SkinShield to stop the alarm.` : text, { persistent: keepGoing });
  if (keepGoing || document.hidden) flashTitle("Hands down!", { untilStopped: keepGoing });
  $("alarmHint").hidden = !keepGoing;

  $("alertBody").textContent = text;
  $("alertMain").hidden = false;
  $("breath").hidden = true;
  $("alert").hidden = false;
  $("viewport").classList.add("alerting");
  alertOpen = true;
  $("okBtn").focus();
}

// Stops the alarm sound, notification and flashing title.
function silence() {
  stopAlarm();
  stopFlashing();
  closeNotification();
}

function closeAlert() {
  silence();
  clearInterval(breathTimer);
  $("alert").hidden = true;
  $("viewport").classList.remove("alerting");
  alertOpen = false;
  tracker.reset();
  tracker.lastAlert = performance.now(); // give a fresh cooldown after dismissing
  motion.clear();
}

function breathe() {
  silence();
  $("alertMain").hidden = true;
  $("breath").hidden = false;
  const circle = $("circle");
  const text = $("breathText");
  let phase = 0;
  const steps = 8; // 4s in, 4s out, x4 ≈ 32s
  const step = () => {
    if (phase >= steps) {
      clearInterval(breathTimer);
      text.textContent = "Nice work.";
      setTimeout(closeAlert, 1500);
      return;
    }
    const inhale = phase % 2 === 0;
    circle.classList.toggle("in", inhale);
    text.textContent = inhale ? "Breathe in" : "Breathe out";
    phase++;
  };
  step();
  breathTimer = setInterval(step, 4000);
}

// ---------- stats panel ----------

function renderStats() {
  const s = stats.summary();
  $("todayCount").textContent = s.todayCount;
  $("sinceLast").textContent = s.lastAt ? formatAgo(Date.now() - s.lastAt) : "--";
  $("topZone").textContent = s.zones[0]?.[0] || "--";

  const max = Math.max(1, ...s.zones.map((z) => z[1]));
  $("zones").innerHTML = s.zones.length
    ? s.zones.map(([z, n]) => `<li><span class="z">${z}</span><span class="bar"><span style="width:${(n / max) * 100}%"></span></span><span class="n">${n}</span></li>`).join("")
    : `<li class="hint">Nothing today. Keep it up.</li>`;

  const wmax = Math.max(1, ...s.week.map((d) => d.count));
  $("week").innerHTML = s.week
    .map((d) => `<div class="day${d.today ? " today" : ""}" title="${d.count} episodes"><span>${d.count || ""}</span><div class="col" style="height:${(d.count / wmax) * 70}%"></div><span>${d.label}</span></div>`)
    .join("");

  $("events").innerHTML = s.recent.length
    ? s.recent
        .map((e) => `<li><span class="z">${e.zone || "face"}</span><span class="hint">${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></li>`)
        .join("")
    : `<li class="empty">No episodes yet.</li>`;
}

// ---------- wiring ----------

$("startBtn").addEventListener("click", async () => {
  const btn = $("startBtn");
  const msg = (t) => ($("loadMsg").textContent = t);
  btn.disabled = true;
  unlockAudio();
  if (prefs.notify) requestNotifications();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't access the camera. Open the app over http://localhost or https.");
    msg("Asking for camera access...");
    await startCamera();
    if (!handLandmarker) await createModels(msg);
    $("placeholder").hidden = true;
    running = true;
    ticker = startTicker(tick);
    $("pauseBtn").disabled = false;
    $("snoozeBtn").disabled = false;
    recorder.setEnabled(true);
    learner.setRunning(true);
    setStatus("Watching", "on");
  } catch (err) {
    console.error(err);
    const denied = err?.name === "NotAllowedError";
    msg(denied ? "Camera access was blocked. Allow it in the address bar and try again." : `Couldn't start: ${err.message || err}`);
    btn.disabled = false;
  }
});

$("pauseBtn").addEventListener("click", () => {
  paused = !paused;
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  tracker.reset();
  setStatus(paused ? "Paused" : "Watching", paused ? "off" : "on");
});

$("snoozeBtn").addEventListener("click", () => {
  const snoozed = performance.now() < snoozeUntil;
  snoozeUntil = snoozed ? 0 : performance.now() + 15 * 60e3;
  $("snoozeBtn").textContent = snoozed ? "Snooze 15 min" : "End snooze";
  tracker.reset();
});

$("okBtn").addEventListener("click", () => {
  learner.onAnswer("confirmed");
  closeAlert();
});
$("breatheBtn").addEventListener("click", () => {
  learner.onAnswer("confirmed");
  breathe();
});
$("falseBtn").addEventListener("click", () => {
  learner.onAnswer("false-alarm");
  if (currentEventId) stats.markFalseAlarm(currentEventId);
  renderStats();
  closeAlert();
});
$("alert").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAlert();
});

$("clearBtn").addEventListener("click", () => {
  if (confirm("Delete all saved episode history on this device?")) {
    stats.clear();
    renderStats();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) g.clearRect(0, 0, canvas.width, canvas.height);
});

$("cameraSelect").addEventListener("change", (e) => switchCamera(e.target.value));

let learner = null;

const recorder = createRecorder({
  onChange: () => learner?.onClipsChanged(),
  getContext: () => ({
    running,
    prefs: { ...prefs },
    settings: { sensitivity: prefs.sensitivity, spreadMin: prefs.spreadMin, dwell: prefs.dwell, cooldown: prefs.cooldown, includeMouth: prefs.includeMouth, requirePinch: prefs.requirePinch, anyTouch: prefs.anyTouch },
    aspect: video.videoWidth / video.videoHeight || 4 / 3,
    camera: $("cameraSelect").selectedOptions[0]?.textContent || "",
  }),
  onStart: () => {
    tracker.reset();
    motion.clear();
    faceMemory.reset();
  },
  // Don't let picking-like moves acted out for a clip trigger a real alert right after.
  onStop: () => {
    tracker.reset();
    motion.clear();
  },
});
navigator.mediaDevices?.addEventListener?.("devicechange", listCameras);

learner = createLearner({
  getPrefs: () => ({ ...prefs }),
  applyPrefs: (patch) => {
    Object.assign(prefs, patch);
    savePrefs();
    syncSettingsForm();
    tracker.update(detectorSettings());
    learner.render();
  },
  getContext: () => ({
    aspect: video.videoWidth / video.videoHeight || 4 / 3,
    camera: $("cameraSelect").selectedOptions[0]?.textContent || "",
    settings: { sensitivity: prefs.sensitivity, spreadMin: prefs.spreadMin, dwell: prefs.dwell, cooldown: prefs.cooldown, includeMouth: prefs.includeMouth, requirePinch: prefs.requirePinch, anyTouch: prefs.anyTouch },
  }),
  recorder,
});
learner.onClipsChanged();

// For automated tests only: open the app with ?debug to reach internals.
if (new URLSearchParams(location.search).has("debug")) window.skinshieldDebug = { learner, raiseAlert, prefs, frames: () => totalFrames, frameMode: () => frameSource.mode, alarmSounding };

bindSettings();
renderStats();
listCameras();
setInterval(renderStats, 30e3);
