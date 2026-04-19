// TouchGrass - Hand Coordinate Mapper
// Converts MediaPipe normalized image coords to Three.js world space
// MediaPipe gives: x,y in [0,1] image space, z as relative depth
// We need: x,y,z in world space to pass to Rust sculpt ops

import * as THREE from 'three';

export class HandCoordinateMapper {
  constructor(camera, renderer) {
    this.camera   = camera;
    this.renderer = renderer;

    // Depth estimation config
    // MediaPipe z is relative -- we scale it to a reasonable world depth
    this._depthScale = 1.2;
    this._depthOffset = 0.0;

    // Working plane for raycasting when not hitting mesh
    this._workPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    // Smoothing -- hand positions jitter, smooth before sending to Rust
    this._smoothedPos = {};
    this._smoothAlpha = 0.45; // higher = more responsive, lower = smoother
  }

  /**
   * Convert a MediaPipe palm position to Three.js world space.
   * Uses raycasting against the clay mesh for accurate surface contact.
   *
   * @param {Object}   palmPos    - { x, y, z } normalized MediaPipe coords
   * @param {string}   handId     - 'L' | 'R' for per-hand smoothing state
   * @param {Object}   clayMesh   - Three.js mesh to raycast against
   * @returns {{ x, y, z, onSurface: bool, surfaceNormal: THREE.Vector3|null }}
   */
  palmToWorld(palmPos, handId, clayMesh) {
    // Convert MediaPipe image coords to NDC
    // MediaPipe x is mirrored (0=right of image), so we flip x
    const ndcX =  (1.0 - palmPos.x) * 2 - 1;
    const ndcY = -(palmPos.y * 2 - 1);

    // Raycast from camera through NDC point
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);

    // Try to hit the clay mesh first
    if (clayMesh) {
      const hits = raycaster.intersectObject(clayMesh, false);
      if (hits.length > 0) {
        const raw = hits[0].point;
        const normal = hits[0].face?.normal?.clone()
          .transformDirection(clayMesh.matrixWorld) || null;

        const smoothed = this._smooth(handId, raw);
        return {
          x: smoothed.x,
          y: smoothed.y,
          z: smoothed.z,
          onSurface: true,
          surfaceNormal: normal,
        };
      }
    }

    // No mesh hit -- project to a working plane at estimated depth
    // Depth: MediaPipe z is relative hand depth (negative = closer to camera)
    // We map it to a world-space z plane
    const estimatedDepth = this._depthOffset + palmPos.z * this._depthScale;
    this._workPlane.constant = -estimatedDepth;

    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(this._workPlane, target);

    if (target) {
      const smoothed = this._smooth(handId, target);
      return {
        x: smoothed.x,
        y: smoothed.y,
        z: smoothed.z,
        onSurface: false,
        surfaceNormal: null,
      };
    }

    return { x: 0, y: 0, z: 0, onSurface: false, surfaceNormal: null };
  }

  /**
   * Convert two palm positions to inter-hand distance in world space.
   * Used for zoom gesture.
   */
  interHandDistance(palmsL, palmsR, clayMesh) {
    const wL = this.palmToWorld(palmsL, 'L', clayMesh);
    const wR = this.palmToWorld(palmsR, 'R', clayMesh);
    return {
      distance: Math.sqrt((wL.x-wR.x)**2 + (wL.y-wR.y)**2 + (wL.z-wR.z)**2),
      centerX: (wL.x+wR.x)/2,
      centerY: (wL.y+wR.y)/2,
      centerZ: (wL.z+wR.z)/2,
    };
  }

  // ─── Smoothing ─────────────────────────────────────────────────────────────

  _smooth(handId, pos) {
    if (!this._smoothedPos[handId]) {
      this._smoothedPos[handId] = pos.clone ? pos.clone() : { ...pos };
      return this._smoothedPos[handId];
    }

    const prev = this._smoothedPos[handId];
    const a = this._smoothAlpha;

    const smoothed = {
      x: prev.x + (pos.x - prev.x) * a,
      y: prev.y + (pos.y - prev.y) * a,
      z: prev.z + (pos.z - prev.z) * a,
    };

    this._smoothedPos[handId] = smoothed;
    return smoothed;
  }

  reset(handId) {
    delete this._smoothedPos[handId];
  }

  resetAll() {
    this._smoothedPos = {};
  }
}
