// Recording format and replay. Pure code, shared by the app (which records) and
// scripts/evaluate.js (which replays recordings to measure accuracy).
//
// A recording holds the tracking points MediaPipe found in each frame, never
// the video. Only the face points the detector reads are kept, which makes a
// 30 second clip roughly 1 MB of JSON instead of several.

import { evaluateFrame, FaceMemory, FACE_POINTS_USED, MotionMeter, PickingTracker } from "./detector.js";

export const FORMAT = "skinshield-recordings";
export const VERSION = 1;

export const LABELS = [
  { id: "picking", name: "Picking or squeezing", expected: "alert" },
  { id: "scratching", name: "Scratching one spot", expected: "alert" },
  { id: "nail-biting", name: "Nail biting", expected: "alert" },
  { id: "resting", name: "Resting chin or cheek on hand", expected: "no-alert" },
  { id: "eyes", name: "Rubbing eyes", expected: "no-alert" },
  { id: "eating", name: "Eating or drinking", expected: "no-alert" },
  { id: "hair-glasses", name: "Touching hair or glasses", expected: "no-alert" },
  { id: "gesturing", name: "Talking with hands", expected: "no-alert" },
  { id: "phone", name: "Phone call", expected: "no-alert" },
  { id: "skincare", name: "Skincare or shaving", expected: "no-alert" },
  { id: "working", name: "Normal work, hands away", expected: "no-alert" },
];

export const AREAS = ["forehead", "nose", "right cheek", "left cheek", "mouth", "chin", "jaw"];

export const labelInfo = (id) => LABELS.find((l) => l.id === id) || { id, name: id, expected: "no-alert" };

const r4 = (v) => Math.round(v * 1e4) / 1e4;

// One frame -> compact form. `face` is the raw face model output for the frame
// (or null), `hands` the hand model output. Times are ms from clip start.
export function packFrame(t, face, hands) {
  return {
    t: Math.round(t),
    f: face ? FACE_POINTS_USED.flatMap((i) => [r4(face[i].x), r4(face[i].y)]) : null,
    h: (hands || []).map((hand) => hand.flatMap((p) => [r4(p.x), r4(p.y), r4(p.z ?? 0)])),
  };
}

// Compact form -> landmark arrays shaped like MediaPipe output.
export function unpackFrame(frame, faceIndices = FACE_POINTS_USED) {
  let face = null;
  if (frame.f) {
    face = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
    faceIndices.forEach((idx, k) => (face[idx] = { x: frame.f[2 * k], y: frame.f[2 * k + 1], z: 0 }));
  }
  const hands = (frame.h || []).map((flat) => {
    const pts = [];
    for (let i = 0; i < flat.length; i += 3) pts.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
    return pts;
  });
  return { face, hands };
}

// Runs a clip through the same pipeline as the live app. Returns the alerts the
// detector would have raised, with times relative to the start of the clip.
// With `explain`, also summarises which signals were behind the flagged frames.
export function replayClip(clip, settings, { explain = false } = {}) {
  const memory = new FaceMemory();
  const motion = new MotionMeter();
  const tracker = new PickingTracker(settings);
  const alerts = [];
  let peak = 0;
  const ex = explain ? { frames: 0, withFace: 0, withHands: 0, flagged: 0, byPinch: 0, sums: {} } : null;
  const add = (k, v) => (ex.sums[k] = (ex.sums[k] || 0) + v);
  for (const frame of clip.frames) {
    const { face: raw, hands } = unpackFrame(frame, clip.faceIndices);
    const face = memory.update(raw, hands.length > 0, frame.t);
    const result = evaluateFrame(face, hands, settings, clip.aspect || 4 / 3, motion, frame.t);
    peak = Math.max(peak, result.score);
    const out = tracker.push(result.score, result.zone, frame.t);
    if (out.alert) alerts.push({ t: frame.t, zone: out.alert.zone });
    if (ex) {
      ex.frames++;
      if (raw) ex.withFace++;
      if (hands.length) ex.withHands++;
      if (result.score >= settings.threshold) {
        const i = result.hands.indexOf(result.hands.reduce((a, b) => (b.score > a.score ? b : a)));
        const r = result.hands[i].reasons;
        const h = hands[i];
        const aspect = clip.aspect || 4 / 3;
        const d2 = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
        const d3 = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect);
        const palm = d2(h[0], h[9]) || 1e-6;
        ex.flagged++;
        if (r.pinch >= r.pointing) ex.byPinch++;
        add("pinch", r.pinch);
        add("fidget", r.fidget);
        add("inside", -r.edgeDist);
        add("depthRatio", r.depthRatio);
        add("gap2d", Math.min(d2(h[4], h[8]), d2(h[4], h[12])) / palm);
        add("gap3d", Math.min(d3(h[4], h[8]), d3(h[4], h[12])) / palm);
        // How spread the four fingertips are: bunched (fist, resting) vs open.
        add("spread", (d2(h[8], h[20]) + d2(h[8], h[16])) / 2 / palm);
        add(`zone:${result.zone}`, 1);
      }
    }
  }
  if (ex) {
    ex.mean = {};
    for (const [k, v] of Object.entries(ex.sums)) ex.mean[k] = ex.flagged ? v / ex.flagged : null;
  }
  return { alerts, peakScore: peak, explain: ex };
}

// Scores a set of clips at one group of settings.
export function evaluateClips(clips, settings) {
  const rows = clips.map((clip) => {
    const { alerts, peakScore } = replayClip(clip, settings);
    const expected = clip.expected || labelInfo(clip.label).expected;
    const alerted = alerts.length > 0;
    return {
      clip,
      expected,
      alerts,
      peakScore,
      correct: expected === "alert" ? alerted : !alerted,
      firstAlertMs: alerted ? alerts[0].t : null,
      zoneMatch: clip.area && alerted ? alerts.some((a) => a.zone === clip.area) : null,
    };
  });
  const pos = rows.filter((r) => r.expected === "alert");
  const neg = rows.filter((r) => r.expected !== "alert");
  const caught = pos.filter((r) => r.alerts.length > 0);
  const negHours = neg.reduce((s, r) => s + (r.clip.durationMs || 0), 0) / 3.6e6;
  const falseAlarms = neg.reduce((s, r) => s + r.alerts.length, 0);
  const times = caught.map((r) => r.firstAlertMs).sort((a, b) => a - b);
  const withArea = caught.filter((r) => r.zoneMatch !== null);
  return {
    rows,
    positives: pos.length,
    negatives: neg.length,
    catchRate: pos.length ? caught.length / pos.length : null,
    falseAlarms,
    falseAlarmClips: neg.filter((r) => r.alerts.length > 0).length,
    falseAlarmsPerHour: negHours > 0 ? falseAlarms / negHours : null,
    medianTimeToAlertMs: times.length ? times[Math.floor(times.length / 2)] : null,
    areaAccuracy: withArea.length ? withArea.filter((r) => r.zoneMatch).length / withArea.length : null,
  };
}

export function makeDataset(clips) {
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), clips };
}

// Accepts a dataset file, a single clip, or a plain array of clips.
export function parseDataset(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const clips = Array.isArray(data) ? data : data?.format === FORMAT ? data.clips : data?.frames ? [data] : null;
  if (!Array.isArray(clips)) throw new Error("Not a SkinShield recordings file");
  for (const c of clips) {
    if (!c || !Array.isArray(c.frames) || typeof c.label !== "string") throw new Error("A clip in this file is missing its label or frames");
  }
  return clips;
}
