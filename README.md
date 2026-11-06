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
| **Fidgeting** | Small back-and-forth fingertip motion at one spot (scratching), which separates picking from resting your chin on your hand |
| **Depth check** | Palm size vs face size; a hand much larger than the face is in front of the camera, not on your skin |

A frame only counts when these add up above the sensitivity threshold. An alert fires once the behaviour lasts longer than the **Alert after** setting (1.5 s by default), tolerating brief tracking dropouts, followed by a quiet period so you aren't spammed.

Each episode is labelled with the area being touched (forehead, nose, cheeks, mouth, chin, jaw) so you can see patterns over the day and week.

## Settings

- **Sensitivity**: lower for fewer false alarms, higher to catch subtler picking.
- **Alert after**: how long picking must continue before you're nudged.
- **Quiet time between alerts**.
- **Watch the mouth area**: turn off if eating or drinking causes alerts; leave on to catch nail biting.
- **Only pinching and scratching**: when off, any hand resting on the face counts.
- **That wasn't picking** on an alert marks it as a false alarm and removes it from your stats.

## Tips

- Monitoring keeps running while you use other apps. Put SkinShield in its own small browser window and allow notifications.
- Face the camera with reasonable lighting. The app works from a normal laptop seating distance.
- Snooze for 15 minutes when you're eating, applying skincare or on a video call.

## Development

```bash
npm test
```

Runs unit tests for the detection and episode logic with synthetic landmarks (`test/detector.test.js`).

```
public/
  index.html        UI
  css/styles.css
  js/app.js         camera, MediaPipe, detection loop, UI wiring
  js/detector.js    pure scoring + episode tracking (unit tested)
  js/alerts.js      chime, notifications, messages
  js/stats.js       local episode history
server.js           zero-dependency static server (serves MediaPipe from node_modules)
scripts/download-models.js
```

SkinShield is a self-awareness tool, not a medical device. If skin picking is causing you distress, a dermatologist or a therapist familiar with body-focused repetitive behaviours (for example habit reversal training) can help.
