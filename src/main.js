// TouchGrass - Main
// Connects UI <-> Renderer <-> Tauri IPC (Rust voxel engine)

import { invoke } from '@tauri-apps/api/tauri';
import { save } from '@tauri-apps/api/dialog';
import { writeTextFile } from '@tauri-apps/api/fs';
import { Renderer } from './renderer.js';
import { HandsController } from './lib/handsController.js';
import { TrainingUI } from './lib/trainingUI.js';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  tool: 'push',        // active sculpt tool
  radius: 0.28,        // brush radius in world units
  strength: 0.08,      // sculpt strength per frame
  busy: false,         // waiting for Rust response
  orbiting: false,     // right-mouse orbit
  sculpting: false,    // left-mouse sculpt
  vertCount: 0,
  triCount: 0,
  fps: 0,
  lastFrameTime: performance.now(),
  frameCount: 0,
};

// ─── DOM ──────────────────────────────────────────────────────────────────────

document.getElementById('app').innerHTML = `
  <div id="titlebar">
    <div class="logo">Touch<span>Grass</span></div>
    <div class="menu-items">
      <button class="menu-btn" id="btn-new">New</button>
      <button class="menu-btn" id="btn-undo" title="Ctrl+Z">↩ Undo</button>
      <button class="menu-btn" id="btn-redo" title="Ctrl+Y">↪ Redo</button>
      <button class="menu-btn" id="btn-export">Export OBJ</button>
      <button class="menu-btn" id="btn-export-stl">Export STL</button>
      <button class="menu-btn" id="btn-hands" style="color:var(--clay-light)">✋ Enable Hands</button>
      <button class="menu-btn" id="btn-train" style="display:none;color:var(--green)">🧠 Train Gestures</button>
    </div>
  </div>

  <div id="tools">
    <div class="panel-label">Sculpt</div>
    <button class="tool-btn active" data-tool="push">
      <span class="icon">◉</span> Push <span class="tool-shortcut">1</span>
    </button>
    <button class="tool-btn" data-tool="pull">
      <span class="icon">◎</span> Pull <span class="tool-shortcut">2</span>
    </button>
    <button class="tool-btn" data-tool="smooth">
      <span class="icon">≋</span> Smooth <span class="tool-shortcut">3</span>
    </button>
    <button class="tool-btn" data-tool="flatten">
      <span class="icon">▬</span> Flatten <span class="tool-shortcut">4</span>
    </button>
    <button class="tool-btn" data-tool="inflate">
      <span class="icon">⊕</span> Inflate <span class="tool-shortcut">5</span>
    </button>

    <div class="divider"></div>
    <div class="panel-label">Brush</div>

    <div class="slider-row">
      <label>Radius <span id="val-radius">${state.radius.toFixed(2)}</span></label>
      <input type="range" id="sl-radius" min="0.05" max="0.8" step="0.01" value="${state.radius}" />
    </div>
    <div class="slider-row">
      <label>Strength <span id="val-strength">${state.strength.toFixed(2)}</span></label>
      <input type="range" id="sl-strength" min="0.01" max="0.3" step="0.01" value="${state.strength}" />
    </div>

    <div class="divider"></div>
    <div class="panel-label">View</div>
    <button class="tool-btn" id="btn-wire">
      <span class="icon">⬡</span> Wireframe <span class="tool-shortcut">W</span>
    </button>
  </div>

  <div id="canvas-wrap">
    <div id="loading">
      <div class="tg-logo">TOUCHGRASS</div>
      <div class="tg-sub">Initialising clay engine...</div>
      <div class="spinner"></div>
    </div>
    <div id="brush-cursor"></div>
  </div>

  <div id="props">
    <div class="panel-label">Mesh</div>
    <div class="prop-section">
      <div class="prop-row"><span class="key">Verts</span><span class="val" id="pv-verts">—</span></div>
      <div class="prop-row"><span class="key">Tris</span><span class="val" id="pv-tris">—</span></div>
    </div>
    <div class="divider" style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="panel-label">Tool</div>
    <div class="prop-section">
      <div class="prop-row"><span class="key">Mode</span><span class="val" id="pv-tool">Push</span></div>
      <div class="prop-row"><span class="key">Radius</span><span class="val" id="pv-radius">${state.radius.toFixed(2)}</span></div>
      <div class="prop-row"><span class="key">Strength</span><span class="val" id="pv-strength">${state.strength.toFixed(2)}</span></div>
    </div>
    <div class="divider" style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="panel-label">Clay Color</div>
    <div class="prop-section" style="padding:4px 8px">
      <input type="color" id="clay-color" value="#b8714a"
        style="width:100%;height:28px;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer;" />
    </div>
    <div class="divider" style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="panel-label">Options</div>
    <div class="prop-section">
      <div class="prop-row" style="cursor:pointer" id="toggle-vol">
        <span class="key">Vol. Preserve</span>
        <span class="val" id="pv-vol" style="color:var(--green)">ON</span>
      </div>
    </div>
  </div>

  <div id="status">
    <div class="dot" id="dot"></div>
    <div class="stat">FPS <span class="val" id="st-fps">—</span></div>
    <div class="stat">Verts <span class="val" id="st-verts">—</span></div>
    <div class="stat">Tool <span class="val" id="st-tool">Push</span></div>
    <div class="stat">Hands <span class="val" id="st-hands">off</span></div>
    <div class="stat" style="margin-left:auto;color:var(--text-dim)">RMB orbit · Scroll zoom · LMB sculpt</div>
  </div>
`;

// ─── Init Renderer ────────────────────────────────────────────────────────────

const wrap = document.getElementById('canvas-wrap');
const renderer = new Renderer(wrap);
const brushCursor = document.getElementById('brush-cursor');

// ─── Hands Controller ─────────────────────────────────────────────────────────

let handsController = null;
let handsActive = false;

function initHandsController() {
  handsController = new HandsController({
    renderer,
    canvasWrap: wrap,
    onMeshUpdate: (mesh) => {
      renderer.updateMesh(mesh);
      updateStats(mesh);
    },
    onStatusUpdate: (msg) => {
      document.getElementById('st-hands').textContent = msg;
    },
  });
}

document.getElementById('btn-hands').addEventListener('click', async () => {
  if (!handsActive) {
    if (!handsController) initHandsController();
    const ok = await handsController.start();
    if (ok) {
      handsActive = true;
      document.getElementById('btn-hands').textContent = '✋ Hands On';
      document.getElementById('btn-hands').style.color = 'var(--green)';
      // Show train button now that hands are active
      document.getElementById('btn-train').style.display = 'inline-block';
      // Hide mouse brush cursor -- hands take over
      brushCursor.style.display = 'none';
    }
  } else {
    handsController.stop();
    handsActive = false;
    document.getElementById('btn-hands').textContent = '✋ Enable Hands';
    document.getElementById('btn-hands').style.color = 'var(--clay-light)';
  }
});

// ─── Boot -- call Rust to init clay ──────────────────────────────────────────

async function boot() {
  try {
    const mesh = await invoke('init_clay');
    renderer.updateMesh(mesh);
    updateStats(mesh);
    document.getElementById('loading').classList.add('hidden');
  } catch (e) {
    console.error('Failed to init clay:', e);
    // In dev without Tauri, generate a placeholder sphere
    document.getElementById('loading').classList.add('hidden');
    document.querySelector('#loading .tg-sub').textContent = 'Dev mode: Tauri not connected';
  }
}
boot();

// ─── Sculpt ───────────────────────────────────────────────────────────────────

let sculptThrottle = null;

async function sculpt(mx, my) {
  if (state.busy) return;
  const hit = renderer.raycastClay(mx, my);
  if (!hit.hit) return;

  state.busy = true;
  setBusy(true);

  try {
    let mesh;
    const { x, y, z } = hit;
    const r = state.radius;
    const s = state.strength;

    switch (state.tool) {
      case 'push':    mesh = await invoke('sculpt_push',    { x, y, z, radius: r, strength: s, preserveVolume }); break;
      case 'pull':    mesh = await invoke('sculpt_pull',    { x, y, z, radius: r, strength: s, preserveVolume }); break;
      case 'smooth':  mesh = await invoke('sculpt_smooth',  { x, y, z, radius: r, strength: s }); break;
      case 'flatten': mesh = await invoke('sculpt_flatten', { x, y, z, targetDensity: 0.5, radius: r, strength: s }); break;
      case 'inflate': mesh = await invoke('sculpt_inflate', { x, y, z, radius: r, strength: s, preserveVolume }); break;
    }
    if (mesh) updateUndoRedoButtons(mesh);

    if (mesh) {
      renderer.updateMesh(mesh);
      updateStats(mesh);
    }
  } catch (e) {
    console.error('Sculpt error:', e);
  }

  state.busy = false;
  setBusy(false);
}

// ─── Input ────────────────────────────────────────────────────────────────────

const canvas = wrap.querySelector('canvas');

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  e.preventDefault();
  if (e.button === 2) {
    state.orbiting = true;
    renderer.startOrbit(e.clientX, e.clientY);
  }
  if (e.button === 0) {
    state.sculpting = true;
    sculpt(e.clientX, e.clientY);
  }
});

canvas.addEventListener('mousemove', e => {
  // Update brush cursor
  brushCursor.style.display = 'block';
  brushCursor.style.left = e.clientX - wrap.getBoundingClientRect().left + 'px';
  brushCursor.style.top  = e.clientY - wrap.getBoundingClientRect().top  + 'px';
  // Size brush cursor to match world radius (approx)
  const px = state.radius * 180;
  brushCursor.style.width  = px + 'px';
  brushCursor.style.height = px + 'px';

  if (state.orbiting) {
    renderer.updateOrbit(e.clientX, e.clientY);
  }
  if (state.sculpting && !state.busy) {
    sculpt(e.clientX, e.clientY);
  }
});

canvas.addEventListener('mouseup', e => {
  if (e.button === 2) { state.orbiting = false; renderer.endOrbit(); }
  if (e.button === 0) { state.sculpting = false; }
});

canvas.addEventListener('mouseleave', () => {
  state.orbiting = false;
  state.sculpting = false;
  brushCursor.style.display = 'none';
  renderer.endOrbit();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  renderer.zoom(e.deltaY);
}, { passive: false });

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

const keyToolMap = { '1': 'push', '2': 'pull', '3': 'smooth', '4': 'flatten', '5': 'inflate' };
let wireframe = false;

window.addEventListener('keydown', e => {
  if (keyToolMap[e.key]) setTool(keyToolMap[e.key]);
  if (e.key === 'w' || e.key === 'W') {
    wireframe = !wireframe;
    renderer.setWireframe(wireframe);
    document.getElementById('btn-wire').classList.toggle('active', wireframe);
  }
  // Bracket keys for radius
  if (e.key === '[') { state.radius = Math.max(0.05, state.radius - 0.02); syncSliders(); }
  if (e.key === ']') { state.radius = Math.min(0.8,  state.radius + 0.02); syncSliders(); }
});

// ─── Tool buttons ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

function setTool(name) {
  state.tool = name;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === name)
  );
  document.getElementById('pv-tool').textContent = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById('st-tool').textContent = name.charAt(0).toUpperCase() + name.slice(1);
  handsController?.setBrushParams({ tool: name });
}

// ─── Sliders ──────────────────────────────────────────────────────────────────

document.getElementById('sl-radius').addEventListener('input', e => {
  state.radius = parseFloat(e.target.value);
  syncSliders();
  handsController?.setBrushParams({ radius: state.radius });
});
document.getElementById('sl-strength').addEventListener('input', e => {
  state.strength = parseFloat(e.target.value);
  syncSliders();
  handsController?.setBrushParams({ strength: state.strength });
});

function syncSliders() {
  document.getElementById('sl-radius').value = state.radius;
  document.getElementById('val-radius').textContent = state.radius.toFixed(2);
  document.getElementById('pv-radius').textContent = state.radius.toFixed(2);
  const px = state.radius * 180;
  brushCursor.style.width  = px + 'px';
  brushCursor.style.height = px + 'px';

  document.getElementById('sl-strength').value = state.strength;
  document.getElementById('val-strength').textContent = state.strength.toFixed(2);
  document.getElementById('pv-strength').textContent  = state.strength.toFixed(2);
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────────

async function doUndo() {
  try {
    const mesh = await invoke('undo');
    renderer.updateMesh(mesh);
    updateStats(mesh);
    updateUndoRedoButtons(mesh);
  } catch(e) { console.error('undo:', e); }
}

async function doRedo() {
  try {
    const mesh = await invoke('redo');
    renderer.updateMesh(mesh);
    updateStats(mesh);
    updateUndoRedoButtons(mesh);
  } catch(e) { console.error('redo:', e); }
}

function updateUndoRedoButtons(mesh) {
  document.getElementById('btn-undo').style.opacity = mesh.can_undo ? '1' : '0.35';
  document.getElementById('btn-redo').style.opacity = mesh.can_redo ? '1' : '0.35';
}

document.getElementById('btn-undo').addEventListener('click', doUndo);
document.getElementById('btn-redo').addEventListener('click', doRedo);

// Keyboard shortcuts
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
});

// ─── Volume preservation toggle ───────────────────────────────────────────────

let preserveVolume = true;

document.getElementById('toggle-vol').addEventListener('click', () => {
  preserveVolume = !preserveVolume;
  const el = document.getElementById('pv-vol');
  el.textContent = preserveVolume ? 'ON' : 'OFF';
  el.style.color = preserveVolume ? 'var(--green)' : 'var(--text-dim)';
  handsController?.setBrushParams({ preserveVolume });
});

// ─── Clay color ───────────────────────────────────────────────────────────────

document.getElementById('clay-color').addEventListener('input', e => {
  renderer.setClayColor(e.target.value);
});

// ─── New / Reset ─────────────────────────────────────────────────────────────

document.getElementById('btn-new').addEventListener('click', async () => {
  if (!confirm('Reset clay? Unsaved work will be lost.')) return;
  const mesh = await invoke('init_clay');
  renderer.updateMesh(mesh);
  updateStats(mesh);
});

// ─── Export OBJ ──────────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async () => {
  try {
    const obj = await invoke('export_obj');
    const path = await save({
      filters: [{ name: 'Wavefront OBJ', extensions: ['obj'] }],
      defaultPath: 'sculpture.obj',
    });
    if (path) {
      await writeTextFile(path, obj);
      console.log('Exported to', path);
    }
  } catch (e) {
    console.error('Export failed:', e);
  }
});

// ─── STL Export ──────────────────────────────────────────────────────────────

document.getElementById('btn-export-stl').addEventListener('click', async () => {
  try {
    const bytes = await invoke('export_stl');
    const path  = await save({
      filters: [{ name: 'STL File', extensions: ['stl'] }],
      defaultPath: 'sculpture.stl',
    });
    if (path) {
      const { writeBinaryFile } = await import('@tauri-apps/api/fs');
      await writeBinaryFile(path, new Uint8Array(bytes));
    }
  } catch (e) { console.error('STL export failed:', e); }
});

// ─── Train Gestures ───────────────────────────────────────────────────────────

document.getElementById('btn-train').addEventListener('click', () => {
  if (!handsController) return;
  const ui = new TrainingUI({
    lstm: handsController.lstm,
    handsController,
    onComplete: () => {
      document.getElementById('btn-train').textContent = '🧠 Retrain';
    },
  });
  ui.show();
});

// ─── Wireframe btn ────────────────────────────────────────────────────────────

document.getElementById('btn-wire').addEventListener('click', () => {
  wireframe = !wireframe;
  renderer.setWireframe(wireframe);
  document.getElementById('btn-wire').classList.toggle('active', wireframe);
});

// ─── Stats / FPS ──────────────────────────────────────────────────────────────

function updateStats(mesh) {
  state.vertCount = mesh.vertex_count;
  state.triCount  = mesh.triangle_count;
  document.getElementById('pv-verts').textContent = mesh.vertex_count.toLocaleString();
  document.getElementById('pv-tris').textContent  = mesh.triangle_count.toLocaleString();
  document.getElementById('st-verts').textContent = mesh.vertex_count.toLocaleString();
}

function setBusy(on) {
  document.getElementById('dot').classList.toggle('busy', on);
}

// FPS counter
setInterval(() => {
  const now = performance.now();
  const elapsed = (now - state.lastFrameTime) / 1000;
  // Estimate using renderer
  state.fps = Math.round(1 / (elapsed / Math.max(1, state.frameCount)));
  state.frameCount = 0;
  state.lastFrameTime = now;
  document.getElementById('st-fps').textContent = state.fps;
}, 1000);
