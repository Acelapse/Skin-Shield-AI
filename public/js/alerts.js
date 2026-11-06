// Ways of nudging the user: soft chime, desktop notification, title flash.

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

export function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: "skinshield", renotify: true, silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    setTimeout(() => n.close(), 8000);
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

let flashTimer = null;
export function flashTitle(text) {
  const original = "SkinShield";
  clearInterval(flashTimer);
  let on = true;
  let n = 0;
  flashTimer = setInterval(() => {
    document.title = on ? text : original;
    on = !on;
    if (++n > 10) {
      clearInterval(flashTimer);
      document.title = original;
    }
  }, 700);
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
