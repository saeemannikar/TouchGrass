#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod voxel;
use voxel::{VoxelGrid, VoxelDiff, UndoStack, marching_cubes};
use std::sync::Mutex;
use tauri::State;

const GRID_SIZE: usize = 64;
const GRID_SCALE: f32  = 0.05;

pub struct AppState {
    grid:  Mutex<VoxelGrid>,
    undo:  Mutex<UndoStack>,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct MeshData {
    vertices:       Vec<f32>,
    normals:        Vec<f32>,
    indices:        Vec<u32>,
    vertex_count:   usize,
    triangle_count: usize,
    can_undo:       bool,
    can_redo:       bool,
}

fn make_mesh(grid: &VoxelGrid, undo: &UndoStack) -> MeshData {
    let mesh = marching_cubes(grid);
    let vc   = mesh.vertices.len() / 3;
    let tc   = mesh.indices.len()  / 3;
    MeshData {
        vertices: mesh.vertices, normals: mesh.normals, indices: mesh.indices,
        vertex_count: vc, triangle_count: tc,
        can_undo: undo.can_undo(), can_redo: undo.can_redo(),
    }
}

fn commit(grid: &VoxelGrid, undo: &mut UndoStack, diff: VoxelDiff) -> MeshData {
    undo.push(diff);
    make_mesh(grid, undo)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn init_clay(state: State<AppState>) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    *grid = VoxelGrid::new(GRID_SIZE, GRID_SCALE);
    *undo = UndoStack::new();
    grid.init_sphere(0.3);
    make_mesh(&grid, &undo)
}

#[tauri::command]
fn sculpt_push(state: State<AppState>, x: f32, y: f32, z: f32, radius: f32, strength: f32, preserve_volume: bool) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    let diff = grid.sculpt_push(x, y, z, radius, strength, preserve_volume);
    commit(&grid, &mut undo, diff)
}

#[tauri::command]
fn sculpt_pull(state: State<AppState>, x: f32, y: f32, z: f32, radius: f32, strength: f32, preserve_volume: bool) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    let diff = grid.sculpt_pull(x, y, z, radius, strength, preserve_volume);
    commit(&grid, &mut undo, diff)
}

#[tauri::command]
fn sculpt_smooth(state: State<AppState>, x: f32, y: f32, z: f32, radius: f32, strength: f32) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    let diff = grid.sculpt_smooth(x, y, z, radius, strength);
    commit(&grid, &mut undo, diff)
}

#[tauri::command]
fn sculpt_flatten(state: State<AppState>, x: f32, y: f32, z: f32, target_density: f32, radius: f32, strength: f32) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    let diff = grid.sculpt_flatten(x, y, z, target_density, radius, strength);
    commit(&grid, &mut undo, diff)
}

#[tauri::command]
fn sculpt_inflate(state: State<AppState>, x: f32, y: f32, z: f32, radius: f32, strength: f32, preserve_volume: bool) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    let diff = grid.sculpt_inflate(x, y, z, radius, strength, preserve_volume);
    commit(&grid, &mut undo, diff)
}

#[tauri::command]
fn undo(state: State<AppState>) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    if let Some(diff) = undo.undo_diff() { grid.apply_undo(&diff); }
    make_mesh(&grid, &undo)
}

#[tauri::command]
fn redo(state: State<AppState>) -> MeshData {
    let mut grid = state.grid.lock().unwrap();
    let mut undo = state.undo.lock().unwrap();
    if let Some(diff) = undo.redo_diff() { grid.apply_redo(&diff); }
    make_mesh(&grid, &undo)
}

#[tauri::command]
fn export_obj(state: State<AppState>) -> String {
    let grid = state.grid.lock().unwrap();
    let mesh = marching_cubes(&grid);
    let mut obj = String::from("# TouchGrass Export\n# touchgrass.app\n\n");
    for v in mesh.vertices.chunks(3) { obj.push_str(&format!("v {} {} {}\n", v[0], v[1], v[2])); }
    for n in mesh.normals.chunks(3)  { obj.push_str(&format!("vn {} {} {}\n", n[0], n[1], n[2])); }
    for t in mesh.indices.chunks(3)  {
        obj.push_str(&format!("f {}//{} {}//{} {}//{}\n", t[0]+1,t[0]+1, t[1]+1,t[1]+1, t[2]+1,t[2]+1));
    }
    obj
}

// STL export (binary format -- smaller, faster, better 3D printer compat)
#[tauri::command]
fn export_stl(state: State<AppState>) -> Vec<u8> {
    let grid = state.grid.lock().unwrap();
    let mesh = marching_cubes(&grid);

    // Binary STL: 80-byte header + 4-byte tri count + (50 bytes * tri count)
    let tri_count = (mesh.indices.len() / 3) as u32;
    let mut buf: Vec<u8> = Vec::with_capacity(84 + tri_count as usize * 50);

    // Header: 80 bytes
    let header = b"TouchGrass STL Export - touchgrass.app                                         ";
    buf.extend_from_slice(&header[..80]);

    // Triangle count
    buf.extend_from_slice(&tri_count.to_le_bytes());

    // Triangles
    for tri in mesh.indices.chunks(3) {
        let (ai, bi, ci) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);

        let va = [mesh.vertices[ai*3], mesh.vertices[ai*3+1], mesh.vertices[ai*3+2]];
        let vb = [mesh.vertices[bi*3], mesh.vertices[bi*3+1], mesh.vertices[bi*3+2]];
        let vc = [mesh.vertices[ci*3], mesh.vertices[ci*3+1], mesh.vertices[ci*3+2]];

        // Face normal from vertices
        let ab = [vb[0]-va[0], vb[1]-va[1], vb[2]-va[2]];
        let ac = [vc[0]-va[0], vc[1]-va[1], vc[2]-va[2]];
        let nx = ab[1]*ac[2] - ab[2]*ac[1];
        let ny = ab[2]*ac[0] - ab[0]*ac[2];
        let nz = ab[0]*ac[1] - ab[1]*ac[0];
        let nm = (nx*nx+ny*ny+nz*nz).sqrt().max(1e-9);

        // Normal (12 bytes)
        buf.extend_from_slice(&(nx/nm).to_le_bytes());
        buf.extend_from_slice(&(ny/nm).to_le_bytes());
        buf.extend_from_slice(&(nz/nm).to_le_bytes());
        // Vertex A (12 bytes)
        for &f in &va { buf.extend_from_slice(&f.to_le_bytes()); }
        // Vertex B (12 bytes)
        for &f in &vb { buf.extend_from_slice(&f.to_le_bytes()); }
        // Vertex C (12 bytes)
        for &f in &vc { buf.extend_from_slice(&f.to_le_bytes()); }
        // Attribute byte count (2 bytes, always 0)
        buf.extend_from_slice(&0u16.to_le_bytes());
    }

    buf
}

// Mesh stats (for UI display)
#[tauri::command]
fn get_stats(state: State<AppState>) -> serde_json::Value {
    let grid = state.grid.lock().unwrap();
    let undo = state.undo.lock().unwrap();
    let mesh = marching_cubes(&grid);
    serde_json::json!({
        "vertex_count":   mesh.vertices.len() / 3,
        "triangle_count": mesh.indices.len()  / 3,
        "can_undo":       undo.can_undo(),
        "can_redo":       undo.can_redo(),
        "undo_stack_size": undo.stack_size(),
        "grid_size":      GRID_SIZE,
    })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .manage(AppState { grid: Mutex::new(VoxelGrid::new(GRID_SIZE, GRID_SCALE)), undo: Mutex::new(UndoStack::new()) })
        .invoke_handler(tauri::generate_handler![
            init_clay, sculpt_push, sculpt_pull, sculpt_smooth,
            sculpt_flatten, sculpt_inflate, undo, redo, export_obj, export_stl, get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TouchGrass");
}
