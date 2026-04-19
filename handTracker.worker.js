// TouchGrass - Hand Tracking Worker
// Runs MediaPipe Hands inference in a Web Worker
// Sends landmark data back to main thread at ~20fps
// Main thread render loop stays at 60fps, completely unblocked

// MediaPipe loads via CDN inside the worker
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/hands.js');

let hands = null;
let running = false;
let frameCount = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`,
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,      // 0=lite, 1=full. Full for accuracy
    minDetectionConfidence: 0.7,
    minTrackingConfidence:  0.6,
  });

  hands.onResults(onResults);

  await hands.initialize();
  postMessage({ type: 'ready' });
}

// ─── Per-frame results ────────────────────────────────────────────────────────

function onResults(results) {
  frameCount++;

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    postMessage({ type: 'hands', hands: [] });
    return;
  }

  const parsed = results.multiHandLandmarks.map((landmarks, i) => {
    const handedness = results.multiHandedness[i].label; // 'Left' | 'Right'
    const score      = results.multiHandedness[i].score;

    // Raw 21 landmarks (normalized 0-1 in image space)
    const pts = landmarks.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));

    // Derived features -- precomputed here to keep main thread light
    return {
      handedness,
      score,
      landmarks: pts,
      features: extractFeatures(pts, handedness),
    };
  });

  postMessage({ type: 'hands', hands: parsed, frameCount });
}

// ─── Feature extraction ───────────────────────────────────────────────────────
// All computed from the 21 MediaPipe landmark indices:
// 0=Wrist, 1-4=Thumb, 5-8=Index, 9-12=Middle, 13-16=Ring, 17-20=Pinky

function extractFeatures(pts, handedness) {
  const wrist  = pts[0];
  const thumbTip  = pts[4];
  const indexTip  = pts[8];
  const middleTip = pts[12];
  const ringTip   = pts[16];
  const pinkyTip  = pts[20];

  const indexMCP = pts[5];   // knuckle base
  const middleMCP= pts[9];
  const thumbIP  = pts[3];

  // ── Pinch distance (thumb tip <-> index tip) ───────────────────────────────
  const pinchDist = dist3(thumbTip, indexTip);

  // ── Finger extension (0=curled, 1=extended) ──────────────────────────────
  // Compare tip z vs MCP z (negative z = closer to camera in MediaPipe)
  const thumbExt  = extendedness(pts[4], pts[2], pts[0]);
  const indexExt  = extendedness(pts[8], pts[6], pts[5]);
  const middleExt = extendedness(pts[12], pts[10], pts[9]);
  const ringExt   = extendedness(pts[16], pts[14], pts[13]);
  const pinkyExt  = extendedness(pts[20], pts[18], pts[17]);

  // ── Hand openness (0=fist, 1=flat open) ──────────────────────────────────
  const openness = (indexExt + middleExt + ringExt + pinkyExt) / 4;

  // ── Palm normal (rough facing direction) ──────────────────────────────────
  const palmCenter = midpoint(indexMCP, pts[13]); // avg of index+ring MCP
  const palmNormal = normalize3(subtract3(palmCenter, wrist));

  // ── Wrist velocity placeholder (filled by main thread from history) ───────
  // ── Palm position (center of hand) ───────────────────────────────────────
  const palmPos = {
    x: (wrist.x + palmCenter.x) / 2,
    y: (wrist.y + palmCenter.y) / 2,
    z: (wrist.z + palmCenter.z) / 2,
  };

  // ── Fist detection ───────────────────────────────────────────────────────
  const isFist = openness < 0.25;

  // ── Open palm detection (all fingers extended) ──────────────────────────
  const isOpenPalm = openness > 0.75;

  // ── Pinch detection ──────────────────────────────────────────────────────
  const isPinching = pinchDist < 0.06;

  // ── Two-finger pinch (index + middle, for precision) ─────────────────────
  const twoFingerDist = dist3(thumbTip, middleTip);
  const isTwoFingerPinch = twoFingerDist < 0.07 && indexExt < 0.4;

  // ── Spread fingers (for inflate gesture) ─────────────────────────────────
  // Distance between index tip and pinky tip normalized by palm size
  const palmSize = dist3(wrist, indexMCP);
  const spreadRatio = dist3(indexTip, pinkyTip) / Math.max(palmSize, 0.01);
  const isSpread = spreadRatio > 1.8 && openness > 0.6;

  return {
    pinchDist,
    openness,
    palmPos,
    palmNormal,
    isFist,
    isOpenPalm,
    isPinching,
    isTwoFingerPinch,
    isSpread,
    thumbExt,
    indexExt,
    middleExt,
    ringExt,
    pinkyExt,
    fingerExtensions: [thumbExt, indexExt, middleExt, ringExt, pinkyExt],
  };
}

// ─── Process frame from main thread ──────────────────────────────────────────

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    await init();
  }

  if (type === 'frame' && hands) {
    // e.data.bitmap is an ImageBitmap from the video frame
    await hands.send({ image: e.data.bitmap });
    e.data.bitmap.close();
  }

  if (type === 'stop') {
    running = false;
  }
};

// ─── Math helpers ─────────────────────────────────────────────────────────────

function dist3(a, b) {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}

function subtract3(a, b) {
  return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z };
}

function midpoint(a, b) {
  return { x: (a.x+b.x)/2, y: (a.y+b.y)/2, z: (a.z+b.z)/2 };
}

function normalize3(v) {
  const m = Math.sqrt(v.x**2 + v.y**2 + v.z**2) || 1;
  return { x: v.x/m, y: v.y/m, z: v.z/m };
}

// Extendedness: how straight is finger tip vs its MCP base
// Returns 0 (fully curled) to 1 (fully extended)
function extendedness(tip, pip, mcp) {
  // Use y-distance -- in image coords, extended fingers have tip higher (smaller y) than MCP
  // Also account for z depth
  const tipToMCP = dist3(tip, mcp);
  const pipToMCP = dist3(pip, mcp);
  // Extended: tip is far from MCP; curled: tip is close
  const palmRef = dist3(mcp, { x: mcp.x, y: mcp.y + 0.1, z: mcp.z }); // ~0.1 unit
  return Math.min(tipToMCP / (pipToMCP * 1.7 + 0.001), 1.0);
}
