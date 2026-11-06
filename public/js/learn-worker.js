// Runs learning off the main thread so detection keeps running smoothly.
import { learnSettings } from "./learn.js";

self.onmessage = (e) => {
  const { id, clips, prefs } = e.data;
  try {
    let last = 0;
    const result = learnSettings(clips, prefs, (p) => {
      if (p - last >= 0.1 || p === 1) {
        last = p;
        self.postMessage({ id, progress: p });
      }
    });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
