// Test-recording panel: records labelled clips of tracking points, stores them
// on this device, exports/imports them, and scores them against the detector.

import { FACE_POINTS_USED, settingsFor } from "./detector.js";
import { AREAS, LABELS, evaluateClips, labelInfo, makeDataset, packFrame, parseDataset } from "./recording.js";
import { clipStore } from "./clipstore.js";

const COUNTDOWN_S = 3;
const $ = (id) => document.getElementById(id);
const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const pct = (v) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

export function createRecorder({ getContext, onStart, onStop }) {
  let state = "idle"; // idle | countdown | recording
  let clip = null;
  let startAt = 0;
  let limitMs = 0;
  let countdownTimer = null;
  let clips = [];

  const els = {
    label: $("recLabel"),
    area: $("recArea"),
    length: $("recLength"),
    notes: $("recNotes"),
    btn: $("recBtn"),
    hint: $("recHint"),
    list: $("clipList"),
    summary: $("clipSummary"),
    overlay: $("recOverlay"),
    score: $("scoreBtn"),
    scoreOut: $("scoreOut"),
    exportBtn: $("exportBtn"),
    importBtn: $("importBtn"),
    importFile: $("importFile"),
    clearBtn: $("clearClipsBtn"),
  };

  // ----- form -----
  const groups = { alert: "Should alert", "no-alert": "Should not alert" };
  els.label.replaceChildren(
    ...Object.entries(groups).map(([expected, title]) => {
      const og = document.createElement("optgroup");
      og.label = title;
      LABELS.filter((l) => l.expected === expected).forEach((l) => og.append(new Option(l.name, l.id)));
      return og;
    }),
  );
  els.area.replaceChildren(new Option("Any / several", ""), ...AREAS.map((a) => new Option(a[0].toUpperCase() + a.slice(1), a)));
  const syncArea = () => {
    els.area.disabled = labelInfo(els.label.value).expected !== "alert";
    if (els.area.disabled) els.area.value = "";
  };
  els.label.addEventListener("change", syncArea);
  syncArea();

  function setEnabled(running) {
    if (state === "idle") els.btn.disabled = !running;
    if (state === "idle") els.hint.textContent = running ? "" : "Start monitoring first, then record.";
  }

  // ----- recording -----
  function begin() {
    const ctx = getContext();
    if (!ctx.running) return;
    const info = labelInfo(els.label.value);
    clip = {
      id: crypto.randomUUID?.() || `clip-${Date.now()}`,
      label: info.id,
      expected: info.expected,
      area: els.area.value || null,
      notes: els.notes.value.trim(),
      recordedAt: new Date().toISOString(),
      durationMs: 0,
      aspect: ctx.aspect,
      camera: ctx.camera,
      settings: ctx.settings,
      faceIndices: FACE_POINTS_USED,
      liveAlerts: [],
      frames: [],
    };
    limitMs = Number(els.length.value) * 1000;
    state = "countdown";
    els.btn.textContent = "Cancel";
    setFormDisabled(true);
    let n = COUNTDOWN_S;
    const show = () => {
      els.overlay.hidden = false;
      els.overlay.className = "rec-overlay countdown";
      els.overlay.textContent = n;
      els.hint.textContent = `Get ready: ${info.name.toLowerCase()}. Start as soon as recording begins.`;
    };
    show();
    countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) return show();
      clearInterval(countdownTimer);
      state = "recording";
      startAt = performance.now();
      onStart?.(); // start the live detector fresh, exactly like a replay does
      els.btn.textContent = "Stop and save";
      els.overlay.className = "rec-overlay live";
      els.overlay.textContent = "REC 0:00";
      els.hint.textContent = `Recording: ${info.name.toLowerCase()}. Keep going until it stops.`;
    }, 1000);
  }

  // Called by the app for every processed frame.
  function captureFrame(now, rawFace, hands, liveAlert) {
    if (state !== "recording") return;
    const t = now - startAt;
    clip.frames.push(packFrame(t, rawFace, hands));
    if (liveAlert) clip.liveAlerts.push(Math.round(t));
    els.overlay.textContent = `REC ${fmtTime(t)}${limitMs ? ` / ${fmtTime(limitMs)}` : ""}`;
    if (limitMs && t >= limitMs) finish(true);
  }

  async function finish(save) {
    clearInterval(countdownTimer);
    const wasRecording = state === "recording";
    state = "idle";
    els.overlay.hidden = true;
    els.btn.textContent = "Record";
    setFormDisabled(false);
    syncArea();
    onStop?.();
    if (!save || !wasRecording || !clip) {
      els.hint.textContent = "Recording cancelled.";
      clip = null;
      await refresh();
      return;
    }
    const last = clip.frames[clip.frames.length - 1];
    clip.durationMs = last ? last.t : 0;
    if (clip.frames.length < 10) {
      els.hint.textContent = "Too short to save. Record for at least a couple of seconds.";
      clip = null;
      await refresh();
      return;
    }
    clip.fps = Math.round((clip.frames.length / Math.max(1, clip.durationMs)) * 1000);
    const noFace = clip.frames.filter((f) => !f.f).length / clip.frames.length;
    try {
      await clipStore.put(clip);
      els.hint.textContent =
        `Saved ${fmtTime(clip.durationMs)} of "${labelInfo(clip.label).name}".` +
        (noFace > 0.5 ? " Warning: your face wasn't found in most frames; check lighting and framing." : "");
    } catch (err) {
      console.error(err);
      els.hint.textContent = "Couldn't save the clip (browser storage blocked or full).";
    }
    clip = null;
    els.notes.value = "";
    await refresh();
  }

  function setFormDisabled(disabled) {
    [els.label, els.area, els.length, els.notes, els.score, els.exportBtn, els.importBtn, els.clearBtn].forEach((e) => (e.disabled = disabled));
  }

  els.btn.addEventListener("click", () => {
    if (state === "idle") begin();
    else finish(state === "recording");
  });

  // ----- list -----
  async function refresh() {
    try {
      clips = await clipStore.all();
    } catch {
      clips = [];
    }
    const pos = clips.filter((c) => c.expected === "alert").length;
    const total = clips.reduce((s, c) => s + (c.durationMs || 0), 0);
    els.summary.textContent = clips.length
      ? `${clips.length} clip${clips.length === 1 ? "" : "s"}, ${fmtTime(total)} total: ${pos} should alert, ${clips.length - pos} should not.`
      : "No clips yet.";
    els.list.replaceChildren(
      ...clips
        .slice()
        .reverse()
        .map((c) => {
          const li = document.createElement("li");
          const tag = c.expected === "alert" ? "yes" : "no";
          li.innerHTML = `<span class="tag tag-${tag}" title="${c.expected === "alert" ? "Should alert" : "Should not alert"}">${tag === "yes" ? "Alert" : "No alert"}</span>
            <span class="clip-name"></span><span class="hint">${fmtTime(c.durationMs || 0)}</span>
            <button class="btn-icon" title="Delete clip" aria-label="Delete clip">&times;</button>`;
          li.querySelector(".clip-name").textContent = labelInfo(c.label).name + (c.area ? ` (${c.area})` : "") + (c.notes ? `: ${c.notes}` : "");
          li.querySelector("button").addEventListener("click", async () => {
            await clipStore.remove(c.id);
            await refresh();
          });
          return li;
        }),
    );
    const empty = clips.length === 0;
    els.exportBtn.disabled = empty;
    els.clearBtn.disabled = empty;
    els.score.disabled = empty;
  }

  // ----- export / import -----
  els.exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(makeDataset(clips))], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `skinshield-recordings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    let added = 0;
    try {
      for (const file of els.importFile.files) {
        for (const c of parseDataset(await file.text())) {
          await clipStore.put({ ...c, id: c.id || crypto.randomUUID(), expected: c.expected || labelInfo(c.label).expected });
          added++;
        }
      }
      els.hint.textContent = `Imported ${added} clip${added === 1 ? "" : "s"}.`;
    } catch (err) {
      els.hint.textContent = `Import failed: ${err.message}`;
    }
    els.importFile.value = "";
    await refresh();
  });
  els.clearBtn.addEventListener("click", async () => {
    if (!confirm(`Delete all ${clips.length} recorded clips on this device? Export them first if you want to keep them.`)) return;
    await clipStore.clear();
    els.scoreOut.hidden = true;
    await refresh();
  });

  // ----- scoring -----
  els.score.addEventListener("click", () => {
    const prefs = getContext().prefs;
    const res = evaluateClips(clips, settingsFor(prefs));
    const missed = res.rows.filter((r) => r.expected === "alert" && !r.correct);
    const wrong = res.rows.filter((r) => r.expected !== "alert" && !r.correct);
    const name = (r) => labelInfo(r.clip.label).name + (r.clip.area ? ` (${r.clip.area})` : "");
    els.scoreOut.hidden = false;
    els.scoreOut.innerHTML = `
      <p class="hint">At sensitivity ${prefs.sensitivity}, alert after ${prefs.dwell} s:</p>
      <dl class="score-grid">
        <dt>Picking caught</dt><dd>${res.positives ? `${pct(res.catchRate)} (${res.positives - missed.length} of ${res.positives})` : "no picking clips"}</dd>
        <dt>False alarms</dt><dd>${res.negatives ? `${res.falseAlarms} in ${res.falseAlarmClips} of ${res.negatives} clips` : "no other clips"}</dd>
        <dt>Typical time to alert</dt><dd>${res.medianTimeToAlertMs === null ? "n/a" : `${(res.medianTimeToAlertMs / 1000).toFixed(1)} s`}</dd>
        <dt>Area named correctly</dt><dd>${pct(res.areaAccuracy)}</dd>
      </dl>
      ${missed.length ? `<p class="hint"><strong>Missed:</strong> ${missed.map(name).join(", ")}</p>` : ""}
      ${wrong.length ? `<p class="hint"><strong>False alarms on:</strong> ${wrong.map(name).join(", ")}</p>` : ""}`;
  });

  refresh();
  setEnabled(false);
  return {
    get recording() {
      return state === "recording";
    },
    get busy() {
      return state !== "idle";
    },
    captureFrame,
    setEnabled,
    cancel: () => state !== "idle" && finish(false),
  };
}
