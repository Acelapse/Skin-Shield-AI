// Episode history kept in localStorage on this device only.
const KEY = "skinshield.events.v1";
const KEEP_DAYS = 90;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(events) {
  try {
    localStorage.setItem(KEY, JSON.stringify(events));
  } catch {
    /* storage unavailable (private mode): history just won't persist */
  }
}

export class Stats {
  constructor() {
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    this.events = load()
      .filter((e) => e.at > cutoff)
      .sort((a, b) => a.at - b.at);
  }

  add(event) {
    const e = { id: crypto.randomUUID?.() || String(Date.now()), falseAlarm: false, ...event };
    this.events.push(e);
    save(this.events);
    return e;
  }

  markFalseAlarm(id) {
    const e = this.events.find((x) => x.id === id);
    if (e) {
      e.falseAlarm = true;
      save(this.events);
    }
  }

  clear() {
    this.events = [];
    save(this.events);
  }

  get real() {
    return this.events.filter((e) => !e.falseAlarm);
  }

  summary(now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const real = this.real;
    const today = real.filter((e) => e.at >= start.getTime());
    const zones = {};
    for (const e of today) zones[e.zone || "face"] = (zones[e.zone || "face"] || 0) + 1;
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d0 = new Date(start);
      d0.setDate(d0.getDate() - i);
      const d1 = new Date(d0);
      d1.setDate(d1.getDate() + 1);
      week.push({
        label: d0.toLocaleDateString(undefined, { weekday: "narrow" }),
        count: real.filter((e) => e.at >= d0.getTime() && e.at < d1.getTime()).length,
        today: i === 0,
      });
    }
    const last = real[real.length - 1];
    return {
      todayCount: today.length,
      zones: Object.entries(zones).sort((a, b) => b[1] - a[1]),
      week,
      lastAt: last?.at ?? null,
      recent: real.slice(-6).reverse(),
    };
  }
}

export function formatAgo(ms) {
  if (ms < 60e3) return "<1 min";
  const m = Math.floor(ms / 60e3);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}
