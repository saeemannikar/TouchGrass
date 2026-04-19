// TouchGrass - JS Unit Tests
// Run with: npx vitest run
// Tests: GestureClassifier, LSTMGestureClassifier data pipeline, UndoStack JS wrapper

import { describe, it, expect, beforeEach } from 'vitest';
import { GestureClassifier, GestureType } from '../src/lib/gestureClassifier.js';
import { LSTMGestureClassifier } from '../src/lib/lstmClassifier.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLandmarks(overrides = {}) {
  // 21 landmarks, all at origin by default
  const pts = Array.from({ length: 21 }, (_, i) => ({
    x: 0.5, y: 0.5, z: 0.0,
    ...overrides[i],
  }));
  return pts;
}

function makeOpenPalmLandmarks() {
  // Simulate open palm: fingertips extended above wrist
  const pts = makeLandmarks();
  // Wrist at center
  pts[0]  = { x: 0.5, y: 0.8, z: 0.0 };
  // Fingertips above wrist (lower y = higher in image)
  pts[8]  = { x: 0.5, y: 0.3, z: -0.05 }; // index tip
  pts[12] = { x: 0.5, y: 0.28, z: -0.05 }; // middle tip
  pts[16] = { x: 0.5, y: 0.3, z: -0.05 }; // ring tip
  pts[20] = { x: 0.5, y: 0.35, z: -0.05 }; // pinky tip
  pts[4]  = { x: 0.35, y: 0.45, z: -0.03 }; // thumb tip
  // MCPs below fingertips
  pts[5]  = { x: 0.5, y: 0.6, z: 0.0 }; // index MCP
  pts[9]  = { x: 0.5, y: 0.58, z: 0.0 };
  pts[13] = { x: 0.5, y: 0.6, z: 0.0 };
  pts[17] = { x: 0.5, y: 0.62, z: 0.0 };
  return pts;
}

function makePinchLandmarks() {
  const pts = makeLandmarks();
  pts[0]  = { x: 0.5, y: 0.8, z: 0.0 };
  // Thumb and index tips very close together
  pts[4]  = { x: 0.5, y: 0.5, z: -0.02 };
  pts[8]  = { x: 0.503, y: 0.5, z: -0.02 };
  pts[5]  = { x: 0.5, y: 0.65, z: 0.0 };
  pts[9]  = { x: 0.5, y: 0.63, z: 0.0 };
  return pts;
}

function makeFistLandmarks() {
  const pts = makeLandmarks();
  pts[0]  = { x: 0.5, y: 0.8, z: 0.0 };
  // All fingertips curled -- close to MCP
  pts[4]  = { x: 0.48, y: 0.75, z: 0.01 };
  pts[8]  = { x: 0.5, y: 0.72, z: 0.01 };
  pts[12] = { x: 0.5, y: 0.71, z: 0.01 };
  pts[16] = { x: 0.5, y: 0.72, z: 0.01 };
  pts[20] = { x: 0.5, y: 0.73, z: 0.01 };
  pts[5]  = { x: 0.5, y: 0.7, z: 0.0 };
  pts[9]  = { x: 0.5, y: 0.68, z: 0.0 };
  pts[13] = { x: 0.5, y: 0.7, z: 0.0 };
  pts[17] = { x: 0.5, y: 0.72, z: 0.0 };
  return pts;
}

function makeHand(landmarks, handedness = 'Right', score = 0.95) {
  // Simulate what the worker produces with feature extraction
  const thumbTip  = landmarks[4];
  const indexTip  = landmarks[8];
  const middleTip = landmarks[12];
  const ringTip   = landmarks[16];
  const pinkyTip  = landmarks[20];
  const wrist     = landmarks[0];
  const indexMCP  = landmarks[5];

  const dist3 = (a, b) => Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2+(a.z-b.z)**2);

  const pinchDist = dist3(thumbTip, indexTip);
  const palmSize  = dist3(wrist, indexMCP);

  // Rough extendedness based on tip-to-wrist distance
  const ext = (tip, mcp) => Math.min(dist3(tip, mcp) / (dist3(wrist, mcp) * 1.5 + 0.001), 1.0);
  const indexExt  = ext(indexTip,  indexMCP);
  const middleExt = ext(middleTip, landmarks[9]);
  const ringExt   = ext(ringTip,   landmarks[13]);
  const pinkyExt  = ext(pinkyTip,  landmarks[17]);
  const thumbExt  = ext(thumbTip,  landmarks[3]);
  const openness  = (indexExt + middleExt + ringExt + pinkyExt) / 4;

  const spreadRatio = dist3(indexTip, pinkyTip) / Math.max(palmSize, 0.01);

  return {
    handedness,
    score,
    landmarks,
    features: {
      pinchDist,
      openness,
      palmPos: { x: (wrist.x + indexMCP.x) / 2, y: (wrist.y + indexMCP.y) / 2, z: 0 },
      palmNormal: { x: 0, y: 0, z: 1 },
      isFist:        openness < 0.25,
      isOpenPalm:    openness > 0.75,
      isPinching:    pinchDist < 0.06,
      isTwoFingerPinch: false,
      isSpread:      spreadRatio > 1.8 && openness > 0.6,
      thumbExt, indexExt, middleExt, ringExt, pinkyExt,
      fingerExtensions: [thumbExt, indexExt, middleExt, ringExt, pinkyExt],
    },
  };
}

// ─── GestureClassifier tests ──────────────────────────────────────────────────

describe('GestureClassifier', () => {
  let gc;
  beforeEach(() => { gc = new GestureClassifier(); });

  it('returns idle for empty hands', () => {
    const result = gc.update([]);
    expect(result.left.gesture).toBe(GestureType.IDLE);
    expect(result.right.gesture).toBe(GestureType.IDLE);
    expect(result.combined).toBeNull();
  });

  it('classifies open palm as push candidate', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    // Run multiple frames to get confirmed
    let result;
    for (let i = 0; i < 10; i++) { result = gc.update([hand]); }
    // Should not be idle -- open palm should score sculpt_push or similar
    expect(result.right.gesture).not.toBe(GestureType.IDLE);
    expect(result.right.confidence).toBeGreaterThan(0);
  });

  it('classifies pinch as pinching gesture', () => {
    const hand = makeHand(makePinchLandmarks(), 'Right');
    let result;
    for (let i = 0; i < 10; i++) { result = gc.update([hand]); }
    const g = result.right.gesture;
    expect([GestureType.GRAB_BLOB, GestureType.ORBIT, GestureType.SCULPT_PULL].includes(g)).toBe(true);
    expect(result.right.features.isPinching).toBe(true);
  });

  it('classifies fist as smooth candidate', () => {
    const hand = makeHand(makeFistLandmarks(), 'Right');
    let result;
    for (let i = 0; i < 10; i++) { result = gc.update([hand]); }
    expect(result.right.features.isFist).toBe(true);
  });

  it('increments frame count per frame', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    let result;
    for (let i = 0; i < 5; i++) { result = gc.update([hand]); }
    expect(result.right.frames).toBeGreaterThan(0);
  });

  it('confirms gesture after enough frames', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    let result;
    for (let i = 0; i < 8; i++) { result = gc.update([hand]); }
    expect(result.right.confirmed).toBe(true);
  });

  it('handles two hands independently', () => {
    const rHand = makeHand(makeOpenPalmLandmarks(), 'Right');
    const lHand = makeHand(makePinchLandmarks(),    'Left');
    let result;
    for (let i = 0; i < 6; i++) { result = gc.update([rHand, lHand]); }
    expect(result.right.gesture).not.toBe(result.left.gesture);
  });

  it('returns palmPos in result', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    const result = gc.update([hand]);
    expect(result.right.palmPos).toBeTruthy();
    expect(typeof result.right.palmPos.x).toBe('number');
  });

  it('detects two-hand zoom when both pinching', () => {
    const lHand = makeHand(makePinchLandmarks(), 'Left');
    const rHand = makeHand(makePinchLandmarks(), 'Right');
    // Separate palm positions
    lHand.features.palmPos = { x: 0.2, y: 0.5, z: 0 };
    rHand.features.palmPos = { x: 0.8, y: 0.5, z: 0 };
    let result;
    for (let i = 0; i < 6; i++) { result = gc.update([lHand, rHand]); }
    expect(result.combined).not.toBeNull();
    expect(result.combined.gesture).toBe(GestureType.ZOOM);
  });

  it('reset clears all state', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    for (let i = 0; i < 8; i++) { gc.update([hand]); }
    gc.reset();
    const result = gc.update([hand]);
    expect(result.right.frames).toBe(1);
    expect(result.right.confirmed).toBe(false);
  });

  it('confidence is between 0 and 1', () => {
    const hand = makeHand(makeOpenPalmLandmarks(), 'Right');
    for (let i = 0; i < 5; i++) {
      const result = gc.update([hand]);
      expect(result.right.confidence).toBeGreaterThanOrEqual(0);
      expect(result.right.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── LSTMGestureClassifier tests (no TF -- data pipeline only) ──────────────

describe('LSTMGestureClassifier (data pipeline)', () => {
  let lstm;
  beforeEach(() => { lstm = new LSTMGestureClassifier(); });

  it('initializes with empty training data', () => {
    const counts = lstm.getSampleCounts();
    Object.values(counts).forEach(c => expect(c).toBe(0));
  });

  it('recordFrame accumulates frames', () => {
    const lm = makeOpenPalmLandmarks();
    for (let i = 0; i < 14; i++) {
      const r = lstm.recordFrame(lm, GestureType.SCULPT_PUSH);
      expect(r.recorded).toBe(false);
    }
    // 15th frame completes the sequence
    const r = lstm.recordFrame(lm, GestureType.SCULPT_PUSH);
    expect(r.recorded).toBe(true);
    expect(r.total).toBe(1);
  });

  it('records multiple sequences correctly', () => {
    const lm = makeOpenPalmLandmarks();
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 15; i++) { lstm.recordFrame(lm, GestureType.SCULPT_PUSH); }
    }
    expect(lstm.getSampleCounts()[GestureType.SCULPT_PUSH]).toBe(3);
  });

  it('cancelRecording resets buffer', () => {
    const lm = makeOpenPalmLandmarks();
    for (let i = 0; i < 7; i++) { lstm.recordFrame(lm, GestureType.SCULPT_PUSH); }
    lstm.cancelRecording();
    // Next 15 frames should record a fresh sequence
    for (let i = 0; i < 15; i++) { lstm.recordFrame(lm, GestureType.SCULPT_PUSH); }
    expect(lstm.getSampleCounts()[GestureType.SCULPT_PUSH]).toBe(1);
  });

  it('ignores unknown class name', () => {
    const lm = makeOpenPalmLandmarks();
    for (let i = 0; i < 15; i++) {
      lstm.recordFrame(lm, 'unknown_gesture');
    }
    // Nothing should be recorded
    const counts = lstm.getSampleCounts();
    Object.values(counts).forEach(c => expect(c).toBe(0));
  });

  it('hasSufficientData returns false with no data', () => {
    expect(lstm.hasSufficientData()).toBe(false);
  });

  it('normalizes landmarks relative to wrist', () => {
    // Access private method via workaround for testing
    const lm = makeOpenPalmLandmarks();
    const norm = lstm._normalizeLandmarks(lm);
    // Wrist (landmark 0) should be at origin after normalization
    expect(Math.abs(norm[0])).toBeLessThan(0.001); // x
    expect(Math.abs(norm[1])).toBeLessThan(0.001); // y
    expect(Math.abs(norm[2])).toBeLessThan(0.001); // z
  });

  it('normalized output has correct size', () => {
    const lm = makeOpenPalmLandmarks();
    const norm = lstm._normalizeLandmarks(lm);
    expect(norm.length).toBe(21 * 3);
  });

  it('clearTrainingData empties all samples', () => {
    const lm = makeOpenPalmLandmarks();
    for (let i = 0; i < 15; i++) { lstm.recordFrame(lm, GestureType.SCULPT_PUSH); }
    lstm.clearTrainingData();
    const counts = lstm.getSampleCounts();
    Object.values(counts).forEach(c => expect(c).toBe(0));
    expect(lstm.isTrained).toBe(false);
  });

  it('loadTrainingData round-trips correctly', async () => {
    const lm = makeOpenPalmLandmarks();
    // Record some samples
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < 15; i++) { lstm.recordFrame(lm, GestureType.SCULPT_PUSH); }
    }

    // Fake save (just serialize training data)
    const td = {};
    const cls = GestureType.SCULPT_PUSH;
    td[cls] = lstm._trainingData[cls].map(seq => seq.map(f => Array.from(f)));
    // Add empty arrays for other classes
    ['sculpt_pull','sculpt_smooth','sculpt_flatten','sculpt_inflate','grab_blob','orbit','idle']
      .forEach(c => { td[c] = []; });

    const json = JSON.stringify(td);

    // New instance loads it
    const lstm2 = new LSTMGestureClassifier();
    const ok = lstm2.loadTrainingData(json);
    expect(ok).toBe(true);
    expect(lstm2.getSampleCounts()[GestureType.SCULPT_PUSH]).toBe(2);
  });

  it('infer returns null when untrained', async () => {
    const lm = makeOpenPalmLandmarks();
    const result = await lstm.infer(lm);
    expect(result).toBeNull();
  });
});

// ─── GestureType constants ────────────────────────────────────────────────────

describe('GestureType', () => {
  it('has all required gesture types', () => {
    const required = ['SCULPT_PUSH','SCULPT_PULL','SCULPT_SMOOTH','SCULPT_FLATTEN',
                      'SCULPT_INFLATE','GRAB_BLOB','ORBIT','ZOOM','IDLE'];
    required.forEach(k => {
      expect(GestureType[k]).toBeDefined();
    });
  });

  it('gesture values are unique strings', () => {
    const vals = Object.values(GestureType);
    const unique = new Set(vals);
    expect(unique.size).toBe(vals.length);
  });
});
