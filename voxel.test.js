// TouchGrass - Voxel Logic Tests (JS port)
// Validates the math of volume preservation, Gaussian falloff, undo diffs
// These catch logic bugs before cargo test runs.

import { describe, it, expect } from 'vitest';

// ─── JS port of Rust voxel math ───────────────────────────────────────────────

function gaussianFalloff(t) { return Math.exp(-4.0 * t * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothStep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3.0 - 2.0 * t);
}

class VoxelGrid {
  constructor(size, scale) {
    this.size = size;
    this.scale = scale;
    this.data = new Float32Array(size * size * size);
  }

  idx(x, y, z) { return x + this.size * (y + this.size * z); }

  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.size || y >= this.size || z >= this.size) return 0;
    return this.data[this.idx(x, y, z)];
  }

  set(x, y, z, val) {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.size && y < this.size && z < this.size) {
      this.data[this.idx(x, y, z)] = Math.max(0, Math.min(1, val));
    }
  }

  totalMass() {
    let m = 0;
    for (const v of this.data) m += v;
    return m;
  }

  initSphere(radiusRatio) {
    const c = this.size / 2;
    const r = Math.min(this.size * radiusRatio, c - 2);
    for (let z = 0; z < this.size; z++)
    for (let y = 0; y < this.size; y++)
    for (let x = 0; x < this.size; x++) {
      const dist = Math.sqrt((x-c)**2 + (y-c)**2 + (z-c)**2);
      const val = smoothStep(0, 1, Math.max(0, Math.min(1, 1.0 - dist/r)));
      this.data[this.idx(x, y, z)] = val;
    }
  }

  sculpt(wx, wy, wz, radius, strength, preserveVolume) {
    const inv = 1.0 / this.scale;
    const vx = wx * inv + this.size / 2;
    const vy = wy * inv + this.size / 2;
    const vz = wz * inv + this.size / 2;
    const vr = radius * inv;

    const x0 = Math.max(0, Math.floor(vx - vr));
    const x1 = Math.min(this.size, Math.ceil(vx + vr) + 1);
    const y0 = Math.max(0, Math.floor(vy - vr));
    const y1 = Math.min(this.size, Math.ceil(vy + vr) + 1);
    const z0 = Math.max(0, Math.floor(vz - vr));
    const z1 = Math.min(this.size, Math.ceil(vz + vr) + 1);

    // Record before
    const before = new Map();
    for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = this.idx(x, y, z);
      before.set(i, this.data[i]);
    }

    const massBefore = preserveVolume ? [...before.values()].reduce((a, v) => a + v, 0) : 0;

    // Apply push
    for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const dx = x - vx, dy = y - vy, dz = z - vz;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dist > vr) continue;
      const falloff = gaussianFalloff(dist / vr);
      const i = this.idx(x, y, z);
      this.data[i] = Math.max(0, Math.min(1, this.data[i] + strength * falloff));
    }

    // Volume preservation
    if (preserveVolume) {
      let massAfter = 0;
      for (let z = z0; z < z1; z++)
      for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        massAfter += this.data[this.idx(x, y, z)];

      const massDelta = massAfter - massBefore;
      if (Math.abs(massDelta) > 0.01) {
        this._redistribute(-massDelta, vx, vy, vz, vr);
      }
    }

    // Build diff
    const diff = [];
    for (const [i, bv] of before) {
      const av = this.data[i];
      if (Math.abs(av - bv) > 1e-6) diff.push({ i, bv, av });
    }
    return diff;
  }

  _redistribute(mass, vx, vy, vz, vr) {
    const outer = vr * 2.0;
    const x0 = Math.max(0, Math.floor(vx - outer));
    const x1 = Math.min(this.size, Math.ceil(vx + outer) + 1);
    const y0 = Math.max(0, Math.floor(vy - outer));
    const y1 = Math.min(this.size, Math.ceil(vy + outer) + 1);
    const z0 = Math.max(0, Math.floor(vz - outer));
    const z1 = Math.min(this.size, Math.ceil(vz + outer) + 1);

    const shell = [];
    let wsum = 0;
    for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const dx = x-vx, dy = y-vy, dz = z-vz;
      const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (d <= vr || d > outer) continue;
      const w = gaussianFalloff((d-vr)/(outer-vr));
      shell.push({ i: this.idx(x,y,z), w });
      wsum += w;
    }
    if (wsum < 0.001) return;
    for (const { i, w } of shell) {
      this.data[i] = Math.max(0, Math.min(1, this.data[i] + mass * (w / wsum)));
    }
  }

  applyUndo(diff) {
    for (const { i, bv } of diff) this.data[i] = bv;
  }

  applyRedo(diff) {
    for (const { i, av } of diff) this.data[i] = av;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Voxel math (JS port validates Rust logic)', () => {

  describe('Gaussian falloff', () => {
    it('is 1.0 at t=0 (center of brush)', () => {
      expect(gaussianFalloff(0)).toBeCloseTo(1.0, 5);
    });
    it('is near 0 at t=1 (edge of brush)', () => {
      expect(gaussianFalloff(1)).toBeLessThan(0.02);
    });
    it('is monotonically decreasing', () => {
      let prev = gaussianFalloff(0);
      for (let t = 0.1; t <= 1.0; t += 0.1) {
        const curr = gaussianFalloff(t);
        expect(curr).toBeLessThan(prev);
        prev = curr;
      }
    });
    it('is always positive', () => {
      for (let t = 0; t <= 2; t += 0.1) {
        expect(gaussianFalloff(t)).toBeGreaterThan(0);
      }
    });
  });

  describe('SmoothStep', () => {
    it('returns 0 at edge0', () => expect(smoothStep(0,1,0)).toBe(0));
    it('returns 1 at edge1', () => expect(smoothStep(0,1,1)).toBe(1));
    it('returns 0.5 at midpoint', () => expect(smoothStep(0,1,0.5)).toBeCloseTo(0.5, 5));
    it('clamps below 0', () => expect(smoothStep(0,1,-1)).toBe(0));
    it('clamps above 1', () => expect(smoothStep(0,1,2)).toBe(1));
  });

  describe('VoxelGrid initialization', () => {
    it('sphere center is dense', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      expect(g.get(16,16,16)).toBeGreaterThan(0.9);
    });
    it('sphere corner is empty', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      expect(g.get(0,0,0)).toBeLessThan(0.01);
    });
    it('OOB returns 0', () => {
      const g = new VoxelGrid(32, 0.05);
      expect(g.get(100,0,0)).toBe(0);
      expect(g.get(-1,0,0)).toBe(0);
    });
    it('set clamps to [0,1]', () => {
      const g = new VoxelGrid(32, 0.05);
      g.set(1,1,1,5.0); expect(g.get(1,1,1)).toBe(1.0);
      g.set(1,1,1,-1.0); expect(g.get(1,1,1)).toBe(0.0);
    });
    it('total mass is positive after sphere init', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      expect(g.totalMass()).toBeGreaterThan(100);
    });
  });

  describe('Sculpt operations', () => {
    it('push increases center density', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const b = g.get(16,16,16);
      g.sculpt(0,0,0, 0.4, 0.5, false);
      expect(g.get(16,16,16)).toBeGreaterThanOrEqual(b);
    });
    it('pull decreases center density', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const b = g.get(16,16,16);
      g.sculpt(0,0,0, 0.4, -0.5, false);
      expect(g.get(16,16,16)).toBeLessThanOrEqual(b);
    });
    it('push produces non-empty diff', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const diff = g.sculpt(0,0,0, 0.4, 0.5, false);
      expect(diff.length).toBeGreaterThan(0);
    });
    it('all density values stay in [0,1] after sculpt', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      g.sculpt(0,0,0, 0.5, 2.0, false); // extreme strength
      for (const v of g.data) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Volume preservation', () => {
    it('push with preservation keeps total mass within 5%', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const mb = g.totalMass();
      g.sculpt(0,0,0, 0.3, 0.3, true);
      const ma = g.totalMass();
      const drift = Math.abs(ma - mb) / mb;
      expect(drift).toBeLessThan(0.05);
    });
    it('pull with preservation keeps total mass within 5%', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const mb = g.totalMass();
      g.sculpt(0,0,0, 0.3, -0.3, true);
      const ma = g.totalMass();
      const drift = Math.abs(ma - mb) / mb;
      expect(drift).toBeLessThan(0.05);
    });
    it('without preservation mass changes significantly', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const mb = g.totalMass();
      g.sculpt(0,0,0, 0.3, 0.5, false);
      expect(Math.abs(g.totalMass() - mb)).toBeGreaterThan(0.1);
    });
    it('redistribution voxels stay clamped', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      for (let i = 0; i < 5; i++) g.sculpt(0,0,0, 0.4, 0.4, true);
      for (const v of g.data) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Undo/Redo', () => {
    it('undo restores original state exactly (pull from saturated center)', () => {
      // Center starts ~1.0; use pull which always has room to change
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const before = g.get(16,16,16);
      const diff = g.sculpt(0,0,0, 0.4, -0.5, false); // pull
      expect(g.get(16,16,16)).toBeLessThan(before);
      g.applyUndo(diff);
      expect(g.get(16,16,16)).toBeCloseTo(before, 4);
    });
    it('undo restores surface voxel after push', () => {
      // Use off-center position where density < 1.0, so push can move it
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const before = g.get(21, 16, 16);
      const diff = g.sculpt(0.25, 0, 0, 0.2, 0.5, false);
      g.applyUndo(diff);
      expect(g.get(21, 16, 16)).toBeCloseTo(before, 4);
    });
    it('redo reapplies sculpt', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const diff = g.sculpt(0,0,0, 0.4, -0.5, false); // pull
      const afterSculpt = g.get(16,16,16);
      g.applyUndo(diff);
      g.applyRedo(diff);
      expect(g.get(16,16,16)).toBeCloseTo(afterSculpt, 4);
    });
    it('multiple undo/redo cycles are stable', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const original = g.get(16,16,16);
      const diff = g.sculpt(0,0,0, 0.4, -0.4, false); // pull has room to change
      for (let i = 0; i < 5; i++) {
        g.applyUndo(diff);
        expect(g.get(16,16,16)).toBeCloseTo(original, 3);
        g.applyRedo(diff);
      }
    });
    it('diff only records changed voxels', () => {
      const g = new VoxelGrid(32, 0.05); g.initSphere(0.3);
      const diff = g.sculpt(0,0,0, 0.2, 0.3, false); // small brush
      const totalVoxels = 32 * 32 * 32;
      expect(diff.length).toBeLessThan(totalVoxels * 0.1); // <10% of grid
    });
  });
});
