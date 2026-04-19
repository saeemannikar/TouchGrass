// TouchGrass - Hands Controller
// Orchestrates:
//   1. Webcam capture
//   2. MediaPipe worker (inference)
//   3. Gesture classifier
//   4. Coordinate mapper (MediaPipe -> world space)
//   5. Tauri IPC (sculpt commands to Rust)
//   6. Hand overlay (debug visualization)

import { invoke } from '@tauri-apps/api/tauri';
import { GestureClassifier, GestureType } from './gestureClassifier.js';
import { LSTMGestureClassifier } from './lstmClassifier.js';
import { HandCoordinateMapper } from './handCoordinateMapper.js';
import { HandOverlay } from './handOverlay.js';

// How often to sample from video -> worker (ms)
// 20fps tracking is plenty; render stays at 60fps
const TRACKING_INTERVAL_MS = 50;

// Min frames a gesture must be confirmed before firing sculpt
const MIN_CONFIRMED_FRAMES = 3;

// Throttle sculpt IPC calls (ms) -- Rust is fast but we don't want to queue up
const SCULPT_THROTTLE_MS = 40;

export class HandsController {
  constructor({ renderer, canvasWrap, onMeshUpdate, onStatusUpdate }) {
    this.renderer      = renderer;
    this.canvasWrap    = canvasWrap;
    this.onMeshUpdate  = onMeshUpdate;   // callback: (meshData) => void
    this.onStatusUpdate = onStatusUpdate; // callback: (status: string) => void

    this._classifier = new GestureClassifier();
    this._lstm       = new LSTMGestureClassifier();
    this._mapper     = new HandCoordinateMapper(renderer.camera, renderer.renderer);
    this._overlay    = new HandOverlay(canvasWrap);

    this._worker     = null;
    this._video      = null;
    this._stream     = null;
    this._capturing  = false;
    this._captureTimer = null;

    // Sculpt state
    this._lastSculptTime = 0;
    this._sculpting = false;

    // Brush params (synced from UI)
    this.brushRadius    = 0.28;
    this.brushStrength  = 0.08;
    this.activeTool     = 'push';
    this.preserveVolume = true;

    // Zoom state
    this._prevInterHandDist = null;

    // Orbit state
    this._prevOrbitPos = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start() {
    this.onStatusUpdate('Requesting camera...');
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width:  { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      // Hidden video element for MediaPipe input
      this._video = document.createElement('video');
      this._video.srcObject = this._stream;
      this._video.playsInline = true;
      this._video.muted = true;
      await this._video.play();

      this.onStatusUpdate('Loading hand model...');
      await this._initWorker();

      this.onStatusUpdate('Hands ready');
      this._capturing = true;
      this._scheduleCapture();

      return true;
    } catch (err) {
      console.error('HandsController start failed:', err);
      this.onStatusUpdate('Camera error: ' + err.message);
      return false;
    }
  }

  stop() {
    this._capturing = false;
    clearTimeout(this._captureTimer);
    this._stream?.getTracks().forEach(t => t.stop());
    this._worker?.terminate();
    this._overlay.clear();
    this._classifier.reset();
    this._mapper.resetAll();
    this.onStatusUpdate('Hands off');
  }

  setBrushParams({ radius, strength, tool, preserveVolume }) {
    if (radius          !== undefined) this.brushRadius    = radius;
    if (strength        !== undefined) this.brushStrength  = strength;
    if (tool            !== undefined) this.activeTool     = tool;
    if (preserveVolume  !== undefined) this.preserveVolume = preserveVolume;
  }

  get lstm() { return this._lstm; }

  // ─── Worker ─────────────────────────────────────────────────────────────────

  async _initWorker() {
    return new Promise((resolve, reject) => {
      this._worker = new Worker(
        new URL('../workers/handTracker.worker.js', import.meta.url),
        { type: 'classic' }
      );

      this._worker.onmessage = (e) => {
        const { type } = e.data;
        if (type === 'ready') resolve();
        if (type === 'hands') this._onHandData(e.data.hands);
      };

      this._worker.onerror = (err) => {
        console.error('Worker error:', err);
        reject(err);
      };

      this._worker.postMessage({ type: 'init' });
    });
  }

  // ─── Capture loop ────────────────────────────────────────────────────────────

  _scheduleCapture() {
    if (!this._capturing) return;
    this._captureTimer = setTimeout(() => {
      this._captureFrame();
      this._scheduleCapture();
    }, TRACKING_INTERVAL_MS);
  }

  _captureFrame() {
    if (!this._video || this._video.readyState < 2) return;
    try {
      // createImageBitmap is zero-copy -- fast path to worker
      createImageBitmap(this._video).then(bitmap => {
        this._worker?.postMessage({ type: 'frame', bitmap }, [bitmap]);
      });
    } catch (e) {
      // Video not ready yet
    }
  }

  // ─── Hand data handler ───────────────────────────────────────────────────────

  async _onHandData(hands) {
    if (!hands) return;

    // Rule-based classifier always runs (fast, no async)
    const gestureResults = this._classifier.update(hands);

    // LSTM overrides rule-based for the dominant hand if trained + confident
    if (this._lstm.isTrained) {
      const dominant = hands.find(h => h.handedness === 'Right') || hands[0];
      if (dominant) {
        const lstmResult = await this._lstm.infer(dominant.landmarks);
        if (lstmResult) {
          // LSTM wins -- override rule-based result for that hand
          const key = dominant.handedness === 'Right' ? 'right' : 'left';
          gestureResults[key] = {
            ...gestureResults[key],
            gesture:   lstmResult.gesture,
            confidence: lstmResult.confidence,
            confirmed:  true,   // LSTM result is always confirmed
            source:    'lstm',
          };
        }
      }
    }

    // Store latest landmarks for training UI access
    const dominant = hands.find(h => h.handedness === "Right") || hands[0];
    this._lastLandmarks = dominant?.landmarks || null;

    // Draw overlay
    this._overlay.draw(hands, gestureResults);

    // Dispatch gestures to sculpt / camera
    this._dispatchGestures(hands, gestureResults);
  }

  // ─── Gesture dispatch ────────────────────────────────────────────────────────

  _dispatchGestures(hands, { left, right, combined }) {
    const now = Date.now();

    // ── Two-hand: ZOOM ────────────────────────────────────────────────────────
    if (combined?.gesture === GestureType.ZOOM) {
      const lHand = hands.find(h => h.handedness === 'Left');
      const rHand = hands.find(h => h.handedness === 'Right');
      if (lHand && rHand) {
        this._handleZoom(lHand, rHand);
      }
      return; // zoom takes priority
    }

    // ── Dominant hand: prefer right hand, fall back to left ───────────────────
    const dominant = right?.confirmed ? right : left?.confirmed ? left : null;
    const dominantHand = dominant === right
      ? hands.find(h => h.handedness === 'Right')
      : hands.find(h => h.handedness === 'Left');
    const dominantId = dominant === right ? 'R' : 'L';

    if (!dominant || !dominantHand) return;

    // Map hand position to world space
    const worldPos = this._mapper.palmToWorld(
      dominantHand.features.palmPos,
      dominantId,
      this.renderer.clayMesh
    );

    switch (dominant.gesture) {
      case GestureType.SCULPT_PUSH:
      case GestureType.SCULPT_PULL:
      case GestureType.SCULPT_SMOOTH:
      case GestureType.SCULPT_FLATTEN:
      case GestureType.SCULPT_INFLATE:
        if (now - this._lastSculptTime > SCULPT_THROTTLE_MS) {
          this._doSculpt(dominant.gesture, worldPos);
          this._lastSculptTime = now;
        }
        break;

      case GestureType.ORBIT:
        this._handleOrbit(dominantHand.features.palmPos, dominantId);
        break;

      case GestureType.GRAB_BLOB:
        // Phase 3: move the mesh object transform
        // For now: orbit as fallback
        this._handleOrbit(dominantHand.features.palmPos, dominantId);
        break;

      case GestureType.IDLE:
        this._prevOrbitPos = null;
        break;
    }
  }

  // ─── Sculpt IPC ──────────────────────────────────────────────────────────────

  async _doSculpt(gestureType, worldPos) {
    if (this._sculpting) return; // don't queue
    this._sculpting = true;

    const { x, y, z } = worldPos;
    const r = this.brushRadius;
    const s = this.brushStrength;

    try {
      let mesh = null;

      const pv = this.preserveVolume;
      switch (gestureType) {
        case GestureType.SCULPT_PUSH:
          mesh = await invoke('sculpt_push', { x, y, z, radius: r, strength: s, preserveVolume: pv });
          break;
        case GestureType.SCULPT_PULL:
          mesh = await invoke('sculpt_pull', { x, y, z, radius: r, strength: s, preserveVolume: pv });
          break;
        case GestureType.SCULPT_SMOOTH:
          mesh = await invoke('sculpt_smooth', { x, y, z, radius: r, strength: s });
          break;
        case GestureType.SCULPT_FLATTEN:
          mesh = await invoke('sculpt_flatten', { x, y, z, targetDensity: 0.5, radius: r, strength: s });
          break;
        case GestureType.SCULPT_INFLATE:
          mesh = await invoke('sculpt_inflate', { x, y, z, radius: r, strength: s, preserveVolume: pv });
          break;
      }

      if (mesh) this.onMeshUpdate(mesh);
    } catch (e) {
      console.error('Sculpt IPC error:', e);
    }

    this._sculpting = false;
  }

  // ─── Orbit ───────────────────────────────────────────────────────────────────

  _handleOrbit(palmPos, handId) {
    if (!this._prevOrbitPos) {
      this._prevOrbitPos = { ...palmPos };
      return;
    }

    const dx = palmPos.x - this._prevOrbitPos.x;
    const dy = palmPos.y - this._prevOrbitPos.y;

    // Scale to orbit delta
    const orbitX = dx * this.renderer.container.clientWidth  * 0.8;
    const orbitY = dy * this.renderer.container.clientHeight * 0.8;

    // Feed into renderer orbit
    const base = this.renderer.orbit;
    this.renderer.startOrbit(0, 0);
    this.renderer.updateOrbit(-orbitX, orbitY);
    this.renderer.endOrbit();

    this._prevOrbitPos = { ...palmPos };
  }

  // ─── Zoom ─────────────────────────────────────────────────────────────────────

  _handleZoom(lHand, rHand) {
    const { distance } = this._mapper.interHandDistance(
      lHand.features.palmPos,
      rHand.features.palmPos,
      this.renderer.clayMesh
    );

    if (this._prevInterHandDist !== null) {
      const delta = distance - this._prevInterHandDist;
      // Positive delta = hands spreading = zoom out
      this.renderer.zoom(delta * -2000);
    }

    this._prevInterHandDist = distance;
  }
}
