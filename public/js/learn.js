// Personal tuning: finds the detector settings that best fit the user's own
// examples (recorded clips plus answers to alerts). Pure code, run in a worker
// by the app and unit tested in Node.
//
// It searches two dials: sensitivity (how close and how pinch-like a touch
// must be) and the hand-shape cut-off (how spread the fingers must be). Each
// setting is scored by replaying every example: a missed picking example and a
// false alarm each count as one mistake.

import { settingsFor } from "./detector.js";
import { evaluateClips, labelInfo } from "./recording.js";

export const SENSITIVITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const HAND_SHAPES = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
export const MIN_EXAMPLES = 3; // of each kind, before anything is changed
export const MAX_EXAMPLES = 300; // newest kept; bounds tuning time

const expectedOf = (c) => c.expected || labelInfo(c.label).expected;

export function readiness(clips) {
  const pos = clips.filter((c) => expectedOf(c) === "alert").length;
  const neg = clips.length - pos;
  return {
    pos,
    neg,
    ready: pos >= MIN_EXAMPLES && neg >= MIN_EXAMPLES,
    needPos: Math.max(0, MIN_EXAMPLES - pos),
    needNeg: Math.max(0, MIN_EXAMPLES - neg),
  };
}

function measure(clips, prefs) {
  const r = evaluateClips(clips, settingsFor(prefs));
  const caught = Math.round((r.catchRate ?? 0) * r.positives);
  return {
    caught,
    positives: r.positives,
    falseAlarms: r.falseAlarms,
    falseAlarmClips: r.falseAlarmClips,
    negatives: r.negatives,
    medianTimeToAlertMs: r.medianTimeToAlertMs,
    errors: r.positives - caught + r.falseAlarms,
    // A late alert is partly a miss. Only recorded clips count here: in those the
    // picking starts when recording starts. Alerts after 3 s add up to half a
    // mistake each (reached at 8 s).
    mistakes: r.positives - caught + r.falseAlarms + r.rows.reduce((sum, row) => sum + lateness(row), 0),
  };
}

function lateness(row) {
  if (row.expected !== "alert" || row.firstAlertMs === null || row.clip.source === "feedback") return 0;
  return Math.min(0.5, Math.max(0, (row.firstAlertMs - 3000) / 10000));
}

// Returns { ready, current, best, improved }. `best` holds the suggested
// `sensitivity` and `spreadMin`. Nothing is suggested unless it is clearly
// better: at least half a mistake fewer than the current settings.
export function learnSettings(allClips, prefs, onProgress) {
  const clips = allClips.slice(-MAX_EXAMPLES);
  const ready = readiness(clips);
  const cur = { sensitivity: prefs.sensitivity, spreadMin: prefs.spreadMin ?? 0.4 };
  const current = { ...cur, ...measure(clips, { ...prefs, ...cur }) };
  if (!ready.ready) return { ...ready, current, best: null, improved: false };

  const grid = HAND_SHAPES.map(() => []);
  const total = HAND_SHAPES.length * SENSITIVITIES.length;
  let done = 0;
  HAND_SHAPES.forEach((spreadMin, i) =>
    SENSITIVITIES.forEach((sensitivity, j) => {
      grid[i][j] = { sensitivity, spreadMin, ...measure(clips, { ...prefs, sensitivity, spreadMin }) };
      onProgress?.(++done / total);
    }),
  );

  // Prefer settings whose neighbours also do well: with few examples, a lone
  // good setting in a sea of bad ones is usually luck, not a real fit.
  const at = (i, j) => grid[i]?.[j];
  let best = null;
  for (let i = 0; i < HAND_SHAPES.length; i++) {
    for (let j = 0; j < SENSITIVITIES.length; j++) {
      const c = at(i, j);
      const around = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)].filter(Boolean);
      const neighbourhood = around.reduce((s, n) => s + n.mistakes, 0) / around.length;
      const moved = Math.abs(c.sensitivity - cur.sensitivity) + Math.abs(c.spreadMin - cur.spreadMin) / 0.05;
      const rank = [c.mistakes + 0.5 * neighbourhood, c.mistakes, moved, c.medianTimeToAlertMs ?? Infinity];
      if (!best || lessThan(rank, best.rank)) best = { ...c, rank };
    }
  }
  delete best.rank;
  const improved = best.mistakes <= current.mistakes - 0.5 && (best.sensitivity !== cur.sensitivity || best.spreadMin !== cur.spreadMin);
  return { ...ready, current, best, improved };
}

function lessThan(a, b) {
  for (let k = 0; k < a.length; k++) {
    if (a[k] < b[k] - 1e-9) return true;
    if (a[k] > b[k] + 1e-9) return false;
  }
  return false;
}

export const summarize = (m) => `${m.caught} of ${m.positives} picking caught, ${m.falseAlarms} false alarm${m.falseAlarms === 1 ? "" : "s"}`;

// One-line, plain-language summary of a learning result.
export function describe(result) {
  const { current: c, best: b } = result;
  const part = summarize;
  if (!result.ready) return `Needs ${[result.needPos && `${result.needPos} more picking`, result.needNeg && `${result.needNeg} more non-picking`].filter(Boolean).join(" and ")} example(s) first.`;
  if (!result.improved) return `Current settings already fit your ${c.positives + c.negatives} examples best (${part(c)}).`;
  return `Now: ${part(c)}. Learned: ${part(b)}.`;
}
