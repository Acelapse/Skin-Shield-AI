// Pure detection logic: no DOM, no MediaPipe. Takes normalized landmarks
// (x, y in 0..1 image space) and decides whether a hand is picking at the face.
// Kept framework-free so it can be unit tested in Node.

// MediaPipe FaceMesh face-oval contour, in order around the face.
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

// Reference points used to label which part of the face is being touched. The
// touch is given the area of the nearest single landmark. "Left" and "right" are
// the person's own sides: their right cheek is on the left of the camera image.
export const FACE_ZONES = {
  forehead: [10, 151, 9, 108, 337, 67, 297],
  nose: [1, 4, 5, 195, 48, 278],
  "right cheek": [234, 50, 101, 205, 117, 123],
  "left cheek": [454, 280, 330, 425, 346, 352],
  mouth: [13, 14, 0, 17, 61, 291],
  chin: [152, 199, 175, 200, 18],
  jaw: [172, 136, 150, 397, 365, 379],
};

// Every face landmark the detector reads. Recordings store only these.
export const FACE_POINTS_USED = [...new Set([...FACE_OVAL, ...Object.values(FACE_ZONES).flat(), 234, 454, 10, 152])].sort((a, b) => a - b);

// Hand landmark indices.
export const HAND = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
};

export const DEFAULT_SETTINGS = {
  // How close (as a fraction of face width) a fingertip must be to the face outline.
  proximity: 0.12,
  // How long (ms) the picking posture must persist before alerting.
  dwellMs: 1500,
  // Short dropouts (ms) that do not reset the dwell timer (tracking flicker).
  graceMs: 400,
  // Quiet time (ms) after an alert before another one can fire.
  cooldownMs: 8000,
  // Require a pinch (thumb meeting another finger) for a "picking" posture.
  requirePinch: true,
  // Count touches around the mouth (nail biting). Off avoids eating/drinking alerts.
  includeMouth: true,
  // Minimum score (0..1) to count a frame as suspicious.
  threshold: 0.55,
};

// Maps the app's user-facing settings to detector settings. Shared by the app and
// the evaluation script so both score recordings identically.
export function settingsFor({ sensitivity = 6, dwell = 1.5, cooldown = 10, includeMouth = true, requirePinch = true } = {}) {
  return {
    ...DEFAULT_SETTINGS,
    threshold: 0.85 - (sensitivity - 1) * 0.055,
    proximity: 0.06 + (sensitivity - 1) * 0.015,
    dwellMs: dwell * 1000,
    cooldownMs: cooldown * 1000,
    includeMouth,
    requirePinch,
  };
}

// The face model can lose the face while a hand covers it. While hands are in
// view, keep using the last face seen for a short while.
export class FaceMemory {
  constructor(memoryMs = 1500) {
    this.memoryMs = memoryMs;
    this.reset();
  }

  reset() {
    this.face = null;
    this.at = 0;
  }

  update(face, handsInView, now) {
    if (face) {
      this.face = face;
      this.at = now;
      return face;
    }
    return this.face && handsInView && now - this.at < this.memoryMs ? this.face : null;
  }
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Signed distance to polygon edge: negative inside, positive outside.
export function signedDistToPolygon(p, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, distToSegment(p, poly[j], poly[i]));
  }
  return pointInPolygon(p, poly) ? -d : d;
}

// Landmarks come in normalized coordinates, but the image is usually not square.
// Scale x by the aspect ratio so distances are isotropic.
function toPixelSpace(points, aspect) {
  return points.map((p) => ({ x: p.x * aspect, y: p.y }));
}

export function describeFace(faceLandmarks, aspect = 1) {
  const pts = toPixelSpace(faceLandmarks, aspect);
  const oval = FACE_OVAL.map((i) => pts[i]);
  const width = dist(pts[234], pts[454]);
  const height = dist(pts[10], pts[152]);
  const zones = {};
  for (const [name, idx] of Object.entries(FACE_ZONES)) zones[name] = idx.map((i) => pts[i]);
  return { oval, width, height, zones, pts };
}

export function nearestZone(p, face) {
  let best = null;
  let bestD = Infinity;
  for (const [name, points] of Object.entries(face.zones)) {
    for (const c of points) {
      const d = dist(p, c);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
  }
  return best;
}

// Score one hand against one face. Returns { score, zone, tip, reasons }.
// `fidget` (0..1) is how much the fingertip has been moving in small, rubbing
// motions recently (see MotionMeter). A still hand resting on the chin is not
// picking; a fingertip working at one spot is.
export function scoreHand(handLandmarks, face, settings = DEFAULT_SETTINGS, aspect = 1, fidget = 0) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const h = toPixelSpace(handLandmarks, aspect);
  const fw = face.width || 1e-6;

  // 1. Posture. Picking and squeezing is done with the thumb against the index
  // or middle finger, so the pinch point is where the skin is being worked.
  const palm = dist(h[HAND.WRIST], h[HAND.MIDDLE_MCP]) || 1e-6;
  const pairs = [HAND.INDEX_TIP, HAND.MIDDLE_TIP].map((f) => ({ f, gap: dist(h[HAND.THUMB_TIP], h[f]) }));
  const pair = pairs[0].gap <= pairs[1].gap ? pairs[0] : pairs[1];
  const pinchGap = pair.gap / palm;
  const pinch = Math.max(0, Math.min(1, (0.55 - pinchGap) / 0.35));

  // 2. Contact point and proximity to the face outline.
  let tip;
  let edge;
  if (pinch >= 0.5) {
    const a = h[HAND.THUMB_TIP];
    const b = h[pair.f];
    tip = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    edge = signedDistToPolygon(tip, face.oval) / fw;
  } else {
    // Fingertip that is most clearly on the face (ring/pinky rarely pick).
    edge = Infinity;
    for (const i of [HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.THUMB_TIP]) {
      const d = signedDistToPolygon(h[i], face.oval) / fw;
      if (d < edge) {
        edge = d;
        tip = h[i];
      }
    }
  }
  const best = { d: edge };
  // 1.0 inside the face, fading to 0 at `proximity` outside.
  const proximity = best.d <= 0 ? 1 : Math.max(0, 1 - best.d / s.proximity);

  // A single fingertip pressed on skin (scratching/squeezing with a nail) also
  // counts, but on its own stays below the default threshold; fidgeting pushes it over.
  const pointing = best.d <= 0.02 ? 0.45 + 0.55 * fidget : 0;

  // 3. Depth sanity check. With 2D video a hand waved in front of the camera can
  // overlap the face. A hand much larger than a face-depth hand is closer to the
  // lens than the face, so it is probably not touching it.
  const depthRatio = palm / fw; // ~0.5-0.9 when the hand is at the face's depth
  const depth = depthRatio > 1.6 ? 0 : depthRatio > 1.1 ? 1 - (depthRatio - 1.1) / 0.5 : 1;

  const zone = nearestZone(tip, face);
  const posture = s.requirePinch ? Math.max(pinch, pointing) : Math.max(pinch, 0.8);
  let score = proximity * posture * depth;
  if (zone === "mouth" && !s.includeMouth) score = 0;

  return {
    score,
    zone,
    tip: { x: tip.x / aspect, y: tip.y },
    reasons: { proximity, pinch, pointing, fidget, depth, depthRatio, edgeDist: best.d },
  };
}

// Measures small repetitive fingertip movement (scratching, rubbing, squeezing)
// near the face, normalized by face width so it is independent of distance.
export class MotionMeter {
  constructor(windowMs = 1200) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  push(tip, faceWidth, now) {
    this.samples.push({ x: tip.x / faceWidth, y: tip.y / faceWidth, t: now });
    while (this.samples.length && now - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }

  // 0 when still, rising for small back-and-forth motion, 0 again for big sweeps
  // (a hand passing by or waving is not fidgeting).
  get level() {
    const n = this.samples.length;
    if (n < 4) return 0;
    let path = 0;
    for (let i = 1; i < n; i++) {
      path += Math.hypot(this.samples[i].x - this.samples[i - 1].x, this.samples[i].y - this.samples[i - 1].y);
    }
    const net = Math.hypot(this.samples[n - 1].x - this.samples[0].x, this.samples[n - 1].y - this.samples[0].y);
    const secs = Math.max(0.1, (this.samples[n - 1].t - this.samples[0].t) / 1000);
    const speed = path / secs; // face-widths per second
    if (net > 0.5) return 0; // travelling, not working at one spot
    const wiggle = path > 0 ? 1 - net / path : 0; // 1 = back-and-forth
    const activity = speed < 0.03 ? 0 : Math.min(1, (speed - 0.03) / 0.25);
    const tooFast = speed > 2.5 ? 0 : 1;
    return Math.max(0, Math.min(1, activity * (0.4 + 0.6 * wiggle) * tooFast));
  }
}

// Evaluate a whole frame: best-scoring hand against the face.
export function evaluateFrame(faceLandmarks, handsLandmarks, settings, aspect = 1, motion = null, now = 0) {
  if (!faceLandmarks || !handsLandmarks?.length) {
    motion?.clear();
    return { score: 0, zone: null, hands: [] };
  }
  const face = describeFace(faceLandmarks, aspect);
  let fidget = 0;
  if (motion) {
    // Follow the fingertip of whichever hand is closest to the face.
    const first = handsLandmarks.map((h) => scoreHand(h, face, settings, aspect));
    const closest = first.reduce((a, b) => (b.reasons.edgeDist < a.reasons.edgeDist ? b : a));
    if (closest.reasons.edgeDist < 0.2) {
      motion.push({ x: closest.tip.x * aspect, y: closest.tip.y }, face.width, now);
      fidget = motion.level;
    } else {
      motion.clear();
    }
  }
  const hands = handsLandmarks.map((h) => scoreHand(h, face, settings, aspect, fidget));
  const top = hands.reduce((a, b) => (b.score > a.score ? b : a), hands[0]);
  return { score: top.score, zone: top.zone, tip: top.tip, hands, face };
}

// Debounces frame-level scores into discrete "picking episode" alerts.
export class PickingTracker {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.reset();
  }

  update(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  reset() {
    this.since = null; // when the current suspicious streak began
    this.lastHit = null; // last suspicious frame time
    this.lastAlert = -Infinity;
    this.zones = {};
    this.state = "idle";
  }

  // Feed one frame. Returns { state, progress, alert, zone }.
  push(score, zone, now) {
    const s = this.settings;
    const hit = score >= s.threshold;

    if (hit) {
      if (this.since === null || now - this.lastHit > s.graceMs) {
        this.since = now;
        this.zones = {};
      }
      this.lastHit = now;
      if (zone) this.zones[zone] = (this.zones[zone] || 0) + 1;
    } else if (this.since !== null && now - this.lastHit > s.graceMs) {
      this.since = null;
    }

    const coolingDown = now - this.lastAlert < s.cooldownMs;
    const held = this.since === null ? 0 : now - this.since;
    const progress = this.since === null ? 0 : Math.min(1, held / s.dwellMs);
    let alert = null;

    if (this.since !== null && held >= s.dwellMs && !coolingDown) {
      const mainZone = Object.entries(this.zones).sort((a, b) => b[1] - a[1])[0]?.[0] || zone;
      alert = { zone: mainZone, durationMs: held, at: now };
      this.lastAlert = now;
      // Keep the streak alive but require another full dwell after cooldown.
      this.since = now;
      this.zones = {};
    }

    this.state = alert ? "alert" : coolingDown ? "cooldown" : this.since !== null ? "suspect" : "idle";
    return { state: this.state, progress: coolingDown && !alert ? 0 : progress, alert, zone };
  }
}
