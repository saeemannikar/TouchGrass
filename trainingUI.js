// TouchGrass - LSTM Training UI
// Walks user through recording gesture samples then trains the model in-app.
// Shows up when user clicks "🧠 Train Gestures"

import { GestureType } from './gestureClassifier.js';

const GESTURE_INSTRUCTIONS = {
  [GestureType.SCULPT_PUSH]: {
    label: 'Push',
    icon: '◉',
    instruction: 'Hold open palm facing the clay. Move hand slowly toward it.',
    color: '#c97c3a',
  },
  [GestureType.SCULPT_PULL]: {
    label: 'Pull',
    icon: '◎',
    instruction: 'Pinch thumb + index finger, then pull hand back toward you.',
    color: '#6db87a',
  },
  [GestureType.SCULPT_SMOOTH]: {
    label: 'Smooth',
    icon: '≋',
    instruction: 'Make a loose fist and move it side to side slowly.',
    color: '#7a9bc4',
  },
  [GestureType.SCULPT_FLATTEN]: {
    label: 'Flatten',
    icon: '▬',
    instruction: 'Hold hand flat, 4 fingers extended, thumb tucked. Hold still.',
    color: '#c4a87a',
  },
  [GestureType.SCULPT_INFLATE]: {
    label: 'Inflate',
    icon: '⊕',
    instruction: 'Spread all fingers wide, like cupping a ball.',
    color: '#c47a9b',
  },
  [GestureType.GRAB_BLOB]: {
    label: 'Grab',
    icon: '✊',
    instruction: 'Pinch near the clay and hold still (not moving).',
    color: '#c4c47a',
  },
  [GestureType.ORBIT]: {
    label: 'Orbit',
    icon: '⟳',
    instruction: 'Pinch in empty space and move your hand in a circle.',
    color: '#888',
  },
  [GestureType.IDLE]: {
    label: 'Idle',
    icon: '—',
    instruction: 'Rest your hand naturally at your side or out of frame.',
    color: '#555',
  },
};

const SAMPLES_REQUIRED = 8;
const GESTURE_ORDER = [
  GestureType.SCULPT_PUSH, GestureType.SCULPT_PULL, GestureType.SCULPT_SMOOTH,
  GestureType.SCULPT_FLATTEN, GestureType.SCULPT_INFLATE,
  GestureType.GRAB_BLOB, GestureType.ORBIT, GestureType.IDLE,
];

export class TrainingUI {
  constructor({ lstm, handsController, onComplete }) {
    this._lstm    = lstm;
    this._hands   = handsController;
    this._onComplete = onComplete;

    this._modal   = null;
    this._step    = 0;       // which gesture we're on
    this._recording = false;
    this._recordInterval = null;
  }

  // ─── Show modal ────────────────────────────────────────────────────────────

  show() {
    if (this._modal) return;

    this._modal = document.createElement('div');
    this._modal.id = 'training-modal';
    this._modal.style.cssText = `
      position: fixed; inset: 0; z-index: 100;
      background: rgba(10,8,6,0.88);
      display: flex; align-items: center; justify-content: center;
      font-family: 'DM Sans', sans-serif;
      backdrop-filter: blur(4px);
    `;

    this._modal.innerHTML = `
      <div style="
        background: var(--bg2,#211e1b);
        border: 1px solid var(--border,#3a342d);
        border-radius: 10px;
        width: 520px; max-width: 95vw;
        padding: 28px;
        display: flex; flex-direction: column; gap: 20px;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font:600 15px 'DM Mono',monospace;color:var(--clay-light,#d9a882);letter-spacing:.08em">
            🧠 GESTURE TRAINING
          </div>
          <button id="tm-close" style="background:none;border:none;color:var(--text-dim,#7a6e66);font-size:18px;cursor:pointer">✕</button>
        </div>

        <!-- Progress bar -->
        <div style="display:flex;gap:6px" id="tm-progress-dots"></div>

        <!-- Gesture info -->
        <div style="display:flex;align-items:center;gap:14px">
          <div id="tm-icon" style="font-size:32px;width:48px;text-align:center"></div>
          <div>
            <div id="tm-gesture-label" style="font:600 17px var(--font);color:var(--text,#d4c8bc)"></div>
            <div id="tm-instruction" style="font:13px var(--font);color:var(--text-dim,#7a6e66);margin-top:4px;line-height:1.5"></div>
          </div>
        </div>

        <!-- Sample counter -->
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font:11px 'DM Mono',monospace;color:var(--text-dim,#7a6e66)">SAMPLES</span>
            <span id="tm-count" style="font:11px 'DM Mono',monospace;color:var(--clay-light,#d9a882)">0 / ${SAMPLES_REQUIRED}</span>
          </div>
          <div style="height:4px;background:var(--border,#3a342d);border-radius:2px;overflow:hidden">
            <div id="tm-bar" style="height:100%;width:0%;background:var(--accent,#c97c3a);border-radius:2px;transition:width .2s"></div>
          </div>
        </div>

        <!-- Record button -->
        <div style="display:flex;gap:10px">
          <button id="tm-record" style="
            flex:1; padding:10px; border-radius:6px;
            background:var(--accent,#c97c3a); border:none;
            color:white; font:500 13px var(--font);
            cursor:pointer; transition:background .15s;
          ">Hold to Record</button>
          <button id="tm-skip" style="
            padding:10px 16px; border-radius:6px;
            background:none; border:1px solid var(--border,#3a342d);
            color:var(--text-dim,#7a6e66); font:13px var(--font);
            cursor:pointer;
          ">Skip</button>
        </div>

        <!-- Status message -->
        <div id="tm-status" style="font:11px 'DM Mono',monospace;color:var(--text-dim,#7a6e66);text-align:center;min-height:16px"></div>

        <!-- Training progress (hidden until training) -->
        <div id="tm-train-section" style="display:none">
          <div id="tm-train-log" style="
            font:11px 'DM Mono',monospace;color:var(--text-dim);
            background:var(--bg,#1a1714);border:1px solid var(--border);
            border-radius:6px;padding:12px;max-height:120px;overflow-y:auto;
          "></div>
        </div>
      </div>
    `;

    document.body.appendChild(this._modal);
    this._bindEvents();
    this._renderStep();
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  _bindEvents() {
    document.getElementById('tm-close').addEventListener('click', () => this.hide());

    const recordBtn = document.getElementById('tm-record');

    recordBtn.addEventListener('mousedown', () => this._startRecording());
    recordBtn.addEventListener('mouseup',   () => this._stopRecording());
    recordBtn.addEventListener('mouseleave',() => this._stopRecording());
    recordBtn.addEventListener('touchstart', e => { e.preventDefault(); this._startRecording(); });
    recordBtn.addEventListener('touchend',   e => { e.preventDefault(); this._stopRecording(); });

    document.getElementById('tm-skip').addEventListener('click', () => this._nextGesture());
  }

  _startRecording() {
    if (this._recording) return;
    this._recording = true;
    document.getElementById('tm-record').style.background = '#9b5e2a';
    document.getElementById('tm-status').textContent = '● Recording...';

    const cls = GESTURE_ORDER[this._step];
    this._recordInterval = setInterval(() => {
      // Get current hand landmarks from hands controller
      const landmarks = this._hands?._lastLandmarks;
      if (!landmarks) return;
      const result = this._lstm.recordFrame(landmarks, cls);
      if (result?.recorded) {
        this._updateSampleCount(result.total);
        if (result.total >= SAMPLES_REQUIRED) {
          this._stopRecording();
          setTimeout(() => this._nextGesture(), 400);
        }
      }
    }, 55); // ~18fps polling
  }

  _stopRecording() {
    if (!this._recording) return;
    this._recording = false;
    clearInterval(this._recordInterval);
    document.getElementById('tm-record').style.background = 'var(--accent,#c97c3a)';
    document.getElementById('tm-status').textContent = '';
    this._lstm.cancelRecording();
  }

  // ─── Step rendering ────────────────────────────────────────────────────────

  _renderStep() {
    const cls  = GESTURE_ORDER[this._step];
    const info = GESTURE_INSTRUCTIONS[cls];

    document.getElementById('tm-icon').textContent = info.icon;
    document.getElementById('tm-icon').style.color = info.color;
    document.getElementById('tm-gesture-label').textContent = info.label;
    document.getElementById('tm-instruction').textContent = info.instruction;

    const count = this._lstm.getSampleCounts()[cls] || 0;
    this._updateSampleCount(count);

    // Progress dots
    const dots = document.getElementById('tm-progress-dots');
    dots.innerHTML = GESTURE_ORDER.map((_, i) => `
      <div style="
        flex:1; height:3px; border-radius:2px;
        background:${i < this._step ? 'var(--green,#6db87a)' : i === this._step ? 'var(--accent,#c97c3a)' : 'var(--border,#3a342d)'};
      "></div>
    `).join('');

    // If this is the train step
    if (this._step >= GESTURE_ORDER.length) {
      this._showTrainStep();
    }
  }

  _updateSampleCount(n) {
    document.getElementById('tm-count').textContent = `${n} / ${SAMPLES_REQUIRED}`;
    document.getElementById('tm-bar').style.width = `${Math.min(100, (n / SAMPLES_REQUIRED) * 100)}%`;
  }

  _nextGesture() {
    this._stopRecording();
    this._step++;
    if (this._step >= GESTURE_ORDER.length) {
      this._showTrainStep();
    } else {
      this._renderStep();
    }
  }

  // ─── Training step ────────────────────────────────────────────────────────

  _showTrainStep() {
    const counts = this._lstm.getSampleCounts();
    const totalSamples = Object.values(counts).reduce((a, v) => a + v, 0);

    document.getElementById('tm-gesture-label').textContent = 'Ready to Train';
    document.getElementById('tm-instruction').textContent =
      `Recorded ${totalSamples} total samples. Training will take ~30 seconds.`;
    document.getElementById('tm-icon').textContent = '🧠';
    document.getElementById('tm-icon').style.color = 'var(--green)';

    document.getElementById('tm-train-section').style.display = 'block';
    document.getElementById('tm-bar').style.width = '100%';
    document.getElementById('tm-bar').style.background = 'var(--green)';
    document.getElementById('tm-count').textContent = `${totalSamples} samples`;

    const recordBtn = document.getElementById('tm-record');
    recordBtn.textContent = 'Train Model';
    recordBtn.style.background = 'var(--green,#6db87a)';
    recordBtn.onclick = () => this._train();

    document.getElementById('tm-skip').textContent = 'Cancel';
  }

  async _train() {
    document.getElementById('tm-record').disabled = true;
    document.getElementById('tm-record').textContent = 'Training...';
    document.getElementById('tm-train-section').style.display = 'block';

    const log = document.getElementById('tm-train-log');
    log.textContent = 'Initializing TensorFlow.js...\n';

    try {
      await this._lstm.train(({ epoch, totalEpochs, loss, acc, valAcc }) => {
        const line = `Epoch ${epoch}/${totalEpochs}  loss=${loss.toFixed(4)}  acc=${(acc*100).toFixed(1)}%` +
          (valAcc ? `  val=${(valAcc*100).toFixed(1)}%` : '') + '\n';
        log.textContent += line;
        log.scrollTop = log.scrollHeight;
        document.getElementById('tm-status').textContent = `Training epoch ${epoch}/${totalEpochs}`;
      });

      log.textContent += '\n✓ Training complete! Model active.\n';
      document.getElementById('tm-status').textContent = '✓ Gestures trained successfully';
      document.getElementById('tm-record').textContent = 'Done';
      document.getElementById('tm-record').style.background = 'var(--green)';
      document.getElementById('tm-record').onclick = () => { this.hide(); this._onComplete?.(); };

    } catch (e) {
      log.textContent += `\n✗ Training failed: ${e.message}\n`;
      document.getElementById('tm-status').textContent = '✗ Training failed';
      document.getElementById('tm-record').disabled = false;
      document.getElementById('tm-record').textContent = 'Retry';
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  hide() {
    this._stopRecording();
    this._modal?.remove();
    this._modal = null;
  }
}
