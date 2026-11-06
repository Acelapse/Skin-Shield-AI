// Replays recorded clips through the detector and reports how well it does.
//
//   npm run evaluate                      every .json file in recordings/
//   npm run evaluate -- my-clips.json     specific files or folders
//   npm run evaluate -- --sensitivity 7   per-clip detail at sensitivity 7
//   npm run evaluate -- --dwell 2 --no-mouth --no-pinch
//
// Export clips from the app's "Test recordings" panel and put the files in
// recordings/ (ignored by git, as they describe your face and hands).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DETECTOR_VERSION, settingsFor } from "../public/js/detector.js";
import { evaluateClips, labelInfo, parseDataset, replayClip } from "../public/js/recording.js";

const args = process.argv.slice(2);
const opts = { explain: false, sensitivity: null, dwell: 1.5, cooldown: 10, includeMouth: true, requirePinch: true };
const paths = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--sensitivity") opts.sensitivity = Number(args[++i]);
  else if (a === "--dwell") opts.dwell = Number(args[++i]);
  else if (a === "--cooldown") opts.cooldown = Number(args[++i]);
  else if (a === "--no-mouth") opts.includeMouth = false;
  else if (a === "--no-pinch") opts.requirePinch = false;
  else if (a === "--explain") opts.explain = true;
  else if (a === "--help" || a === "-h") {
    console.log("Usage: npm run evaluate -- [files or folders] [--sensitivity N] [--dwell S] [--cooldown S] [--no-mouth] [--no-pinch] [--explain]");
    process.exit(0);
  } else paths.push(a);
}
if (!paths.length) paths.push("recordings");

async function collect(p) {
  const s = await stat(p).catch(() => null);
  if (!s) return [];
  if (s.isFile()) return [p];
  const names = await readdir(p);
  return names.filter((n) => n.endsWith(".json")).map((n) => join(p, n));
}

const files = (await Promise.all(paths.map(collect))).flat();
if (!files.length) {
  console.error(`No recordings found in ${paths.join(", ")}.`);
  console.error("Record clips in the app (Test recordings panel), click Export, and save the file into the recordings/ folder.");
  process.exit(1);
}

// Load and de-duplicate (the same clip may be in several exports).
const byId = new Map();
for (const f of files) {
  try {
    for (const c of parseDataset(await readFile(f, "utf8"))) byId.set(c.id || `${f}:${byId.size}`, c);
  } catch (err) {
    console.error(`Skipping ${f}: ${err.message}`);
  }
}
const clips = [...byId.values()];
const pos = clips.filter((c) => (c.expected || labelInfo(c.label).expected) === "alert").length;
const totalMin = clips.reduce((s, c) => s + (c.durationMs || 0), 0) / 60000;
console.log(`\n${clips.length} clips (${totalMin.toFixed(1)} min) from ${files.length} file(s): ${pos} should alert, ${clips.length - pos} should not.`);
console.log(`Alert after ${opts.dwell} s, mouth ${opts.includeMouth ? "on" : "off"}, pinch-only ${opts.requirePinch ? "on" : "off"}.\n`);

const pct = (v) => (v === null ? "  n/a" : `${String(Math.round(v * 100)).padStart(4)}%`);
const sec = (ms) => (ms === null ? "  n/a" : `${(ms / 1000).toFixed(1).padStart(4)} s`);
const pad = (s, n) => String(s).padEnd(n);

// 1. Sweep every sensitivity level.
console.log("Sensitivity  Caught  False alarms (clips)  Time to alert  Area right");
const sweep = [];
for (let s = 1; s <= 10; s++) {
  const r = evaluateClips(clips, settingsFor({ ...opts, sensitivity: s }));
  sweep.push({ s, r });
  console.log(
    `${pad(s, 12)} ${pct(r.catchRate)}   ${pad(`${r.falseAlarms} (${r.falseAlarmClips}/${r.negatives})`, 20)}  ${sec(r.medianTimeToAlertMs)}       ${pct(r.areaAccuracy)}`,
  );
}

// Best level: most picking caught, then fewest false alarms, then lower sensitivity.
const best = sweep.slice().sort((a, b) => (b.r.catchRate ?? 0) - (a.r.catchRate ?? 0) || a.r.falseAlarms - b.r.falseAlarms || a.s - b.s)[0];
const clean = sweep.filter((x) => x.r.falseAlarms === 0).sort((a, b) => (b.r.catchRate ?? 0) - (a.r.catchRate ?? 0))[0];
console.log(`\nMost picking caught: sensitivity ${best.s} (${pct(best.r.catchRate).trim()} caught, ${best.r.falseAlarms} false alarms).`);
if (clean && clean.s !== best.s) console.log(`Best with zero false alarms: sensitivity ${clean.s} (${pct(clean.r.catchRate).trim()} caught).`);
if (pos === 0) console.log("Record some picking clips too, or the catch rate can't be measured.");
if (pos === clips.length) console.log("Record some non-picking clips too (resting chin, drinking...), or false alarms can't be measured.");

// 2. Per-clip detail at one level.
const level = opts.sensitivity ?? best.s;
const detail = evaluateClips(clips, settingsFor({ ...opts, sensitivity: level }));
console.log(`\nPer clip at sensitivity ${level}:`);
for (const row of detail.rows) {
  const c = row.clip;
  const name = labelInfo(c.label).name + (c.area ? ` (${c.area})` : "") + (c.notes ? ` - ${c.notes}` : "");
  const verdict = row.correct ? "ok  " : row.expected === "alert" ? "MISS" : "FALSE";
  const what = row.alerts.length ? `${row.alerts.length} alert(s), first at ${(row.firstAlertMs / 1000).toFixed(1)} s, area ${row.alerts[0].zone}` : `no alert (peak score ${row.peakScore.toFixed(2)})`;
  console.log(`  ${pad(verdict, 5)} ${pad(name.slice(0, 48), 49)} ${what}`);
  if (opts.explain) {
    const ex = replayClip(c, settingsFor({ ...opts, sensitivity: level }), { explain: true }).explain;
    const m = ex.mean;
    const f = (v, d = 2) => (v === null || v === undefined ? "-" : v.toFixed(d));
    const p100 = (n) => `${Math.round((n / Math.max(1, ex.frames)) * 100)}%`;
    console.log(`        face found ${p100(ex.withFace)}, hand found ${p100(ex.withHands)}, flagged as picking ${p100(ex.flagged)} of ${ex.frames} frames`);
    if (ex.flagged) {
      const zones = Object.entries(m).filter(([k]) => k.startsWith("zone:")).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(5)} ${Math.round(v * 100)}%`).join(", ");
      console.log(`        when flagged: pinch-driven ${Math.round((ex.byPinch / ex.flagged) * 100)}% | pinch ${f(m.pinch)} | fidget ${f(m.fidget)} | inside face ${f(m.inside)} | hand/face size ${f(m.depthRatio)}`);
      console.log(`        thumb gap 2D ${f(m.gap2d)} vs 3D ${f(m.gap3d)} palms | fingertip spread ${f(m.spread)} palms | areas: ${zones}`);
    }
  }
}

// 3. Sanity check: replaying with the settings used while recording should give
// the same alerts the app saw live. A mismatch means replay and app differ.
let checked = 0;
let mismatched = 0;
let older = 0;
for (const c of clips) {
  if (!c.settings || !Array.isArray(c.liveAlerts)) continue;
  if ((c.detectorVersion || 1) !== DETECTOR_VERSION) {
    older++;
    continue;
  }
  checked++;
  if (replayClip(c, settingsFor(c.settings)).alerts.length !== c.liveAlerts.length) mismatched++;
}
if (checked) {
  console.log(
    mismatched
      ? `\nNote: ${mismatched} of ${checked} clips replay with a different number of alerts than the app saw live. Small differences come from frame timing; large ones mean the replay no longer matches the app.`
      : `\nReplay check: all ${checked} clips match what the app saw while recording.`,
  );
}
if (older) console.log(`\n${older} clip(s) were recorded with older detection rules, so their live alerts aren't compared. Their scores above use the current rules.`);
console.log("");
