import { FACE_OVAL, FACE_ZONES } from "../public/js/detector.js";

// Synthetic face centred at (0.5, 0.5): an ellipse 0.2 wide, 0.28 tall.
export function makeFace(cx = 0.5, cy = 0.5, rx = 0.1, ry = 0.14) {
  const pts = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  FACE_OVAL.forEach((idx, k) => {
    // FACE_OVAL starts at the forehead (10) and goes clockwise in image space.
    const a = -Math.PI / 2 + (k / FACE_OVAL.length) * Math.PI * 2;
    pts[idx] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), z: 0 };
  });
  const place = (name, x, y) => FACE_ZONES[name].forEach((i) => (pts[i] = { x, y, z: 0 }));
  place("forehead", cx, cy - ry * 0.75);
  place("nose", cx, cy);
  // The person's right cheek is on the left of the camera image.
  place("right cheek", cx - rx * 0.6, cy + ry * 0.1);
  place("left cheek", cx + rx * 0.6, cy + ry * 0.1);
  place("mouth", cx, cy + ry * 0.45);
  place("chin", cx, cy + ry * 0.85);
  place("jaw", cx - rx * 0.8, cy + ry * 0.6);
  // re-pin oval anchors that zones may have overwritten
  pts[10] = { x: cx, y: cy - ry, z: 0 };
  pts[152] = { x: cx, y: cy + ry, z: 0 };
  pts[234] = { x: cx - rx, y: cy, z: 0 };
  pts[454] = { x: cx + rx, y: cy, z: 0 };
  return pts;
}

// Synthetic hand: wrist below the fingertip `tip`, palm length `palm`.
// `pinch` brings the thumb tip to the index tip.
export function makeHand(tip, { palm = 0.1, pinch = true } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x: tip.x, y: tip.y + palm, z: 0 }));
  pts[0] = { x: tip.x, y: tip.y + palm * 1.9, z: 0 }; // wrist
  pts[9] = { x: tip.x, y: tip.y + palm * 0.9, z: 0 }; // middle MCP
  pts[8] = { ...tip, z: 0 }; // index tip
  pts[12] = { x: tip.x + palm * 0.2, y: tip.y + palm * 0.1, z: 0 };
  pts[16] = { x: tip.x + palm * 0.35, y: tip.y + palm * 0.3, z: 0 };
  pts[20] = { x: tip.x + palm * 0.5, y: tip.y + palm * 0.5, z: 0 };
  pts[4] = pinch ? { x: tip.x - palm * 0.05, y: tip.y + palm * 0.03, z: 0 } : { x: tip.x - palm * 0.8, y: tip.y + palm * 0.6, z: 0 };
  return pts;
}

