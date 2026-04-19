// TouchGrass - LSTM Gesture Classifier
// Replaces the rule-based classifier from Phase 2 for confirmed gestures.
// Architecture: input(21 landmarks * 3 coords = 63) -> LSTM(64) -> Dense(8 classes)
// Trained in-app from user recordings. Falls back to rule-based if untrained.
//
// Why LSTM: hand gestures are temporal sequences, not single-frame snapshots.
// The same hand position means different things depending on what it just did.
// LSTM captures that context across a sliding window of frames.

import { GestureType } from './gestureClassifier.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SEQUENCE_LENGTH = 15;   // frames per gesture sample (~750ms at 20fps)
const NUM_LANDMARKS   = 21;
const LANDMARK_DIMS   = 3;    // x, y, z per landmark
const INPUT_SIZE      = NUM_LANDMARKS * LANDMARK_DIMS; // 63
const NUM_CLASSES     = 8;
const HIDDEN_UNITS    = 64;
const LEARNING_RATE   = 0.001;
const BATCH_SIZE      = 32;
const EPOCHS_PER_TRAIN = 20;
const MIN_SAMPLES_TO_TRAIN = 5; // samples per class before training is useful

const CLASS_NAMES = [
  GestureType.SCULPT_PUSH,
  GestureType.SCULPT_PULL,
  GestureType.SCULPT_SMOOTH,
  GestureType.SCULPT_FLATTEN,
  GestureType.SCULPT_INFLATE,
  GestureType.GRAB_BLOB,
  GestureType.ORBIT,
  GestureType.IDLE,
];

// ─── LSTMGestureClassifier ────────────────────────────────────────────────────

export class LSTMGestureClassifier {
  constructor() {
    this._tf      = null;  // TensorFlow.js -- loaded lazily
    this._model   = null;
    this._trained = false;
    this._loading = false;

    // Training data store: { className: [sequences] }
    // Each sequence is an array of SEQUENCE_LENGTH frames,
    // each frame is Float32Array(63)
    this._trainingData = {};
    CLASS_NAMES.forEach(c => { this._trainingData[c] = []; });

    // Rolling frame buffer for live inference
    this._frameBuffer = [];

    // Confidence threshold -- below this, fall back to rule-based
    this._confidenceThreshold = 0.72;
  }

  // ─── Lazy TF load ──────────────────────────────────────────────────────────

  async _ensureTF() {
    if (this._tf) return true;
    try {
      // Dynamic import -- TF.js is large, only load when hands mode is on
      this._tf = await import('@tensorflow/tfjs');
      await this._tf.ready();
      console.log('[LSTM] TensorFlow.js loaded, backend:', this._tf.getBackend());
      return true;
    } catch (e) {
      console.error('[LSTM] Failed to load TensorFlow.js:', e);
      return false;
    }
  }

  // ─── Model definition ──────────────────────────────────────────────────────

  async _buildModel() {
    const tf = this._tf;

    const model = tf.sequential();

    // Input: [SEQUENCE_LENGTH, INPUT_SIZE]
    model.add(tf.layers.lstm({
      units: HIDDEN_UNITS,
      inputShape: [SEQUENCE_LENGTH, INPUT_SIZE],
      returnSequences: false,
      recurrentDropout: 0.1,
      dropout: 0.1,
      kernelInitializer: 'glorotUniform',
    }));

    model.add(tf.layers.dense({
      units: 32,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
    }));

    model.add(tf.layers.dropout({ rate: 0.3 }));

    model.add(tf.layers.dense({
      units: NUM_CLASSES,
      activation: 'softmax',
    }));

    model.compile({
      optimizer: tf.train.adam(LEARNING_RATE),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });

    return model;
  }

  // ─── Frame normalization ──────────────────────────────────────────────────

  /**
   * Normalize 21 landmarks relative to wrist (landmark 0).
   * This makes the representation translation-invariant.
   * Also normalize by hand scale (distance wrist -> middle MCP).
   */
  _normalizeLandmarks(landmarks) {
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];

    // Scale: wrist to middle MCP distance
    const scale = Math.sqrt(
      (middleMCP.x - wrist.x) ** 2 +
      (middleMCP.y - wrist.y) ** 2 +
      (middleMCP.z - wrist.z) ** 2
    ) || 1.0;

    const out = new Float32Array(INPUT_SIZE);
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      out[i * 3 + 0] = (landmarks[i].x - wrist.x) / scale;
      out[i * 3 + 1] = (landmarks[i].y - wrist.y) / scale;
      out[i * 3 + 2] = (landmarks[i].z - wrist.z) / scale;
    }
    return out;
  }

  // ─── Live inference ────────────────────────────────────────────────────────

  /**
   * Push a new frame into the buffer and run inference if buffer is full.
   * Returns null if model not trained or buffer not full yet.
   * Returns { gesture, confidence } if inference ran.
   */
  async infer(landmarks) {
    if (!this._trained || !this._model) return null;

    const frame = this._normalizeLandmarks(landmarks);
    this._frameBuffer.push(frame);
    if (this._frameBuffer.length > SEQUENCE_LENGTH) {
      this._frameBuffer.shift();
    }
    if (this._frameBuffer.length < SEQUENCE_LENGTH) return null;

    const tf = this._tf;

    // Build input tensor
    const inputData = new Float32Array(SEQUENCE_LENGTH * INPUT_SIZE);
    for (let t = 0; t < SEQUENCE_LENGTH; t++) {
      inputData.set(this._frameBuffer[t], t * INPUT_SIZE);
    }

    const inputTensor = tf.tensor3d(inputData, [1, SEQUENCE_LENGTH, INPUT_SIZE]);

    let result = null;
    try {
      const pred = this._model.predict(inputTensor);
      const probs = await pred.data();
      pred.dispose();

      let maxIdx = 0;
      let maxProb = 0;
      for (let i = 0; i < probs.length; i++) {
        if (probs[i] > maxProb) { maxProb = probs[i]; maxIdx = i; }
      }

      result = maxProb >= this._confidenceThreshold
        ? { gesture: CLASS_NAMES[maxIdx], confidence: maxProb }
        : null;
    } finally {
      inputTensor.dispose();
    }

    return result;
  }

  // ─── Training data recording ──────────────────────────────────────────────

  /**
   * Record a gesture sample. Call this during training mode.
   * Pass frames as they arrive; this builds sequences automatically.
   */
  recordFrame(landmarks, className) {
    if (!CLASS_NAMES.includes(className)) return;
    const frame = this._normalizeLandmarks(landmarks);

    if (!this._recordBuffer) this._recordBuffer = [];
    this._recordBuffer.push(frame);

    if (this._recordBuffer.length >= SEQUENCE_LENGTH) {
      const seq = [...this._recordBuffer];
      this._trainingData[className].push(seq);
      this._recordBuffer = [];
      return { recorded: true, total: this._trainingData[className].length };
    }
    return { recorded: false, total: this._trainingData[className].length };
  }

  cancelRecording() { this._recordBuffer = []; }

  getSampleCounts() {
    const counts = {};
    CLASS_NAMES.forEach(c => { counts[c] = this._trainingData[c].length; });
    return counts;
  }

  hasSufficientData() {
    return CLASS_NAMES.every(c => this._trainingData[c].length >= MIN_SAMPLES_TO_TRAIN);
  }

  // ─── Training ──────────────────────────────────────────────────────────────

  async train(onProgress) {
    if (!await this._ensureTF()) throw new Error('TF.js not available');

    const tf = this._tf;
    const counts = this.getSampleCounts();
    console.log('[LSTM] Training with samples:', counts);

    // Build flat arrays
    const xs = [];
    const ys = [];

    for (let ci = 0; ci < CLASS_NAMES.length; ci++) {
      const cls = CLASS_NAMES[ci];
      for (const seq of this._trainingData[cls]) {
        // Flatten sequence: [SEQUENCE_LENGTH, INPUT_SIZE]
        const flat = new Float32Array(SEQUENCE_LENGTH * INPUT_SIZE);
        for (let t = 0; t < SEQUENCE_LENGTH; t++) {
          flat.set(seq[t], t * INPUT_SIZE);
        }
        xs.push(flat);

        // One-hot label
        const label = new Float32Array(NUM_CLASSES);
        label[ci] = 1.0;
        ys.push(label);
      }
    }

    // Shuffle
    const indices = Array.from({ length: xs.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const xShuffled = indices.map(i => xs[i]);
    const yShuffled = indices.map(i => ys[i]);

    // Tensors
    const xData = new Float32Array(xs.length * SEQUENCE_LENGTH * INPUT_SIZE);
    const yData = new Float32Array(xs.length * NUM_CLASSES);
    xShuffled.forEach((seq, i) => xData.set(seq, i * SEQUENCE_LENGTH * INPUT_SIZE));
    yShuffled.forEach((lbl, i) => yData.set(lbl, i * NUM_CLASSES));

    const xTensor = tf.tensor3d(xData, [xs.length, SEQUENCE_LENGTH, INPUT_SIZE]);
    const yTensor = tf.tensor2d(yData, [xs.length, NUM_CLASSES]);

    // Build model
    if (this._model) { this._model.dispose(); }
    this._model = await this._buildModel();

    // Train
    await this._model.fit(xTensor, yTensor, {
      epochs: EPOCHS_PER_TRAIN,
      batchSize: BATCH_SIZE,
      validationSplit: 0.15,
      shuffle: true,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          onProgress?.({
            epoch: epoch + 1,
            totalEpochs: EPOCHS_PER_TRAIN,
            loss: logs.loss,
            acc: logs.acc,
            valAcc: logs.val_acc,
          });
        },
      },
    });

    xTensor.dispose();
    yTensor.dispose();

    this._trained = true;
    this._frameBuffer = [];
    console.log('[LSTM] Training complete.');
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async saveModel(savePath) {
    if (!this._model) throw new Error('No model to save');
    await this._model.save(`localstorage://touchgrass-gesture-model`);
    // Also export training data as JSON for re-training
    const td = {};
    for (const cls of CLASS_NAMES) {
      td[cls] = this._trainingData[cls].map(seq =>
        seq.map(frame => Array.from(frame))
      );
    }
    return JSON.stringify(td);
  }

  async loadModel() {
    if (!await this._ensureTF()) return false;
    const tf = this._tf;
    try {
      this._model = await tf.loadLayersModel('localstorage://touchgrass-gesture-model');
      this._model.compile({
        optimizer: tf.train.adam(LEARNING_RATE),
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy'],
      });
      this._trained = true;
      console.log('[LSTM] Model loaded from storage.');
      return true;
    } catch {
      console.log('[LSTM] No saved model found.');
      return false;
    }
  }

  loadTrainingData(json) {
    try {
      const td = JSON.parse(json);
      for (const cls of CLASS_NAMES) {
        if (td[cls]) {
          this._trainingData[cls] = td[cls].map(seq =>
            seq.map(frame => new Float32Array(frame))
          );
        }
      }
      return true;
    } catch { return false; }
  }

  clearTrainingData() {
    CLASS_NAMES.forEach(c => { this._trainingData[c] = []; });
    this._trained = false;
    this._model = null;
  }

  get isTrained() { return this._trained; }
}
