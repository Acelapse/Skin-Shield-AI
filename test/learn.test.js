import { test } from "node:test";
import assert from "node:assert/strict";
import { FACE_POINTS_USED } from "../public/js/detector.js";
import { packFrame } from "../public/js/recording.js";
import { learnSettings, readiness, describe } from "../public/js/learn.js";
import { makeFace, makeHand } from "./fixtures.js";

const PREFS = { sensitivity: 6, spreadMin: 0.4, dwell: 1.5, cooldown: 10, includeMouth: true, requirePinch: true };

function clip(label, expected, hand, seconds = 4) {
  const face = makeFace();
  const frames = [];
  for (let i = 0; i * 66.7 <= seconds * 1000; i++) frames.push(packFrame(i * 66.7, face, hand ? [hand(i)] : []));
  return { id: `${label}-${Math.random()}`, label, expected, aspect: 1, durationMs: frames.at(-1).t, faceIndices: FACE_POINTS_USED, frames };
}

// Picking: a pinch with the other fingers apart (spread ~0.58 palm lengths).
const picking = () => clip("picking", "alert", () => makeHand({ x: 0.5, y: 0.6 }));
// Resting chin: also a pinch-like grip on the face, but fingers slightly bunched (~0.53).
const resting = () => clip("resting", "no-alert", () => makeHand({ x: 0.47, y: 0.6 }, { bunch: 0.92 }));
const away = () => clip("working", "no-alert", () => makeHand({ x: 0.9, y: 0.4 }));

test("needs a few examples of each kind before changing anything", () => {
  const r = learnSettings([picking(), picking(), resting()], PREFS);
  assert.equal(r.ready, false);
  assert.equal(r.needPos, 1);
  assert.equal(r.needNeg, 2);
  assert.equal(r.improved, false);
  assert.match(describe(r), /1 more picking and 2 more non-picking/);
  assert.deepEqual(readiness([]), { pos: 0, neg: 0, ready: false, needPos: 3, needNeg: 3 });
});

test("learns a stricter hand shape to stop false alarms without losing picking", () => {
  const clips = [picking(), picking(), picking(), resting(), resting(), resting()];
  const r = learnSettings(clips, PREFS);
  assert.equal(r.ready, true);
  assert.equal(r.current.falseAlarms, 3, "default settings alert on the resting clips");
  assert.equal(r.current.caught, 3);
  assert.equal(r.improved, true);
  assert.equal(r.best.falseAlarms, 0);
  assert.equal(r.best.caught, 3);
  assert.ok(r.best.spreadMin > 0.4, `hand shape ${r.best.spreadMin}`);
  assert.match(describe(r), /Learned: 3 of 3 picking caught, 0 false alarms/);
});

test("leaves settings alone when they already fit", () => {
  const clips = [picking(), picking(), picking(), away(), away(), away()];
  const r = learnSettings(clips, PREFS);
  assert.equal(r.current.caught, 3);
  assert.equal(r.current.falseAlarms, 0);
  assert.equal(r.improved, false);
  assert.match(describe(r), /already fit/);
});

test("reports progress while searching", () => {
  const seen = [];
  learnSettings([picking(), picking(), picking(), away(), away(), away()], PREFS, (p) => seen.push(p));
  assert.equal(seen.length, 60);
  assert.equal(seen.at(-1), 1);
});
