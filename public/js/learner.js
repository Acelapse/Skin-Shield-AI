// Learning from everyday use.
//
// - Keeps the last few seconds of tracking points in memory (never video).
// - When an alert is answered, saves that moment as an example: "That wasn't
//   picking" -> false alarm, "I've stopped" / "Breathe" -> confirmed picking.
//   "Missed one" saves the last few seconds as picking that wasn't caught.
// - After new examples, retunes sensitivity and hand shape in a worker and
//   applies a clearly better fit (with Undo), or offers it if auto-apply is off.

import { DETECTOR_VERSION, FACE_POINTS_USED } from "./detector.js";
import { packFrame } from "./recording.js";
import { clipStore } from "./clipstore.js";
import { describe, readiness, summarize } from "./learn.js";

const BUFFER_MS = 12000;
const BEFORE_ALERT_MS = 6000;
const AFTER_ALERT_MS = 1000;
const MISSED_MS = 8000;
const MAX_FEEDBACK_CLIPS = 200;
const DEFAULTS = { sensitivity: 6, spreadMin: 0.4 };

const $ = (id) => document.getElementById(id);

export function createLearner({ getPrefs, applyPrefs, getContext, recorder }) {
  const buffer = []; // { at, frame } with frame.t = absolute ms (rebased when saved)
  let pending = null; // snapshot taken around the current alert
  let worker = null;
  let jobId = 0;
  let learning = false;
  let again = false;
  let timer = null;
  let lastResult = null;
  let undo = null;
  let rejected = null; // a change the user undid: not re-applied on its own until there's more evidence

  const els = {
    status: $("learnStatus"),
    result: $("learnResult"),
    values: $("learnValues"),
    learnBtn: $("learnBtn"),
    applyBtn: $("applyLearnBtn"),
    undoBtn: $("undoLearnBtn"),
    resetBtn: $("resetLearnBtn"),
    missedBtn: $("missedBtn"),
    toast: $("toast"),
    toastText: $("toastText"),
    toastAction: $("toastAction"),
  };

  // ----- capture -----
  function captureFrame(now, rawFace, hands) {
    buffer.push(packFrame(now, rawFace, hands));
    while (buffer.length && now - buffer[0].t > BUFFER_MS) buffer.shift();
  }

  function snapshot(from, to) {
    const frames = buffer.filter((f) => f.t >= from && f.t <= to);
    if (frames.length < 10) return null;
    const t0 = frames[0].t;
    return frames.map((f) => ({ ...f, t: f.t - t0 }));
  }

  function makeClip(label, frames) {
    const ctx = getContext();
    return {
      id: crypto.randomUUID?.() || `fb-${Date.now()}`,
      label,
      expected: label === "false-alarm" ? "no-alert" : "alert",
      source: "feedback",
      area: null,
      notes: "",
      recordedAt: new Date().toISOString(),
      durationMs: frames[frames.length - 1].t,
      fps: Math.round((frames.length / Math.max(1, frames[frames.length - 1].t)) * 1000),
      aspect: ctx.aspect,
      camera: ctx.camera,
      settings: ctx.settings,
      faceIndices: FACE_POINTS_USED,
      detectorVersion: DETECTOR_VERSION,
      liveAlerts: [],
      frames,
    };
  }

  async function save(clip) {
    try {
      await clipStore.put(clip);
      // Keep storage bounded: drop the oldest automatic examples.
      const auto = (await clipStore.all()).filter((c) => c.source === "feedback");
      for (const old of auto.slice(0, Math.max(0, auto.length - MAX_FEEDBACK_CLIPS))) await clipStore.remove(old.id);
    } catch (err) {
      console.error("Couldn't save example", err);
      return false;
    }
    await recorder.refresh(); // updates the clip list and triggers learning
    return true;
  }

  // Called by the app when an alert fires. The snapshot is taken a second
  // later so it includes the moment of the alert itself.
  function onAlert(now) {
    pending = null;
    if (!getPrefs().learn) return;
    const at = now;
    setTimeout(() => {
      const frames = snapshot(at - BEFORE_ALERT_MS, at + AFTER_ALERT_MS);
      if (frames) pending = frames;
    }, AFTER_ALERT_MS + 50);
  }

  // Called with "confirmed" or "false-alarm" when the user answers an alert.
  function onAnswer(label) {
    if (!getPrefs().learn) return;
    const take = () => {
      if (!pending) return;
      const frames = pending;
      pending = null;
      save(makeClip(label, frames)).then(
        (ok) => ok && toast(label === "false-alarm" ? "Got it. SkinShield will learn from this false alarm." : "Thanks. Saved as an example of picking."),
      );
    };
    // If answered within the first second, wait for the snapshot.
    pending ? take() : setTimeout(take, AFTER_ALERT_MS + 100);
  }

  els.missedBtn.addEventListener("click", async () => {
    const now = performance.now();
    const frames = snapshot(now - MISSED_MS, now);
    if (!frames) return toast("Nothing to save yet: monitoring needs to run for a few seconds first.");
    if (!frames.some((f) => f.f && f.h.length)) return toast("Your face and hand weren't both in view in the last few seconds, so there's nothing to learn from.");
    if (await save(makeClip("missed", frames))) toast("Saved. SkinShield will learn from the picking it missed.");
  });

  // ----- learning -----
  function schedule() {
    if (!getPrefs().learn) return;
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  }

  function run() {
    if (learning) {
      again = true;
      return;
    }
    const clips = recorder.clips;
    const ready = readiness(clips);
    if (!ready.ready) {
      lastResult = { ...ready, improved: false };
      return render();
    }
    learning = true;
    again = false;
    render("Learning from your examples...");
    worker ??= new Worker(new URL("./learn-worker.js", import.meta.url), { type: "module" });
    const id = ++jobId;
    const prefs = getPrefs();
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      if ("progress" in e.data) return render(`Learning from your examples... ${Math.round(e.data.progress * 100)}%`);
      learning = false;
      if (e.data.error) {
        console.error(e.data.error);
        render("Learning failed. See the browser console for details.");
      } else {
        lastResult = e.data.result;
        const b = lastResult.best;
        const undone =
          rejected && b && b.sensitivity === rejected.sensitivity && b.spreadMin === rejected.spreadMin && clips.length < rejected.count + 5;
        if (lastResult.improved && getPrefs().autoLearn && !undone) apply(true);
        else {
          render();
          if (lastResult.improved) toast("SkinShield found settings that fit you better.", "Apply", () => apply(false));
        }
      }
      if (again) run();
    };
    worker.postMessage({ id, clips, prefs });
  }

  function apply(auto) {
    const b = lastResult?.best;
    if (!b) return;
    const p = getPrefs();
    const before = { sensitivity: p.sensitivity, spreadMin: p.spreadMin };
    undo = before;
    applyPrefs({ sensitivity: b.sensitivity, spreadMin: b.spreadMin });
    const what = `sensitivity ${before.sensitivity} → ${b.sensitivity}` + (before.spreadMin !== b.spreadMin ? `, hand shape ${before.spreadMin} → ${b.spreadMin}` : "");
    lastResult = { ...lastResult, improved: false, applied: { before, after: b } };
    render();
    toast(`${auto ? "SkinShield adjusted itself" : "Applied"}: ${what}.`, "Undo", undoChange);
  }

  function undoChange() {
    if (!undo) return;
    const p = getPrefs();
    rejected = { sensitivity: p.sensitivity, spreadMin: p.spreadMin, count: (recorder.clips || []).length };
    applyPrefs(undo);
    undo = null;
    lastResult = null;
    render("Change undone.");
  }

  // ----- panel -----
  function render(busy) {
    const clips = recorder.clips || [];
    const count = (label) => clips.filter((c) => c.label === label).length;
    const recorded = clips.filter((c) => c.source !== "feedback").length;
    const p = getPrefs();
    const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
    els.status.textContent = clips.length
      ? `${n(clips.length, "example")}: ${n(count("confirmed"), "confirmed alert")}, ${n(count("false-alarm"), "false alarm")}, ${count("missed")} missed, ${n(recorded, "recorded clip")}.`
      : "No examples yet. Answer alerts, press Missed one, or record test clips.";
    els.values.textContent = `Sensitivity ${p.sensitivity}, hand shape ${p.spreadMin}`;
    els.result.textContent =
      busy ||
      (lastResult?.applied
        ? `Tested on your examples. Before: ${summarize(lastResult.current)}. After: ${summarize(lastResult.applied.after)}.`
        : lastResult
          ? describe(lastResult)
          : "");
    els.learnBtn.disabled = learning || !clips.length;
    els.applyBtn.hidden = !lastResult?.improved;
    els.undoBtn.hidden = !undo;
    els.resetBtn.disabled = p.sensitivity === DEFAULTS.sensitivity && p.spreadMin === DEFAULTS.spreadMin;
  }

  els.learnBtn.addEventListener("click", run);
  els.applyBtn.addEventListener("click", () => apply(false));
  els.undoBtn.addEventListener("click", undoChange);
  els.resetBtn.addEventListener("click", () => {
    undo = { sensitivity: getPrefs().sensitivity, spreadMin: getPrefs().spreadMin };
    applyPrefs(DEFAULTS);
    lastResult = null;
    render("Back to the default settings.");
    toast("Back to the default settings.", "Undo", undoChange);
  });

  // ----- toast -----
  let toastTimer = null;
  function toast(text, actionLabel, action) {
    els.toastText.textContent = text;
    els.toastAction.hidden = !actionLabel;
    els.toastAction.textContent = actionLabel || "";
    els.toastAction.onclick = () => {
      els.toast.hidden = true;
      action?.();
    };
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), actionLabel ? 12000 : 5000);
  }

  return {
    captureFrame,
    onAlert,
    onAnswer,
    onClipsChanged: () => {
      render();
      schedule();
    },
    setRunning: (running) => (els.missedBtn.disabled = !running),
    render,
  };
}
