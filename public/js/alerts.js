// Ways of nudging the user: soft chime, repeating alarm, desktop notification,
// title flash.

let ctx = null;

// Must be called from a user gesture (the Start button) so audio is allowed later.
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    ctx = null;
  }
}

// Two-note soft chime: noticeable without being startling.
export function chime() {
  if (!ctx) return;
  const t = ctx.currentTime;
  [
    [659.25, 0],
    [880, 0.18],
  ].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t + delay);
    gain.gain.linearRampToValueAtTime(0.18, t + delay + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 1);
  });
}

export async function requestNotifications() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") return Notification.requestPermission();
  return Notification.permission;
}

let current = null;

// `persistent`: the notification stays on screen until clicked or dismissed,
// instead of disappearing after a few seconds.
export function notify(title, body, { persistent = false } = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    current?.close();
    const n = new Notification(title, { body, tag: "skinshield", renotify: true, silent: true, requireInteraction: persistent });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    if (!persistent) setTimeout(() => n.close(), 8000);
    current = n;
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export function closeNotification() {
  current?.close();
  current = null;
}

// Repeating alarm: three quick beeps, a pause, repeat. The pattern is one audio
// buffer looped by the audio engine itself, so it keeps sounding in a
// background tab or minimized window, where the browser slows down timers.
let alarm = null;
export function startAlarm(volume = 0.35) {
  if (!ctx || alarm) return;
  if (ctx.state === "suspended") ctx.resume();
  const rate = ctx.sampleRate;
  const period = 1.6; // seconds per loop
  const buf = ctx.createBuffer(1, Math.round(rate * period), rate);
  const data = buf.getChannelData(0);
  for (const start of [0, 0.22, 0.44]) {
    const len = 0.16;
    for (let i = 0; i < len * rate; i++) {
      const t = i / rate;
      const env = Math.min(1, t / 0.01, (len - t) / 0.02); // short fade in/out avoids clicks
      // Two tones together sound more like an alarm than a pure sine.
      data[Math.round(start * rate) + i] = env * 0.5 * (Math.sin(2 * Math.PI * 880 * t) + 0.6 * Math.sin(2 * Math.PI * 1320 * t));
    }
  }
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buf;
  src.loop = true;
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start();
  alarm = src;
}

export function stopAlarm() {
  try {
    alarm?.stop();
  } catch {
    /* already stopped */
  }
  alarm = null;
}

export const alarmSounding = () => alarm !== null;

let flashTimer = null;
const ORIGINAL_TITLE = "SkinShield";

// Flashes the tab title. With `untilStopped`, it keeps flashing until
// stopFlashing() is called.
export function flashTitle(text, { untilStopped = false } = {}) {
  clearInterval(flashTimer);
  let on = true;
  let n = 0;
  flashTimer = setInterval(() => {
    document.title = on ? text : ORIGINAL_TITLE;
    on = !on;
    if (!untilStopped && ++n > 10) stopFlashing();
  }, 700);
}

export function stopFlashing() {
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = ORIGINAL_TITLE;
}

const LINES = [
  "Your fingers found your {zone}. Let them rest for a moment.",
  "Looks like you're picking at your {zone}. Unclench, breathe out slowly.",
  "Fidgeting with your {zone}? Try squeezing a stress ball or pressing your palms together instead.",
  "Hands off your {zone} for now. What are you feeling right now?",
  "You caught it. Lower your hands, drop your shoulders, take one slow breath.",
];

export function message(zone) {
  const line = LINES[Math.floor(Math.random() * LINES.length)];
  return line.replace("{zone}", zone || "face");
}
