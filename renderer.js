// TouchGrass - Three.js Renderer
import * as THREE from 'three';
import { clayVertexShader, clayFragmentShader, gridVertexShader, gridFragmentShader } from './shaders.js';

export class Renderer {
  constructor(container) {
    this.container = container;
    this.width  = container.clientWidth;
    this.height = container.clientHeight;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initLights();
    this._initClay();
    this._initGrid();
    this._initOrbit();
    this._bindResize();
    this._loop();
  }

  // ─── Init ───────────────────────────────────────────────────────────────────

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.width, this.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1714);
    this.scene.fog = new THREE.Fog(0x1a1714, 8, 18);
  }

  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(50, this.width / this.height, 0.01, 50);
    this.camera.position.set(1.8, 1.4, 2.4);
    this.camera.lookAt(0, 0, 0);
  }

  _initLights() {
    // Ambient
    this.scene.add(new THREE.AmbientLight(0x2a221c, 1.2));

    // Key light -- warm, from upper-left-front
    const key = new THREE.DirectionalLight(0xffddb0, 2.5);
    key.position.set(-2, 3.5, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    this.scene.add(key);

    // Fill light -- cool blue from below-right
    const fill = new THREE.DirectionalLight(0x8090b0, 0.8);
    fill.position.set(3, -1, -2);
    this.scene.add(fill);

    // Back rim -- very subtle orange glow from behind
    const rim = new THREE.DirectionalLight(0xc07030, 0.4);
    rim.position.set(0, 1, -4);
    this.scene.add(rim);

    this._keyLightDir = key.position.clone().normalize();
    this._fillLightDir = fill.position.clone().normalize();
  }

  _initClay() {
    // Empty geometry, will be updated when Rust sends mesh data
    this.clayGeo = new THREE.BufferGeometry();
    this.clayMat = new THREE.ShaderMaterial({
      vertexShader: clayVertexShader,
      fragmentShader: clayFragmentShader,
      uniforms: {
        uLightDir:    { value: this._keyLightDir },
        uLightDir2:   { value: this._fillLightDir },
        uClayColor:   { value: new THREE.Color(0xb8714a) },
        uShadowColor: { value: new THREE.Color(0x3a1f0e) },
        uRoughness:   { value: 0.85 },
        uSSS:         { value: 0.22 },
      },
      side: THREE.FrontSide,
    });
    this.clayMesh = new THREE.Mesh(this.clayGeo, this.clayMat);
    this.clayMesh.castShadow = true;
    this.clayMesh.receiveShadow = false;
    this.scene.add(this.clayMesh);

    // Wireframe overlay -- shown in wireframe mode
    this.wireMat = new THREE.MeshBasicMaterial({
      color: 0x4a3020,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
    });
    this.wireMesh = new THREE.Mesh(this.clayGeo, this.wireMat);
    this.wireMesh.visible = false;
    this.scene.add(this.wireMesh);
  }

  _initGrid() {
    const geo = new THREE.PlaneGeometry(6, 6);
    const mat = new THREE.ShaderMaterial({
      vertexShader: gridVertexShader,
      fragmentShader: gridFragmentShader,
      uniforms: {
        uColor:     { value: new THREE.Color(0x1a1714) },
        uLineColor: { value: new THREE.Color(0x3a342d) },
      },
      transparent: true,
      depthWrite: false,
    });
    const grid = new THREE.Mesh(geo, mat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -0.85;
    this.scene.add(grid);

    // Shadow receiver plane
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.851;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);
  }

  _initOrbit() {
    // Manual orbit -- no external dep
    this.orbit = {
      theta: 0.6,   // horizontal angle
      phi: 0.55,    // vertical angle
      radius: 3.2,
      target: new THREE.Vector3(0, 0, 0),
      isDragging: false,
      lastX: 0,
      lastY: 0,
    };
    this._applyOrbit();
  }

  // ─── Mesh Update ────────────────────────────────────────────────────────────

  updateMesh(meshData) {
    const { vertices, normals, indices } = meshData;

    const posArr  = new Float32Array(vertices);
    const normArr = new Float32Array(normals);
    const idxArr  = new Uint32Array(indices);

    this.clayGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    this.clayGeo.setAttribute('normal',   new THREE.BufferAttribute(normArr, 3));
    this.clayGeo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    this.clayGeo.computeBoundingSphere();
    this.clayGeo.attributes.position.needsUpdate = true;
    this.clayGeo.attributes.normal.needsUpdate   = true;
    this.clayGeo.index.needsUpdate               = true;
  }

  // ─── Orbit Control ──────────────────────────────────────────────────────────

  startOrbit(x, y) {
    this.orbit.isDragging = true;
    this.orbit.lastX = x;
    this.orbit.lastY = y;
  }

  updateOrbit(x, y) {
    if (!this.orbit.isDragging) return;
    const dx = (x - this.orbit.lastX) * 0.008;
    const dy = (y - this.orbit.lastY) * 0.006;
    this.orbit.theta -= dx;
    this.orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, this.orbit.phi + dy));
    this.orbit.lastX = x;
    this.orbit.lastY = y;
    this._applyOrbit();
  }

  endOrbit() {
    this.orbit.isDragging = false;
  }

  zoom(delta) {
    this.orbit.radius = Math.max(0.6, Math.min(8, this.orbit.radius + delta * 0.001));
    this._applyOrbit();
  }

  _applyOrbit() {
    const { theta, phi, radius, target } = this.orbit;
    this.camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    this.camera.lookAt(target);
  }

  // ─── Ray casting for sculpt hit ─────────────────────────────────────────────

  raycastClay(mouseX, mouseY) {
    const rect = this.container.getBoundingClientRect();
    const ndcX = ((mouseX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((mouseY - rect.top)  / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);

    const hits = raycaster.intersectObject(this.clayMesh, false);
    if (hits.length > 0) {
      const p = hits[0].point;
      return { x: p.x, y: p.y, z: p.z, hit: true };
    }
    return { hit: false };
  }

  // ─── Display helpers ────────────────────────────────────────────────────────

  setWireframe(on) {
    this.wireMesh.visible = on;
  }

  setClayColor(hex) {
    this.clayMat.uniforms.uClayColor.value.set(hex);
  }

  // ─── Loop ───────────────────────────────────────────────────────────────────

  _loop() {
    this._rafId = requestAnimationFrame(() => this._loop());
    this.renderer.render(this.scene, this.camera);
  }

  _bindResize() {
    const ro = new ResizeObserver(() => {
      this.width  = this.container.clientWidth;
      this.height = this.container.clientHeight;
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.width, this.height);
    });
    ro.observe(this.container);
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    this.renderer.dispose();
  }
}
