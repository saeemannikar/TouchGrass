// TouchGrass - Gesture Classifier
// Rule-based classifier over sliding window of hand feature frames
// Phase 3 will replace this core with a trained LSTM
// For now: deterministic rules with hysteresis and confidence scoring

// ─── Gesture definitions ──────────────────────────────────────────────────────
//
// SCULPT_PUSH    -- open palm moving toward mesh surface
// SCULPT_PULL    -- pinch + move away from surface
// SCULPT_SMOOTH  -- fist, gentle rubbing motion
// SCULPT_FLATTEN -- flat palm, perpendicular to surface
// SCULPT_INFLATE -- spread fingers, hand cupping motion
// GRAB_BLOB      -- pinch on/near mesh, then translate
// ORBIT          -- pinch in empty space + move (no mesh contact)
// ZOOM           -- two-hand pinch + spread/close
// IDLE           -- no clear intent

export const GestureType = Object.freeze({
  SCULPT_PUSH:    'sculpt_push',
  SCULPT_PULL:    'sculpt_pull',
  SCULPT_SMOOTH:  'sculpt_smooth',
  SCULPT_FLATTEN: 'sculpt_flatten',
  SCULPT_INFLATE: 'sculpt_inflate',
  GRAB_BLOB:      'grab_blob',
  ORBIT:          'orbit',
  ZOOM:           'zoom',
  IDLE:           'idle',
});

// ─── Classifier ───────────────────────────────────────────────────────────────

export class GestureClassifier {
  constructor() {
    // Rolling window of recent frames per hand
    this._windowSize = 8;          // ~400ms at 20fps
    this._historyL = [];           // left hand frame history
    this._historyR = [];           // right hand frame history

    // Current confirmed gesture state (with hysteresis)
    this._currentL = { gesture: GestureType.IDLE, confidence: 0, frames: 0 };
    this._currentR = { gesture: GestureType.IDLE, confidence: 0, frames: 0 };

    // Hysteresis: gesture must hold for N frames before confirming
    this._confirmFrames = 3;
    // Gesture must drop below threshold for N frames before releasing
    this._releaseFrames = 4;
    this._releaseCounterL = 0;
    this._releaseCounterR = 0;

    // Velocity smoothing
    this._prevPosL = null;
    this._prevPosR = null;
    this._velL = { x: 0, y: 0, z: 0 };
    this._velR = { x: 0, y: 0, z: 0 };
    this._velAlpha = 0.35; // EMA smoothing
  }

  // ─── Main update ────────────────────────────────────────────────────────────

  /**
   * Call every frame with current hand data from MediaPipe worker.
   * Returns gesture intents for this frame.
   * @param {Array} hands - array of { handedness, features, landmarks }
   * @returns {{ left: GestureResult, right: GestureResult, combined: GestureResult|null }}
   */
  update(hands) {
    // Sort hands by handedness
    const leftHand  = hands.find(h => h.handedness === 'Left')  || null;
    const rightHand = hands.find(h => h.handedness === 'Right') || null;

    // Update velocity estimates
    this._updateVelocity(leftHand, 'L');
    this._updateVelocity(rightHand, 'R');

    // Classify each hand independently
    const leftResult  = this._classifyHand(leftHand,  this._historyL, this._currentL, 'L');
    const rightResult = this._classifyHand(rightHand, this._historyR, this._currentR, 'R');

    this._currentL = leftResult;
    this._currentR = rightResult;

    // Two-hand combined gesture (zoom etc.)
    const combined = this._classifyCombined(leftHand, rightHand, leftResult, rightResult);

    return { left: leftResult, right: rightResult, combined };
  }

  // ─── Per-hand classification ─────────────────────────────────────────────

  _classifyHand(hand, history, current, side) {
    if (!hand) {
      return { gesture: GestureType.IDLE, confidence: 0, frames: 0, palmPos: null, velocity: null };
    }

    const f = hand.features;
    const vel = side === 'L' ? this._velL : this._velR;

    // Push frame into history
    history.push({ features: f, velocity: { ...vel } });
    if (history.length > this._windowSize) history.shift();

    // ── Rule evaluation ────────────────────────────────────────────────────

    // Candidate gestures with confidence scores
    const candidates = [];

    // GRAB_BLOB: pinching (tight pinch, not moving fast)
    if (f.isPinching) {
      const speed = magnitude(vel);
      const moveConf = speed < 0.015 ? 0.85 : speed < 0.03 ? 0.6 : 0.3;
      candidates.push({ gesture: GestureType.GRAB_BLOB, confidence: moveConf * f.score });
    }

    // ORBIT: pinching in empty space (higher speed, wrist moving)
    if (f.isPinching) {
      const speed = magnitude(vel);
      if (speed > 0.008) {
        candidates.push({ gesture: GestureType.ORBIT, confidence: Math.min(speed * 40, 1.0) * 0.8 });
      }
    }

    // SCULPT_PUSH: open palm, fingers extended, moving toward viewer
    if (f.isOpenPalm && !f.isPinching) {
      const forwardMotion = -vel.z; // negative z = toward camera in MediaPipe
      const conf = f.openness * 0.6 + Math.max(0, forwardMotion * 20) * 0.4;
      candidates.push({ gesture: GestureType.SCULPT_PUSH, confidence: Math.min(conf, 1.0) });
    }

    // SCULPT_PULL: pinch + movement (faster than grab threshold)
    if (f.isPinching) {
      const speed = magnitude(vel);
      if (speed > 0.012) {
        candidates.push({ gesture: GestureType.SCULPT_PULL, confidence: Math.min(speed * 35, 1.0) * 0.9 });
      }
    }

    // SCULPT_SMOOTH: fist, slow lateral movement
    if (f.isFist) {
      const speed = magnitude(vel);
      const lateralSpeed = Math.sqrt(vel.x**2 + vel.y**2);
      const conf = f.isFist ? 0.5 + Math.min(lateralSpeed * 25, 0.5) : 0;
      candidates.push({ gesture: GestureType.SCULPT_SMOOTH, confidence: conf });
    }

    // SCULPT_FLATTEN: 4 fingers extended, low thumb extension, palm facing mesh
    if (f.indexExt > 0.7 && f.middleExt > 0.7 && f.ringExt > 0.7 && f.thumbExt < 0.5) {
      candidates.push({ gesture: GestureType.SCULPT_FLATTEN, confidence: 0.75 * f.openness });
    }

    // SCULPT_INFLATE: spread fingers, cupping motion
    if (f.isSpread) {
      candidates.push({ gesture: GestureType.SCULPT_INFLATE, confidence: 0.7 });
    }

    // IDLE fallback
    candidates.push({ gesture: GestureType.IDLE, confidence: 0.15 });

    // ── Pick best candidate ────────────────────────────────────────────────
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];

    // ── Hysteresis ─────────────────────────────────────────────────────────
    // If same gesture as current, increment frame counter
    if (best.gesture === current.gesture) {
      return {
        gesture: current.gesture,
        confidence: best.confidence,
        frames: current.frames + 1,
        confirmed: current.frames >= this._confirmFrames,
        palmPos: f.palmPos,
        velocity: { ...vel },
        features: f,
      };
    }

    // New gesture candidate -- only switch if current has faded or new is very confident
    const shouldSwitch = current.gesture === GestureType.IDLE
      || best.confidence > 0.7
      || current.frames === 0;

    if (shouldSwitch) {
      return {
        gesture: best.gesture,
        confidence: best.confidence,
        frames: 1,
        confirmed: false,
        palmPos: f.palmPos,
        velocity: { ...vel },
        features: f,
      };
    }

    // Hold current gesture
    return {
      ...current,
      frames: current.frames + 1,
      confirmed: current.frames >= this._confirmFrames,
      palmPos: f.palmPos,
      velocity: { ...vel },
      features: f,
    };
  }

  // ─── Two-hand combined ───────────────────────────────────────────────────

  _classifyCombined(leftHand, rightHand, leftResult, rightResult) {
    if (!leftHand || !rightHand) return null;
    const lf = leftHand.features;
    const rf = rightHand.features;

    // ZOOM: both hands pinching, moving apart or together
    if (lf.isPinching && rf.isPinching) {
      const lp = lf.palmPos;
      const rp = rf.palmPos;
      const interHandDist = Math.sqrt(
        (lp.x-rp.x)**2 + (lp.y-rp.y)**2 + (lp.z-rp.z)**2
      );

      // Rate of change tracked via velocity
      const relativeVelX = this._velR.x - this._velL.x;
      const spreading = relativeVelX; // positive = hands moving apart

      return {
        gesture: GestureType.ZOOM,
        confidence: 0.85,
        confirmed: true,
        interHandDist,
        spreading,
        frames: 1,
      };
    }

    return null;
  }

  // ─── Velocity tracking ───────────────────────────────────────────────────

  _updateVelocity(hand, side) {
    const vel   = side === 'L' ? this._velL : this._velR;
    const prev  = side === 'L' ? this._prevPosL : this._prevPosR;

    if (!hand) {
      // Decay velocity when hand disappears
      vel.x *= 0.7; vel.y *= 0.7; vel.z *= 0.7;
      return;
    }

    const pos = hand.features.palmPos;

    if (prev) {
      const rawVel = {
        x: pos.x - prev.x,
        y: pos.y - prev.y,
        z: pos.z - prev.z,
      };
      // EMA smoothing
      vel.x = lerp(vel.x, rawVel.x, this._velAlpha);
      vel.y = lerp(vel.y, rawVel.y, this._velAlpha);
      vel.z = lerp(vel.z, rawVel.z, this._velAlpha);
    }

    if (side === 'L') this._prevPosL = { ...pos };
    else              this._prevPosR = { ...pos };
  }

  reset() {
    this._historyL = [];
    this._historyR = [];
    this._prevPosL = null;
    this._prevPosR = null;
    this._velL = { x: 0, y: 0, z: 0 };
    this._velR = { x: 0, y: 0, z: 0 };
    this._currentL = { gesture: GestureType.IDLE, confidence: 0, frames: 0 };
    this._currentR = { gesture: GestureType.IDLE, confidence: 0, frames: 0 };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function magnitude(v) {
  return Math.sqrt(v.x**2 + v.y**2 + v.z**2);
}

function lerp(a, b, t) { return a + (b - a) * t; }
