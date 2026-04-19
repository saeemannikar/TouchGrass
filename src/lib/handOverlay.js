// TouchGrass - Hand Overlay
// Draws hand skeleton + gesture labels on a 2D canvas overlaid on the 3D view
// Runs entirely in 2D -- no Three.js involvement

// MediaPipe hand connection pairs
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],         // thumb
  [0,5],[5,6],[6,7],[7,8],         // index
  [0,9],[9,10],[10,11],[11,12],    // middle
  [0,13],[13,14],[14,15],[15,16],  // ring
  [0,17],[17,18],[18,19],[19,20],  // pinky
  [5,9],[9,13],[13,17],            // palm
];

const GESTURE_LABELS = {
  sculpt_push:    { text: 'PUSH',    color: '#c97c3a' },
  sculpt_pull:    { text: 'PULL',    color: '#6db87a' },
  sculpt_smooth:  { text: 'SMOOTH',  color: '#7a9bc4' },
  sculpt_flatten: { text: 'FLATTEN', color: '#c4a87a' },
  sculpt_inflate: { text: 'INFLATE', color: '#c47a9b' },
  grab_blob:      { text: 'GRAB',    color: '#c4c47a' },
  orbit:          { text: 'ORBIT',   color: '#888' },
  zoom:           { text: 'ZOOM',    color: '#aaa' },
  idle:           { text: '',        color: 'transparent' },
};

export class HandOverlay {
  constructor(container) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
    `;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._resize(container);

    // ResizeObserver
    new ResizeObserver(() => this._resize(container)).observe(container);
  }

  _resize(container) {
    this.canvas.width  = container.clientWidth;
    this.canvas.height = container.clientHeight;
    this.w = this.canvas.width;
    this.h = this.canvas.height;
  }

  /**
   * Draw current frame's hand data.
   * @param {Array} hands - array of hand objects from gesture classifier result
   * @param {{ left, right, combined }} gestureResults
   */
  draw(hands, gestureResults) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    if (!hands || hands.length === 0) return;

    hands.forEach((hand, i) => {
      const result = hand.handedness === 'Left'
        ? gestureResults.left
        : gestureResults.right;

      this._drawSkeleton(ctx, hand.landmarks, result);
      this._drawGestureLabel(ctx, hand.landmarks, result, hand.handedness);
    });

    // Combined gesture
    if (gestureResults.combined) {
      this._drawCombinedLabel(ctx, gestureResults.combined);
    }
  }

  _drawSkeleton(ctx, landmarks, result) {
    if (!landmarks) return;

    // Map normalized [0,1] to canvas pixels
    // Note: MediaPipe x is mirrored -- flip it for display to match selfie view
    const px = lm => (1 - lm.x) * this.w;
    const py = lm => lm.y * this.h;

    const isActive = result?.confirmed && result?.gesture !== 'idle';
    const baseAlpha = isActive ? 1.0 : 0.45;

    // Connections
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(201, 124, 58, ${baseAlpha * 0.7})`;
    CONNECTIONS.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(px(landmarks[a]), py(landmarks[a]));
      ctx.lineTo(px(landmarks[b]), py(landmarks[b]));
      ctx.stroke();
    });

    // Joints
    landmarks.forEach((lm, i) => {
      const isTip = [4, 8, 12, 16, 20].includes(i);
      const r = isTip ? 5 : 3;
      ctx.beginPath();
      ctx.arc(px(lm), py(lm), r, 0, Math.PI * 2);
      ctx.fillStyle = isTip
        ? `rgba(212, 168, 130, ${baseAlpha})`
        : `rgba(122, 110, 102, ${baseAlpha})`;
      ctx.fill();

      // Highlight pinch tips
      if ((i === 4 || i === 8) && result?.features?.isPinching) {
        ctx.beginPath();
        ctx.arc(px(lm), py(lm), 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(109, 184, 122, ${baseAlpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });
  }

  _drawGestureLabel(ctx, landmarks, result, handedness) {
    if (!result || result.gesture === 'idle') return;

    const wrist = landmarks[0];
    const lx = (1 - wrist.x) * this.w;
    const ly = wrist.y * this.h + 28;

    const info = GESTURE_LABELS[result.gesture] || GESTURE_LABELS.idle;
    if (!info.text) return;

    // Confidence bar
    const barW = 60;
    const barH = 3;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(lx - barW/2, ly + 14, barW, barH);
    ctx.fillStyle = info.color;
    ctx.fillRect(lx - barW/2, ly + 14, barW * (result.confidence || 0), barH);

    // Label
    ctx.font = `500 11px 'DM Mono', monospace`;
    ctx.textAlign = 'center';

    const alpha = result.confirmed ? 1.0 : 0.5;
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.15})`;
    ctx.fillRect(lx - 34, ly - 12, 68, 18);

    ctx.fillStyle = info.color;
    ctx.globalAlpha = alpha;
    ctx.fillText(info.text, lx, ly);
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(122,110,102,0.7)';
    ctx.font = `10px 'DM Mono', monospace`;
    ctx.fillText(handedness, lx, ly - 16);
  }

  _drawCombinedLabel(ctx, combined) {
    const info = GESTURE_LABELS[combined.gesture] || GESTURE_LABELS.idle;
    if (!info.text) return;

    ctx.font = `500 12px 'DM Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = info.color;
    ctx.fillText(`TWO-HAND: ${info.text}`, this.w / 2, 24);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}
