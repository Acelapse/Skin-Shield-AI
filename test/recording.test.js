import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsFor, FACE_POINTS_USED } from "../public/js/detector.js";
import { packFrame, unpackFrame, replayClip, evaluateClips, makeDataset, parseDataset } from "../public/js/recording.js";
import { makeFace, makeHand } from "./fixtures.js";

const FPS = 15;
const step = 1000 / FPS;

// Builds a clip the way the app records one: raw face + hands per frame.
function makeClip({ label, expected, seconds = 4, hand, area = null, faceEvery = 1 }) {
  const face = makeFace();
  const frames = [];
  for (let i = 0; i * step <= seconds * 1000; i++) {
    const t = i * step;
    frames.push(packFrame(t, i % faceEvery === 0 ? face : null, hand ? [hand(i)] : []));
  }
  return { id: `${label}-${Math.random()}`, label, expected, area, aspect: 1, durationMs: frames.at(-1).t, faceIndices: FACE_POINTS_USED, frames };
}

const pinchChin = () => makeHand({ x: 0.5, y: 0.62 });
const restingOpen = () => makeHand({ x: 0.46, y: 0.6 }, { pinch: false });
const scratch = (i) => makeHand({ x: 0.45 + (i % 2 ? 0.012 : -0.012), y: 0.52 }, { pinch: false });
const awayHand = () => makeHand({ x: 0.9, y: 0.4 });
const settings = settingsFor({ sensitivity: 6, dwell: 1.5, cooldown: 10 });

test("packing keeps only the points the detector reads, rounded", () => {
  const f = packFrame(12.4, makeFace(), [makeHand({ x: 0.123456, y: 0.5 })]);
  assert.equal(f.t, 12);
  assert.equal(f.f.length, FACE_POINTS_USED.length * 2);
  assert.equal(f.h[0].length, 21 * 3);
  assert.equal(f.h[0][24], 0.1235); // index tip x, rounded to 4 places
  assert.deepEqual(packFrame(0, null, null), { t: 0, f: null, h: [] });
});

test("unpacking restores what the detector needs", () => {
  const face = makeFace();
  const hand = makeHand({ x: 0.5, y: 0.62 });
  const { face: f2, hands } = unpackFrame(packFrame(0, face, [hand]));
  assert.equal(f2.length, 478);
  for (const i of FACE_POINTS_USED) {
    assert.ok(Math.abs(f2[i].x - face[i].x) < 1e-4 && Math.abs(f2[i].y - face[i].y) < 1e-4);
  }
  assert.equal(hands[0].length, 21);
  assert.ok(Math.abs(hands[0][8].x - 0.5) < 1e-4);
});

test("a picking clip replays to an alert after the dwell time", () => {
  const { alerts } = replayClip(makeClip({ label: "picking", expected: "alert", hand: pinchChin }), settings);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].zone, "chin");
  assert.ok(alerts[0].t >= 1500 && alerts[0].t < 1700, `alert at ${alerts[0].t}`);
});

test("face lost every other frame is bridged by face memory", () => {
  const { alerts } = replayClip(makeClip({ label: "picking", expected: "alert", hand: pinchChin, faceEvery: 3 }), settings);
  assert.equal(alerts.length, 1);
});

test("non-picking clips replay without alerts", () => {
  assert.equal(replayClip(makeClip({ label: "resting", expected: "no-alert", hand: restingOpen }), settings).alerts.length, 0);
  assert.equal(replayClip(makeClip({ label: "working", expected: "no-alert", hand: awayHand }), settings).alerts.length, 0);
  assert.equal(replayClip(makeClip({ label: "working", expected: "no-alert" }), settings).alerts.length, 0);
});

test("evaluation reports catch rate, false alarms and area accuracy", () => {
  const clips = [
    makeClip({ label: "picking", expected: "alert", hand: pinchChin, area: "chin" }),
    makeClip({ label: "scratching", expected: "alert", hand: scratch, area: "right cheek" }),
    makeClip({ label: "picking", expected: "alert", hand: awayHand }), // will be missed
    makeClip({ label: "resting", expected: "no-alert", hand: restingOpen }),
    makeClip({ label: "eating", expected: "no-alert", hand: pinchChin }), // looks like picking: false alarm
  ];
  const r = evaluateClips(clips, settings);
  assert.equal(r.positives, 3);
  assert.equal(r.negatives, 2);
  assert.equal(r.catchRate, 2 / 3);
  assert.equal(r.falseAlarms, 1);
  assert.equal(r.falseAlarmClips, 1);
  assert.equal(r.areaAccuracy, 1);
  assert.ok(r.falseAlarmsPerHour > 0);
  assert.deepEqual(r.rows.map((x) => x.correct), [true, true, false, true, false]);
});

test("higher sensitivity never catches less", () => {
  const clips = [makeClip({ label: "scratching", expected: "alert", hand: scratch }), makeClip({ label: "picking", expected: "alert", hand: pinchChin })];
  let prev = -1;
  for (let s = 1; s <= 10; s++) {
    const rate = evaluateClips(clips, settingsFor({ sensitivity: s })).catchRate;
    assert.ok(rate >= prev, `sensitivity ${s}`);
    prev = rate;
  }
});

test("dataset files round-trip and bad files are rejected", () => {
  const clip = makeClip({ label: "picking", expected: "alert", hand: pinchChin });
  const json = JSON.stringify(makeDataset([clip]));
  assert.equal(parseDataset(json)[0].frames.length, clip.frames.length);
  assert.equal(parseDataset([clip]).length, 1);
  assert.equal(parseDataset(clip).length, 1);
  assert.throws(() => parseDataset("{}"), /Not a SkinShield/);
  assert.throws(() => parseDataset([{ label: "x" }]), /missing/);
});
