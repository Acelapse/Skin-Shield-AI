# Skin-Shield-AI

SkinShield AI (working title: Break the Habit) is a real-time computer vision application that uses your laptop's webcam to detect hands micro-gesturing toward your face, specifically targeted at stopping stress-induced skin picking (dermatillomania), nail biting, hair pulling (trichotillomania), and absentminded touching.

When it sees you pinching, squeezing or scratching at your face (pimples, acne, cysts, scabs) for more than a moment, it gives you a gentle nudge: a soft chime, an on-screen card (or a desktop notification if you're in another window), and an optional 30-second guided breathing exercise.

**Private by design:** all video processing happens in your browser tab. No frames are recorded, stored or uploaded. Episode history (time and face area only) is kept in your browser's local storage and can be cleared at any time.

## Quick start

Requires Node.js 18+ and a browser with webcam access (Chrome, Edge, Firefox, Safari).

```bash
npm install
npm start
```

Open http://localhost:5173, click **Start monitoring** and allow camera access.

Optional, to run fully offline (otherwise the two models, about 12 MB, download from Google's model CDN on first use):

```bash
npm run models
```

## How detection works

SkinShield runs two MediaPipe models on every frame: a hand landmarker (21 points per hand) and a face landmarker (478 points). The logic in `public/js/detector.js` then scores each frame:

| Signal | What it measures |
| --- | --- |
| **Proximity** | Whether the contact point is inside the face outline, or within a small margin of it |
| **Pinch posture** | Thumb tip meeting the index or middle fingertip, the typical picking/squeezing grip |
| **Two-finger squeeze** | The nose held between the index and middle fingers (no thumb), with the ring and little fingers straight |
| **Hand shape** | Picking keeps the working fingers apart from the rest; resting a chin, rubbing eyes or holding food bunches or curls them |
| **Fidgeting** | Small back-and-forth fingertip motion at one spot (scratching), which separates picking from resting your chin on your hand |
| **Depth check** | Palm size vs face size; a hand much larger than the face is in front of the camera, not on your skin |

A frame only counts when these add up above the sensitivity threshold. An alert fires once the behaviour lasts longer than the **Alert after** setting (1.5 s by default), tolerating brief tracking dropouts, followed by a quiet period so you aren't spammed.

Each episode is labelled with the area being touched (forehead, nose, cheeks, mouth, chin, jaw) so you can see patterns over the day and week.

## Settings

- **Alert on any touch**: the simplest, strictest mode. Alerts within a quarter of a second whenever any part of either hand overlaps your face, whatever the hand is doing. Sensitivity, the alert delay and the mouth and pinch options are paused while it's on (learning keeps tuning them in the background). Expect alerts for eating, chin resting and eye rubbing too; use Snooze for those times.
- **Sensitivity**: lower for fewer false alarms, higher to catch subtler picking.
- **Alert after**: how long picking must continue before you're nudged.
- **Quiet time between alerts**.
- **Watch the mouth area**: turn off if eating or drinking causes alerts; leave on to catch nail biting.
- **Only pinching and scratching**: when off, any hand resting on the face counts.
- **That wasn't picking** on an alert marks it as a false alarm and removes it from your stats.

## Tips

- Use the **Camera** menu under the video to switch between your built-in webcam and an external one. It switches live, and your choice is remembered next time.
- Monitoring keeps running while you use other apps. Put SkinShield in its own small browser window and allow notifications.
- Face the camera with reasonable lighting. The app works from a normal laptop seating distance.
- Snooze for 15 minutes when you're eating, applying skincare or on a video call.

## Learning: it adapts to you

SkinShield tunes itself to your habits from examples, all kept on your device:

- **Answer alerts.** "That wasn't picking" saves the few seconds around the alert as a false-alarm example; "I've stopped" or "Breathe with me" saves it as confirmed picking.
- **Press "Missed one"** (under the video) right after picking that wasn't caught, to save the last 8 seconds as an example.
- **Record test clips** (below) for more deliberate examples.

Once there are at least 3 picking and 3 non-picking examples, every new example triggers learning in the background: it replays all of them at each combination of **sensitivity** and **hand shape** (how spread your fingers must be), and picks the one that makes the fewest mistakes (missed picking, false alarms and slow alerts), preferring settings whose neighbours also do well, so it doesn't chase luck with few examples. If that is clearly better than your current settings, it is applied with a notice and an **Undo** button (or just offered, if you turn off *Apply improvements automatically*). An undone change isn't re-applied on its own until 5 more examples have come in. The **Learning** panel shows your examples, the current fit and the before/after result, and can reset to the defaults.

Only tracking points are saved for examples (never video); the newest 200 automatic examples are kept.

## Test recordings: measure accuracy for yourself

The **Test recordings** panel (bottom of the sidebar) records short labelled clips so you can see how well detection works for your face, lighting and habits. Only the tracking points are saved, never video, and they stay in your browser unless you export them.

1. Click **Start monitoring**, then open **Test recordings**.
2. Choose what you'll do (for example "Picking or squeezing" on the chin, or "Resting chin on hand"), a length, and optional notes such as "dim light".
3. Click **Record**. After a 3 second countdown, do that action until the recording stops. Alerts don't pop up during a recording.
4. Record a mix: several clips of real picking or scratching, and several of things that should *not* alert (resting your chin, rubbing your eyes, drinking, normal work).
5. Click **Score with current settings** to see how much picking was caught and how many false alarms there were at your current settings.

To compare every sensitivity level at once, click **Export**, save the file into the `recordings/` folder, and run:

```bash
npm run evaluate
```

It prints the catch rate, false alarms, time to alert and how often the face area was named correctly at sensitivities 1 to 10, shows what the app's learning would choose, and lists which clips were missed. Options: `--sensitivity 7` for per-clip detail at one level, `--hand-shape 0.45`, `--explain` to show which signals (pinch, fidgeting, position, hand size) were behind each clip's alerts, `--dwell 2`, `--no-mouth`, `--no-pinch`. The `recordings/` folder is ignored by git.

The same examples could later train a personal model if tuning these two settings stops being enough.

## Development

```bash
npm test
```

Runs unit tests for the detection, episode, recording and scoring logic with synthetic landmarks (`test/`).

```
public/
  index.html        UI
  css/styles.css
  js/app.js         camera, MediaPipe, detection loop, UI wiring
  js/detector.js    pure scoring + episode tracking (unit tested)
  js/alerts.js      chime, notifications, messages
  js/stats.js       local episode history
  js/recording.js   recording format, replay and scoring (unit tested)
  js/recorder.js    Test recordings panel
  js/clipstore.js   clip storage (IndexedDB)
  js/learn.js       personal tuning from examples (unit tested)
  js/learn-worker.js  runs tuning off the main thread
  js/learner.js     example capture from alerts, Learning panel
server.js           zero-dependency static server (serves MediaPipe from node_modules)
scripts/download-models.js
scripts/evaluate.js         scores exported recordings at every sensitivity
```

SkinShield is a self-awareness tool, not a medical device. If skin picking is causing you distress, a dermatologist or a therapist familiar with body-focused repetitive behaviours (for example habit reversal training) can help.
