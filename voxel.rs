// TouchGrass - Voxel Engine Core
// Phase 3: Volume preservation + Undo/Redo stack

use std::collections::HashMap;

const ISO_LEVEL: f32 = 0.5;
const MAX_UNDO_STEPS: usize = 64;

const EDGE_TABLE: [u16; 256] = [
    0x000, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
    0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
    0x190, 0x099, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
    0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
    0x230, 0x339, 0x033, 0x13a, 0x636, 0x73f, 0x435, 0x53c,
    0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
    0x3a0, 0x2a9, 0x1a3, 0x0aa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
    0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
    0x460, 0x569, 0x663, 0x76a, 0x066, 0x16f, 0x265, 0x36c,
    0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
    0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0x0ff, 0x3f5, 0x2fc,
    0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
    0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x055, 0x15c,
    0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
    0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0x0cc,
    0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
    0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
    0x0cc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
    0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
    0x15c, 0x055, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
    0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
    0x2fc, 0x3f5, 0x0ff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
    0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
    0x36c, 0x265, 0x16f, 0x066, 0x76a, 0x663, 0x569, 0x460,
    0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
    0x4ac, 0x5a5, 0x6af, 0x7a6, 0x0aa, 0x1a3, 0x2a9, 0x3a0,
    0xd30, 0xc39, 0xf33, 0xe3a, 0x93e, 0x835, 0xb3f, 0xa36,
    0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x033, 0x339, 0x230,
    0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
    0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x099, 0x190,
    0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
    0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x000,
];

const TRI_TABLE: [[i8; 16]; 256] = include!("tri_table.rs");

// ─── Undo/Redo types ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct VoxelDiff {
    pub changes: Vec<(usize, f32, f32)>,
}

impl VoxelDiff {
    pub fn new() -> Self { Self { changes: Vec::new() } }
    pub fn is_empty(&self) -> bool { self.changes.is_empty() }
    pub fn byte_size(&self) -> usize { self.changes.len() * 16 }
}

pub struct UndoStack {
    diffs: Vec<VoxelDiff>,
    cursor: usize,
}

impl UndoStack {
    pub fn new() -> Self {
        Self { diffs: Vec::with_capacity(MAX_UNDO_STEPS), cursor: 0 }
    }

    pub fn push(&mut self, diff: VoxelDiff) {
        if diff.is_empty() { return; }
        let tip = self.diffs.len() - self.cursor;
        self.diffs.truncate(tip);
        self.cursor = 0;
        if self.diffs.len() >= MAX_UNDO_STEPS { self.diffs.remove(0); }
        self.diffs.push(diff);
    }

    pub fn can_undo(&self) -> bool { self.cursor < self.diffs.len() }
    pub fn can_redo(&self) -> bool { self.cursor > 0 }

    pub fn undo_diff(&mut self) -> Option<VoxelDiff> {
        if !self.can_undo() { return None; }
        self.cursor += 1;
        let idx = self.diffs.len() - self.cursor;
        Some(self.diffs[idx].clone())
    }

    pub fn redo_diff(&mut self) -> Option<VoxelDiff> {
        if !self.can_redo() { return None; }
        self.cursor -= 1;
        let idx = self.diffs.len() - self.cursor - 1;
        Some(self.diffs[idx].clone())
    }

    pub fn stack_size(&self) -> usize { self.diffs.len() }
    pub fn cursor(&self) -> usize { self.cursor }
}

// ─── VoxelGrid ────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct VoxelGrid {
    pub size_x: usize,
    pub size_y: usize,
    pub size_z: usize,
    pub data: Vec<f32>,
    pub scale: f32,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub vertices: Vec<f32>,
    pub normals:  Vec<f32>,
    pub indices:  Vec<u32>,
}

impl VoxelGrid {
    pub fn new(size: usize, scale: f32) -> Self {
        Self { size_x: size, size_y: size, size_z: size,
               data: vec![0.0; size * size * size], scale }
    }

    #[inline]
    pub fn idx(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.size_x * (y + self.size_y * z)
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize, z: usize) -> f32 {
        if x >= self.size_x || y >= self.size_y || z >= self.size_z { return 0.0; }
        self.data[self.idx(x, y, z)]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, z: usize, val: f32) {
        if x < self.size_x && y < self.size_y && z < self.size_z {
            let i = self.idx(x, y, z);
            self.data[i] = val.clamp(0.0, 1.0);
        }
    }

    pub fn total_mass(&self) -> f64 {
        self.data.iter().map(|&v| v as f64).sum()
    }

    pub fn init_sphere(&mut self, radius_ratio: f32) {
        let cx = self.size_x as f32 / 2.0;
        let cy = self.size_y as f32 / 2.0;
        let cz = self.size_z as f32 / 2.0;
        let r  = (self.size_x as f32 * radius_ratio).min(cx - 2.0);
        for z in 0..self.size_z {
            for y in 0..self.size_y {
                for x in 0..self.size_x {
                    let dx = x as f32 - cx;
                    let dy = y as f32 - cy;
                    let dz = z as f32 - cz;
                    let dist = (dx*dx + dy*dy + dz*dz).sqrt();
                    let val = smooth_step(0.0, 1.0, (1.0 - dist / r).clamp(0.0, 1.0));
                    let i = self.idx(x, y, z);
                    self.data[i] = val;
                }
            }
        }
    }

    // ─── Public sculpt API ────────────────────────────────────────────────────

    pub fn sculpt_push(&mut self, wx: f32, wy: f32, wz: f32, r: f32, s: f32, vol: bool) -> VoxelDiff {
        self.sculpt_op(wx, wy, wz, r, s, SculptMode::Push, vol)
    }
    pub fn sculpt_pull(&mut self, wx: f32, wy: f32, wz: f32, r: f32, s: f32, vol: bool) -> VoxelDiff {
        self.sculpt_op(wx, wy, wz, r, -s, SculptMode::Push, vol)
    }
    pub fn sculpt_smooth(&mut self, wx: f32, wy: f32, wz: f32, r: f32, s: f32) -> VoxelDiff {
        self.sculpt_op(wx, wy, wz, r, s, SculptMode::Smooth, false)
    }
    pub fn sculpt_flatten(&mut self, wx: f32, wy: f32, wz: f32, td: f32, r: f32, s: f32) -> VoxelDiff {
        self.sculpt_op_flatten(wx, wy, wz, td, r, s)
    }
    pub fn sculpt_inflate(&mut self, wx: f32, wy: f32, wz: f32, r: f32, s: f32, vol: bool) -> VoxelDiff {
        self.sculpt_op(wx, wy, wz, r, s, SculptMode::Inflate, vol)
    }

    pub fn apply_undo(&mut self, diff: &VoxelDiff) {
        for &(idx, before, _) in &diff.changes {
            if idx < self.data.len() { self.data[idx] = before; }
        }
    }
    pub fn apply_redo(&mut self, diff: &VoxelDiff) {
        for &(idx, _, after) in &diff.changes {
            if idx < self.data.len() { self.data[idx] = after; }
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    fn sculpt_op(&mut self, wx: f32, wy: f32, wz: f32, radius: f32, strength: f32,
                 mode: SculptMode, preserve_volume: bool) -> VoxelDiff {
        let inv = 1.0 / self.scale;
        let vx = wx * inv + self.size_x as f32 / 2.0;
        let vy = wy * inv + self.size_y as f32 / 2.0;
        let vz = wz * inv + self.size_z as f32 / 2.0;
        let vr = radius * inv;

        let x0 = ((vx-vr).floor() as isize).max(0) as usize;
        let x1 = ((vx+vr).ceil()  as isize+1).min(self.size_x as isize) as usize;
        let y0 = ((vy-vr).floor() as isize).max(0) as usize;
        let y1 = ((vy+vr).ceil()  as isize+1).min(self.size_y as isize) as usize;
        let z0 = ((vz-vr).floor() as isize).max(0) as usize;
        let z1 = ((vz+vr).ceil()  as isize+1).min(self.size_z as isize) as usize;

        let snapshot = if matches!(mode, SculptMode::Smooth) { Some(self.data.clone()) } else { None };

        // Snapshot before values
        let mut before: HashMap<usize, f32> = HashMap::new();
        for z in z0..z1 { for y in y0..y1 { for x in x0..x1 {
            let i = self.idx(x,y,z); before.insert(i, self.data[i]);
        }}}

        let mass_before: f64 = if preserve_volume {
            before.values().map(|&v| v as f64).sum()
        } else { 0.0 };

        // Apply op
        for z in z0..z1 { for y in y0..y1 { for x in x0..x1 {
            let dx = x as f32 - vx; let dy = y as f32 - vy; let dz = z as f32 - vz;
            let dist = (dx*dx+dy*dy+dz*dz).sqrt();
            if dist > vr { continue; }
            let falloff = gaussian_falloff(dist / vr);
            let delta   = strength * falloff;
            let i       = self.idx(x,y,z);
            match mode {
                SculptMode::Push => { self.data[i] = (self.data[i] + delta).clamp(0.0, 1.0); }
                SculptMode::Smooth => {
                    if let Some(ref snap) = snapshot {
                        let avg = self.neighbor_avg(snap, x, y, z);
                        self.data[i] = lerp(snap[i], avg, delta.abs().clamp(0.0,1.0));
                    }
                }
                SculptMode::Inflate => {
                    let g = self.gradient(x,y,z);
                    if (g.0*g.0+g.1*g.1+g.2*g.2).sqrt() > 0.001 {
                        self.data[i] = (self.data[i] + delta).clamp(0.0, 1.0);
                    }
                }
            }
        }}}

        // Volume preservation
        if preserve_volume && !matches!(mode, SculptMode::Smooth) {
            let mass_after: f64 = (z0..z1).flat_map(|z| (y0..y1).flat_map(move |y|
                (x0..x1).map(move |x| (x,y,z))
            )).map(|(x,y,z)| self.data[self.idx(x,y,z)] as f64).sum();

            let delta_mass = mass_after - mass_before;
            if delta_mass.abs() > 0.01 {
                self.redistribute_mass(-delta_mass as f32, vx, vy, vz, vr);
            }
        }

        // Build diff
        let mut diff = VoxelDiff::new();
        for (&idx, &bv) in &before {
            let av = self.data[idx];
            if (av - bv).abs() > 1e-6 { diff.changes.push((idx, bv, av)); }
        }
        diff
    }

    fn redistribute_mass(&mut self, mass: f32, vx: f32, vy: f32, vz: f32, vr: f32) {
        let outer = vr * 2.0;
        let x0 = ((vx-outer).floor() as isize).max(0) as usize;
        let x1 = ((vx+outer).ceil()  as isize+1).min(self.size_x as isize) as usize;
        let y0 = ((vy-outer).floor() as isize).max(0) as usize;
        let y1 = ((vy+outer).ceil()  as isize+1).min(self.size_y as isize) as usize;
        let z0 = ((vz-outer).floor() as isize).max(0) as usize;
        let z1 = ((vz+outer).ceil()  as isize+1).min(self.size_z as isize) as usize;

        let mut shell: Vec<(usize, f32)> = Vec::new();
        let mut wsum = 0.0f32;
        for z in z0..z1 { for y in y0..y1 { for x in x0..x1 {
            let dx = x as f32-vx; let dy = y as f32-vy; let dz = z as f32-vz;
            let d = (dx*dx+dy*dy+dz*dz).sqrt();
            if d <= vr || d > outer { continue; }
            let w = gaussian_falloff((d-vr)/(outer-vr));
            let i = self.idx(x,y,z);
            shell.push((i, w));
            wsum += w;
        }}}
        if wsum < 0.001 { return; }
        for (i, w) in shell {
            self.data[i] = (self.data[i] + mass * (w / wsum)).clamp(0.0, 1.0);
        }
    }

    fn sculpt_op_flatten(&mut self, wx: f32, wy: f32, wz: f32, td: f32, radius: f32, strength: f32) -> VoxelDiff {
        let inv = 1.0 / self.scale;
        let vx = wx*inv + self.size_x as f32/2.0;
        let vy = wy*inv + self.size_y as f32/2.0;
        let vz = wz*inv + self.size_z as f32/2.0;
        let vr = radius * inv;
        let x0 = ((vx-vr).floor() as isize).max(0) as usize;
        let x1 = ((vx+vr).ceil()  as isize+1).min(self.size_x as isize) as usize;
        let y0 = ((vy-vr).floor() as isize).max(0) as usize;
        let y1 = ((vy+vr).ceil()  as isize+1).min(self.size_y as isize) as usize;
        let z0 = ((vz-vr).floor() as isize).max(0) as usize;
        let z1 = ((vz+vr).ceil()  as isize+1).min(self.size_z as isize) as usize;
        let mut diff = VoxelDiff::new();
        for z in z0..z1 { for y in y0..y1 { for x in x0..x1 {
            let dx = x as f32-vx; let dy = y as f32-vy; let dz = z as f32-vz;
            let d = (dx*dx+dy*dy+dz*dz).sqrt();
            if d > vr { continue; }
            let i = self.idx(x,y,z);
            let bv = self.data[i];
            let av = lerp(bv, td, strength * gaussian_falloff(d/vr)).clamp(0.0,1.0);
            self.data[i] = av;
            if (av-bv).abs() > 1e-6 { diff.changes.push((i, bv, av)); }
        }}}
        diff
    }

    fn neighbor_avg(&self, snap: &[f32], x: usize, y: usize, z: usize) -> f32 {
        let (mut sum, mut n) = (0.0f32, 0u32);
        for dz in -1i32..=1 { for dy in -1i32..=1 { for dx in -1i32..=1 {
            let nx = x as i32+dx; let ny = y as i32+dy; let nz = z as i32+dz;
            if nx>=0 && ny>=0 && nz>=0 &&
               (nx as usize)<self.size_x && (ny as usize)<self.size_y && (nz as usize)<self.size_z {
                sum += snap[self.idx(nx as usize, ny as usize, nz as usize)]; n += 1;
            }
        }}}
        if n > 0 { sum / n as f32 } else { 0.0 }
    }

    fn gradient(&self, x: usize, y: usize, z: usize) -> (f32, f32, f32) {
        (self.get(x.saturating_add(1),y,z) - self.get(x.saturating_sub(1),y,z),
         self.get(x,y.saturating_add(1),z) - self.get(x,y.saturating_sub(1),z),
         self.get(x,y,z.saturating_add(1)) - self.get(x,y,z.saturating_sub(1)))
    }
}

enum SculptMode { Push, Smooth, Inflate }

// ─── Marching Cubes ───────────────────────────────────────────────────────────

pub fn marching_cubes(grid: &VoxelGrid) -> Mesh {
    let mut positions: Vec<[f32; 3]>           = Vec::new();
    let mut vertex_map: HashMap<(u32,u32,u32,u8), u32> = HashMap::new();
    let mut indices:   Vec<u32>                = Vec::new();
    let (sx,sy,sz) = (grid.size_x-1, grid.size_y-1, grid.size_z-1);
    let s = grid.scale;
    let (hx,hy,hz) = (grid.size_x as f32/2.0*s, grid.size_y as f32/2.0*s, grid.size_z as f32/2.0*s);

    const EDGES: [(usize,usize);12] = [(0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),(0,4),(1,5),(2,6),(3,7)];

    for z in 0..sz { for y in 0..sy { for x in 0..sx {
        let corners = [(x,y,z),(x+1,y,z),(x+1,y+1,z),(x,y+1,z),(x,y,z+1),(x+1,y,z+1),(x+1,y+1,z+1),(x,y+1,z+1)];
        let vals: [f32;8] = std::array::from_fn(|i| grid.get(corners[i].0,corners[i].1,corners[i].2));
        let mut ci: usize = 0;
        for i in 0..8 { if vals[i] >= ISO_LEVEL { ci |= 1<<i; } }
        if ci==0 || ci==255 { continue; }
        let ef = EDGE_TABLE[ci];
        if ef==0 { continue; }
        let mut ev = [[0.0f32;3];12];
        for e in 0..12 {
            if ef & (1<<e) != 0 {
                let (a,b) = EDGES[e];
                let (ax,ay,az) = corners[a]; let (bx,by,bz) = corners[b];
                let t = (ISO_LEVEL-vals[a])/(vals[b]-vals[a]+1e-9);
                ev[e] = [lerp(ax as f32,bx as f32,t)*s-hx, lerp(ay as f32,by as f32,t)*s-hy, lerp(az as f32,bz as f32,t)*s-hz];
            }
        }
        let tris = &TRI_TABLE[ci];
        let mut ti = 0;
        while ti < 16 && tris[ti] >= 0 {
            for k in 0..3 {
                let e = tris[ti+k] as usize;
                let vp = ev[e];
                let key = ((vp[0]*1000.0) as u32,(vp[1]*1000.0) as u32,(vp[2]*1000.0) as u32, e as u8);
                let idx = vertex_map.entry(key).or_insert_with(|| { let i=positions.len() as u32; positions.push(vp); i });
                indices.push(*idx);
            }
            ti += 3;
        }
    }}}

    let n = positions.len();
    let mut normals = vec![[0.0f32;3];n];
    for tri in indices.chunks(3) {
        let (a,b,c) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        let (pa,pb,pc) = (positions[a],positions[b],positions[c]);
        let ab = [pb[0]-pa[0],pb[1]-pa[1],pb[2]-pa[2]];
        let ac = [pc[0]-pa[0],pc[1]-pa[1],pc[2]-pa[2]];
        let nm = cross(ab,ac);
        for vi in [a,b,c] { normals[vi][0]+=nm[0]; normals[vi][1]+=nm[1]; normals[vi][2]+=nm[2]; }
    }
    for n in normals.iter_mut() {
        let m = (n[0]*n[0]+n[1]*n[1]+n[2]*n[2]).sqrt();
        if m > 1e-9 { n[0]/=m; n[1]/=m; n[2]/=m; }
    }

    Mesh {
        vertices: positions.iter().flat_map(|v| v.iter().copied()).collect(),
        normals:  normals.iter().flat_map(|v| v.iter().copied()).collect(),
        indices,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sphere_grid() -> VoxelGrid { let mut g = VoxelGrid::new(32, 0.05); g.init_sphere(0.3); g }

    #[test] fn sphere_center_is_dense() {
        let g = sphere_grid();
        assert!(g.get(16,16,16) > 0.9, "center={}", g.get(16,16,16));
    }
    #[test] fn sphere_corner_is_empty() {
        let g = sphere_grid();
        assert!(g.get(0,0,0) < 0.01, "corner={}", g.get(0,0,0));
    }
    #[test] fn oob_get_returns_zero() {
        let g = sphere_grid();
        assert_eq!(g.get(999,999,999), 0.0);
    }
    #[test] fn set_clamps_high() {
        let mut g = sphere_grid(); g.set(1,1,1,5.0); assert_eq!(g.get(1,1,1), 1.0);
    }
    #[test] fn set_clamps_low() {
        let mut g = sphere_grid(); g.set(1,1,1,-1.0); assert_eq!(g.get(1,1,1), 0.0);
    }
    #[test] fn push_adds_density() {
        let mut g = sphere_grid();
        let b = g.get(16,16,16);
        g.sculpt_push(0.0,0.0,0.0,0.4,0.5,false);
        assert!(g.get(16,16,16) >= b);
    }
    #[test] fn pull_removes_density() {
        let mut g = sphere_grid();
        let b = g.get(16,16,16);
        g.sculpt_pull(0.0,0.0,0.0,0.4,0.5,false);
        assert!(g.get(16,16,16) <= b);
    }
    #[test] fn smooth_reduces_spike() {
        let mut g = sphere_grid();
        g.set(16,16,16,1.0); g.set(15,16,16,0.0); g.set(17,16,16,0.0);
        let b = g.get(16,16,16);
        g.sculpt_smooth(0.0,0.0,0.0,0.4,0.5);
        assert!(g.get(16,16,16) < b);
    }
    #[test] fn flatten_approaches_target() {
        let mut g = sphere_grid();
        g.sculpt_flatten(0.0,0.0,0.0,0.5,0.4,1.0);
        assert!((g.get(16,16,16)-0.5).abs() < 0.05);
    }
    #[test] fn push_diff_not_empty() {
        let mut g = sphere_grid();
        let d = g.sculpt_push(0.0,0.0,0.0,0.4,0.5,false);
        assert!(!d.is_empty());
    }
    #[test] fn volume_preserved_on_push() {
        let mut g = sphere_grid();
        let mb = g.total_mass();
        g.sculpt_push(0.0,0.0,0.0,0.3,0.3,true);
        let ma = g.total_mass();
        let drift = ((ma-mb)/mb).abs();
        assert!(drift < 0.05, "drift={:.1}%", drift*100.0);
    }
    #[test] fn volume_preserved_on_pull() {
        let mut g = sphere_grid();
        let mb = g.total_mass();
        g.sculpt_pull(0.0,0.0,0.0,0.3,0.3,true);
        let ma = g.total_mass();
        let drift = ((ma-mb)/mb).abs();
        assert!(drift < 0.05, "drift={:.1}%", drift*100.0);
    }
    #[test] fn without_preservation_mass_changes() {
        let mut g = sphere_grid();
        let mb = g.total_mass();
        g.sculpt_push(0.0,0.0,0.0,0.3,0.5,false);
        assert!((g.total_mass()-mb).abs() > 0.1);
    }
    #[test] fn undo_restores_state() {
        let mut g = sphere_grid(); let mut u = UndoStack::new();
        let b = g.get(16,16,16);
        let d = g.sculpt_push(0.0,0.0,0.0,0.4,0.5,false);
        u.push(d); assert!(u.can_undo());
        let ud = u.undo_diff().unwrap(); g.apply_undo(&ud);
        assert!((g.get(16,16,16)-b).abs() < 1e-5);
    }
    #[test] fn redo_reapplies_state() {
        let mut g = sphere_grid(); let mut u = UndoStack::new();
        let d = g.sculpt_push(0.0,0.0,0.0,0.4,0.5,false);
        let ap = g.get(16,16,16);
        u.push(d);
        let ud = u.undo_diff().unwrap(); g.apply_undo(&ud);
        assert!(u.can_redo());
        let rd = u.redo_diff().unwrap(); g.apply_redo(&rd);
        assert!((g.get(16,16,16)-ap).abs() < 1e-5);
    }
    #[test] fn undo_stack_respects_max() {
        let mut g = sphere_grid(); let mut u = UndoStack::new();
        for _ in 0..(MAX_UNDO_STEPS+10) {
            let d = g.sculpt_push(0.0,0.0,0.0,0.1,0.02,false); u.push(d);
        }
        assert!(u.stack_size() <= MAX_UNDO_STEPS);
    }
    #[test] fn new_sculpt_clears_redo() {
        let mut g = sphere_grid(); let mut u = UndoStack::new();
        let d1 = g.sculpt_push(0.0,0.0,0.0,0.3,0.3,false); u.push(d1);
        let ud = u.undo_diff().unwrap(); g.apply_undo(&ud);
        assert!(u.can_redo());
        let d2 = g.sculpt_pull(0.0,0.0,0.0,0.3,0.2,false); u.push(d2);
        assert!(!u.can_redo());
    }
    #[test] fn empty_diff_not_pushed() {
        let mut u = UndoStack::new(); u.push(VoxelDiff::new());
        assert_eq!(u.stack_size(), 0);
    }
    #[test] fn marching_cubes_produces_geometry() {
        let g = sphere_grid(); let m = marching_cubes(&g);
        assert!(m.vertices.len() > 0); assert!(m.indices.len() > 0);
        assert_eq!(m.vertices.len(), m.normals.len());
        assert_eq!(m.indices.len() % 3, 0);
    }
    #[test] fn marching_cubes_normals_unit() {
        let g = sphere_grid(); let m = marching_cubes(&g);
        for n in m.normals.chunks(3) {
            let mag = (n[0]*n[0]+n[1]*n[1]+n[2]*n[2]).sqrt();
            assert!((mag-1.0).abs() < 0.01 || mag < 0.001, "mag={}", mag);
        }
    }
    #[test] fn marching_cubes_empty_grid() {
        let g = VoxelGrid::new(16, 0.05); let m = marching_cubes(&g);
        assert_eq!(m.vertices.len(), 0); assert_eq!(m.indices.len(), 0);
    }
}

// ─── Math ─────────────────────────────────────────────────────────────────────

#[inline] fn lerp(a: f32, b: f32, t: f32) -> f32 { a+(b-a)*t }
#[inline] fn smooth_step(e0: f32, e1: f32, x: f32) -> f32 { let t=((x-e0)/(e1-e0)).clamp(0.0,1.0); t*t*(3.0-2.0*t) }
#[inline] fn gaussian_falloff(t: f32) -> f32 { (-4.0*t*t).exp() }
#[inline] fn cross(a: [f32;3], b: [f32;3]) -> [f32;3] { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }
