// Optional: download the MediaPipe models into public/models so the app works
// fully offline. Without this the app fetches them from Google's model CDN.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../public/models/", import.meta.url));
const models = {
  "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

await mkdir(dir, { recursive: true });
for (const [name, url] of Object.entries(models)) {
  process.stdout.write(`Downloading ${name}... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dir + name, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}
