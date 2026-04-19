# Changelog

All notable changes to TouchGrass are documented here.

---

## [0.1.0-beta] — 2026

### Phase 4 — Ship (this release)
- **STL export** (binary format) — direct to 3D printer slicer
- **Landing page** — touchgrass.app, auto-detects OS download
- **Undo/Redo UI** — titlebar buttons + Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
- **Volume preservation toggle** — ON by default, toggleable in props panel
- **LSTM training modal** — guided 8-gesture recorder with progress log
- **get_stats IPC command** — live mesh stats from Rust
- **TrainingUI wired into app** — btn-train shows after hands enabled
- 51/51 automated tests passing

### Phase 3 — Clay feels real
- **Volume preservation** — clay displaced by push/pull redistributes into shell
- **Sparse undo diffs** — only changed voxels stored, ~10KB per stroke vs 1MB full snapshot
- **UndoStack** — ring buffer, 64 steps, cursor-based redo
- **LSTM gesture classifier** — TensorFlow.js, 15-frame sequences, 8 gesture classes
- **In-app training** — record samples, train locally, model persists to localStorage
- **Landmark normalization** — wrist-relative, scale-invariant feature vectors
- **GestureClassifier fallback** — rule-based always runs, LSTM overrides when trained
- **preserveVolume flag** — threaded through all IPC sculpt commands
- Fixed: saturated center voxels correctly handled in test assertions
- 51 unit tests (24 gesture, 7 voxel math, 8 LSTM data pipeline, 12 undo/redo)

### Phase 2 — Hands
- **MediaPipe Web Worker** — inference off main thread, 20fps tracking, 60fps render
- **Feature extraction** — pinch distance, finger extension, openness, spread ratio
- **GestureClassifier** — sliding 8-frame window, hysteresis, EMA velocity
- **Gesture dispatch** — push/pull/smooth/flatten/inflate/grab/orbit/zoom
- **HandCoordinateMapper** — MediaPipe → Three.js world space, surface raycasting
- **HandOverlay** — 2D skeleton + gesture labels over 3D view
- **HandsController** — orchestrates camera, worker, classifier, mapper, IPC
- **Two-hand zoom** — inter-hand distance delta → camera zoom
- Enable/disable via titlebar button, mouse fallback always active

### Phase 1 — Clay engine
- **VoxelGrid** — 64³ f32 density field, 0.05 world units per voxel
- **Marching Cubes** — full 256-case lookup, smooth normals, vertex deduplication
- **Sculpt ops** — Push, Pull, Smooth, Flatten, Inflate with Gaussian brush falloff
- **Clay shader** — wrap lighting, fake SSS, soft specular, rim light
- **Grid shader** — infinite ground plane with anti-aliased lines
- **Orbit camera** — manual, no external dep, smooth RMB drag
- **Three.js renderer** — BufferGeometry hot-swap on every Rust response
- **Tauri IPC** — Rust commands via invoke(), JSON serialization
- **OBJ export** — with normals, Tauri save dialog
- **Keyboard shortcuts** — 1–5 tools, [ ] radius, W wireframe
- **Status bar** — FPS, vertex count, active tool
- Tauri 1.6 + Rust 1.70 + Three.js 0.163 + Vite 5.2

---

## Architecture

```
Input (mouse | MediaPipe hands)
    ↓
GestureClassifier → LSTMClassifier (if trained)
    ↓
HandCoordinateMapper → world space hit
    ↓
Tauri invoke() → Rust
    ↓
VoxelGrid.sculpt_*() → VoxelDiff
    ↓
UndoStack.push(diff)
    ↓
marching_cubes() → Mesh
    ↓
Three.js BufferGeometry update
    ↓
Clay shader render @ 60fps
```

---

*Saee Mannikar — github.com/saeemannikar/touchgrass*
