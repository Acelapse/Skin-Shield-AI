import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  pointInPolygon,
  signedDistToPolygon,
  evaluateFrame,
  MotionMeter,
  PickingTracker,
  settingsFor,
} from "../public/js/detector.js";
import { makeFace, makeHand } from "./fixtures.js";

test("polygon helpers", () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  assert.ok(pointInPolygon({ x: 0.5, y: 0.5 }, sq));
  assert.ok(!pointInPolygon({ x: 1.5, y: 0.5 }, sq));
  assert.ok(Math.abs(signedDistToPolygon({ x: 0.5, y: 0.5 }, sq) + 0.5) < 1e-9);
  assert.ok(Math.abs(signedDistToPolygon({ x: 1.25, y: 0.5 }, sq) - 0.25) < 1e-9);
});

test("pinch on the cheek (image left) scores high and is labelled", () => {
  const face = makeFace();
  const r = evaluateFrame(face, [makeHand({ x: 0.44, y: 0.515 })], DEFAULT_SETTINGS);
  assert.ok(r.score > 0.8, `score ${r.score}`);
  assert.equal(r.zone, "right cheek");
});

test("cheeks are named from the person's point of view", () => {
  const r = evaluateFrame(makeFace(), [makeHand({ x: 0.56, y: 0.515 })], DEFAULT_SETTINGS);
  assert.equal(r.zone, "left cheek");
});

test("pinch on the chin is labelled chin", () => {
  const r = evaluateFrame(makeFace(), [makeHand({ x: 0.5, y: 0.62 })], DEFAULT_SETTINGS);
  assert.ok(r.score > 0.8);
  assert.equal(r.zone, "chin");
});

test("hand far from the face scores zero", () => {
  const r = evaluateFrame(makeFace(), [makeHand({ x: 0.9, y: 0.4 })], DEFAULT_SETTINGS);
  assert.equal(r.score, 0);
});

test("open hand resting on the face stays under threshold", () => {
  const r = evaluateFrame(makeFace(), [makeHand({ x: 0.46, y: 0.6 }, { pinch: false })], DEFAULT_SETTINGS);
  assert.ok(r.score < DEFAULT_SETTINGS.threshold, `score ${r.score}`);
});

test("hand much closer to the camera than the face is ignored", () => {
  // Palm 0.35 vs face width 0.2: hand is in front of the face, not on it.
  const r = evaluateFrame(makeFace(), [makeHand({ x: 0.45, y: 0.5 }, { palm: 0.35 })], DEFAULT_SETTINGS);
  assert.equal(r.score, 0);
});

test("mouth can be excluded", () => {
  const hand = [makeHand({ x: 0.5, y: 0.565 })];
  const on = evaluateFrame(makeFace(), hand, DEFAULT_SETTINGS);
  const off = evaluateFrame(makeFace(), hand, { ...DEFAULT_SETTINGS, includeMouth: false });
  assert.equal(on.zone, "mouth");
  assert.ok(on.score > 0.8);
  assert.equal(off.score, 0);
});

test("no face or no hands means no score", () => {
  assert.equal(evaluateFrame(null, [makeHand({ x: 0.5, y: 0.5 })]).score, 0);
  assert.equal(evaluateFrame(makeFace(), []).score, 0);
});

test("scratching with a single finger is caught through the motion meter", () => {
  const face = makeFace();
  const motion = new MotionMeter();
  let r;
  for (let i = 0; i < 30; i++) {
    const wobble = (i % 2 ? 1 : -1) * 0.012;
    r = evaluateFrame(face, [makeHand({ x: 0.45 + wobble, y: 0.52 }, { pinch: false })], DEFAULT_SETTINGS, 1, motion, i * 33);
  }
  assert.ok(r.score >= DEFAULT_SETTINGS.threshold, `scratch score ${r.score}`);

  const still = new MotionMeter();
  for (let i = 0; i < 30; i++) {
    r = evaluateFrame(face, [makeHand({ x: 0.45, y: 0.52 }, { pinch: false })], DEFAULT_SETTINGS, 1, still, i * 33);
  }
  assert.ok(r.score < DEFAULT_SETTINGS.threshold, `still score ${r.score}`);
});

test("tracker needs the posture to persist for dwellMs", () => {
  const t = new PickingTracker({ dwellMs: 1000, graceMs: 200, cooldownMs: 5000 });
  let out;
  for (let ms = 0; ms < 900; ms += 50) {
    out = t.push(0.9, "chin", ms);
    assert.equal(out.alert, null);
  }
  assert.equal(out.state, "suspect");
  out = t.push(0.9, "chin", 1000);
  assert.ok(out.alert);
  assert.equal(out.alert.zone, "chin");
});

test("brief tracking dropouts do not reset the timer, long ones do", () => {
  const t = new PickingTracker({ dwellMs: 1000, graceMs: 300 });
  for (let ms = 0; ms < 1000; ms += 50) {
    const flicker = ms >= 450 && ms <= 600; // 200ms with no detection
    assert.equal(t.push(flicker ? 0 : 0.9, flicker ? null : "nose", ms).alert, null);
  }
  assert.ok(t.push(0.9, "nose", 1000).alert, "flicker should not reset");

  const u = new PickingTracker({ dwellMs: 1000, graceMs: 300 });
  for (let ms = 0; ms < 1000; ms += 50) {
    const away = ms >= 300 && ms <= 800; // 550ms away
    u.push(away ? 0 : 0.9, away ? null : "nose", ms);
  }
  assert.equal(u.push(0.9, "nose", 1000).alert, null);
});

test("cooldown suppresses repeated alerts", () => {
  const t = new PickingTracker({ dwellMs: 500, graceMs: 200, cooldownMs: 3000 });
  let alerts = 0;
  for (let ms = 0; ms <= 6000; ms += 50) if (t.push(0.9, "chin", ms).alert) alerts++;
  // alerts at ~500, ~3500 (cooldown ends at 3500 and dwell restarted at 500 → ready)
  assert.equal(alerts, 2);
});

// Nose held between the index and middle fingers (no thumb). Synthetic face:
// nose at (0.5, 0.5), face 0.2 wide.
function noseSqueezeHand({ curled = false } = {}) {
  const p = (x, y) => ({ x, y, z: 0 });
  const h = Array.from({ length: 21 }, () => p(0.5, 0.7));
  h[0] = p(0.5, 0.75); // wrist
  h[4] = p(0.4, 0.65); // thumb tip, well away
  [h[5], h[6], h[7], h[8]] = [p(0.47, 0.62), p(0.475, 0.57), p(0.48, 0.53), p(0.49, 0.5)]; // index, left of nose
  [h[9], h[10], h[11], h[12]] = [p(0.53, 0.62), p(0.52, 0.57), p(0.515, 0.53), p(0.51, 0.5)]; // middle, right of nose
  h[13] = p(0.55, 0.63);
  h[17] = p(0.57, 0.65);
  h[16] = curled ? p(0.545, 0.68) : p(0.56, 0.52); // ring tip: curled into the palm, or straight
  h[20] = curled ? p(0.56, 0.69) : p(0.58, 0.55); // little fingertip
  return h;
}

test("two-finger nose squeeze without the thumb is caught and labelled nose", () => {
  const r = evaluateFrame(makeFace(), [noseSqueezeHand()], DEFAULT_SETTINGS);
  assert.ok(r.score >= 0.9, `score ${r.score}`);
  assert.equal(r.zone, "nose");
  assert.equal(r.hands[0].reasons.pinch, 0, "the thumb isn't involved");
});

test("fingers around the nose with ring and little fingers curled in don't count as a squeeze", () => {
  const r = evaluateFrame(makeFace(), [noseSqueezeHand({ curled: true })], DEFAULT_SETTINGS);
  assert.equal(r.hands[0].reasons.squeeze, 0);
  assert.ok(r.score < DEFAULT_SETTINGS.threshold, `score ${r.score}`);
});

test("any-touch mode: any part of a hand overlapping the face counts", () => {
  const anyTouch = settingsFor({ anyTouch: true });
  const face = makeFace();
  // An open, resting hand that the picking detector ignores...
  const resting = [makeHand({ x: 0.46, y: 0.6 }, { pinch: false })];
  assert.ok(evaluateFrame(face, resting, DEFAULT_SETTINGS).score < DEFAULT_SETTINGS.threshold);
  // ...alerts in any-touch mode.
  assert.equal(evaluateFrame(face, resting, anyTouch).score, 1);
  // A hand only partly over the face (reaching down from above) still counts.
  const wristOnly = makeHand({ x: 0.5, y: 0.3 }, { palm: 0.1 }); // fingertips above the face, palm over the forehead
  assert.equal(evaluateFrame(face, [wristOnly], anyTouch).score, 1);
  // A hand close to the camera in front of the face counts too (no depth check)...
  assert.equal(evaluateFrame(face, [makeHand({ x: 0.45, y: 0.5 }, { palm: 0.35 })], anyTouch).score, 1);
  // ...the mouth isn't excluded...
  assert.equal(evaluateFrame(face, [makeHand({ x: 0.5, y: 0.565 })], { ...anyTouch, includeMouth: false }).score, 1);
  // ...but a hand off the face doesn't.
  assert.equal(evaluateFrame(face, [makeHand({ x: 0.9, y: 0.4 })], anyTouch).score, 0);
});

test("any-touch mode alerts after a quarter of a second, not the usual delay", () => {
  const s = settingsFor({ anyTouch: true, dwell: 3 });
  assert.equal(s.dwellMs, 250);
  const t = new PickingTracker(s);
  assert.equal(t.push(1, "chin", 0).alert, null);
  assert.equal(t.push(1, "chin", 200).alert, null);
  assert.ok(t.push(1, "chin", 267).alert);
});
