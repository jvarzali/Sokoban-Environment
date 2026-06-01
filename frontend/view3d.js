// view3d.js - Three.js 3D renderer with tweened move animation.
// Pure view: reads engine state, never mutates rules. build(engine) snaps the
// scene to a state; animate(before) tweens meshes from the previous state to
// the engine's current state. Runs its own RAF loop for camera damping + tweens.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

const COL = {
  low: 0x5b8c5a, high: 0xb08a4f, wall: 0x131a22, box: 0x7a4a22,
  player: 0x2f6fed, playerHigh: 0x7fb0ff, ramp: 0x6b7785, goal: 0xffd166, bg: 0x1b2430,
};
const LOW_TOP = 0, HIGH_TOP = 1.0;
const STEP = HIGH_TOP;   // world height of one elevation step (low -> high, or a box)
const RAMP_ANGLE = { E: 0, N: Math.PI / 2, W: Math.PI, S: -Math.PI / 2 };

export class View3D {
  constructor(container) {
    this.container = container;
    this.engine = null;
    this.boardGroup = null;
    this.playerMesh = null;
    this.boxMeshes = new Map();
    this.rampMeshes = new Map();
    this.anim = null;
    this.moveDur = 0.32;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.bg);
    this.scene.fog = new THREE.Fog(COL.bg, 16, 40);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Locked to a horizontal orbit: fixed 45 deg elevation, no pan/zoom, always
    // focused on the board center. The camera can only swing around the circle.
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.minPolarAngle = Math.PI / 4;   // 45 deg above the horizon
    this.controls.maxPolarAngle = Math.PI / 4;
    this._framed = false;

    this.scene.add(new THREE.HemisphereLight(0xbfd3ea, 0x202830, 0.85));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.0);
    this.sun.position.set(6, 12, 5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
    this.scene.add(this.sun);

    // shared geometry / materials
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      // a box is one full step tall (= one elevation level) and nearly fills the
      // cell, so its top is a surface the player can stand on.
      cargo: new THREE.BoxGeometry(0.9, STEP, 0.9),
      player: new THREE.SphereGeometry(0.28, 24, 18),
      goal: new THREE.TorusGeometry(0.34, 0.05, 12, 28),
      ramp: makeRampGeo(),
      conf: new THREE.PlaneGeometry(0.13, 0.19),
    };
    this.mat = {
      low: new THREE.MeshStandardMaterial({ color: COL.low, roughness: 0.95 }),
      high: new THREE.MeshStandardMaterial({ color: COL.high, roughness: 0.9 }),
      box: new THREE.MeshStandardMaterial({ color: COL.box, roughness: 0.8 }),
      ramp: new THREE.MeshStandardMaterial({ color: COL.ramp, roughness: 0.7, metalness: 0.1 }),
      goal: new THREE.MeshStandardMaterial({ color: COL.goal, emissive: COL.goal, emissiveIntensity: 0.6 }),
    };

    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ---- coordinate helpers ----
  _topY(terr) { return terr === "high" ? HIGH_TOP : LOW_TOP; }      // terrain surface
  _surfaceY(cell) { return this.engine.stand(cell) * 0.5 * STEP; }  // standable surface (incl. box top)
  _xz(cell) { return [cell[1] + this.offX, cell[0] + this.offZ]; }
  // player sits on whatever surface its cell offers (terrain, or a box top)
  _playerW(cell) { const [x, z] = this._xz(cell); return new THREE.Vector3(x, this._surfaceY(cell) + 0.28, z); }
  // box rests on the terrain; its body is one step tall, so its center is half a step up
  _boxW(cell) { const [x, z] = this._xz(cell); return new THREE.Vector3(x, this._topY(this.engine.terr(cell)) + STEP / 2, z); }
  _rampW(cell) { const [x, z] = this._xz(cell); return new THREE.Vector3(x, 0, z); }

  // ---- (re)build the whole scene from an engine state ----
  build(engine) {
    this._finishAnim();
    this._bump = null;
    if (this._confetti) { this.scene.remove(this._confetti.group); this._confetti = null; }
    this.engine = engine;
    if (this.boardGroup) this.scene.remove(this.boardGroup);
    this.boardGroup = new THREE.Group();
    this.boxMeshes.clear();
    this.rampMeshes.clear();

    const cols = Math.max(...engine.rowlen), rows = engine.nrows;
    this.cols = cols; this.rows = rows;
    this.offX = -(cols - 1) / 2;
    this.offZ = -(rows - 1) / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = [r, c];
        const [x, z] = this._xz(cell);
        const inb = engine.inb(cell);
        const terr = engine.terr(cell);
        if (!inb || terr === "wall") continue;   // impassable cells render blank
        let mat, h, cy;
        if (terr === "high") { mat = this.mat.high; h = 1.5; cy = HIGH_TOP - 0.75; }
        else { mat = this.mat.low; h = 0.5; cy = LOW_TOP - 0.25; }
        const slab = new THREE.Mesh(this.geo.box, mat);
        slab.scale.set(0.98, h, 0.98);
        slab.position.set(x, cy, z);
        slab.castShadow = true; slab.receiveShadow = true;
        this.boardGroup.add(slab);
        const key = `${r},${c}`;
        if (engine.ramps.has(key)) {
          const m = new THREE.Mesh(this.geo.ramp, this.mat.ramp);
          m.rotation.y = RAMP_ANGLE[engine.ramps.get(key)];
          m.position.copy(this._rampW(cell));
          m.castShadow = true; m.receiveShadow = true;
          this.boardGroup.add(m);
          this.rampMeshes.set(key, m);
        } else if (engine.boxes.has(key)) {
          const m = new THREE.Mesh(this.geo.cargo, this.mat.box);
          m.position.copy(this._boxW(cell));
          m.castShadow = true; m.receiveShadow = true;
          this.boardGroup.add(m);
          this.boxMeshes.set(key, m);
        }
      }
    }

    // goal marker
    const goal = new THREE.Mesh(this.geo.goal, this.mat.goal);
    const [gx, gz] = this._xz(engine.goal);
    goal.position.set(gx, this._topY(engine.terr(engine.goal)) + 0.06, gz);
    goal.rotation.x = -Math.PI / 2;
    this.boardGroup.add(goal);
    const glow = new THREE.PointLight(COL.goal, 0.6, 4);
    glow.position.set(gx, this._topY(engine.terr(engine.goal)) + 0.8, gz);
    this.boardGroup.add(glow);

    // player
    this.playerMesh = new THREE.Mesh(this.geo.player,
      new THREE.MeshStandardMaterial({ color: COL.player, roughness: 0.4, metalness: 0.1 }));
    this.playerMesh.position.copy(this._playerW(engine.player));
    this.playerMesh.castShadow = true;
    this._tintPlayer();
    this.boardGroup.add(this.playerMesh);

    this.scene.add(this.boardGroup);
    this._fit();
  }

  // Frame the board: target its center, sit at a fixed 45 deg elevation, and pull
  // back just far enough that the whole map fits the current viewport. Preserves
  // the current orbit angle so a resize/rebuild doesn't snap the view around.
  _fit() {
    if (!this.engine) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const aspect = (w && h) ? w / h : 1.6;
    const center = new THREE.Vector3(0, 0.4, 0);
    const R = 0.5 * Math.hypot(this.cols, this.rows) + 0.65;    // bounding radius (+ block/entity height)
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const D = (R * 1.04) / Math.sin(Math.min(vHalf, hHalf));    // pull back just enough to fill the view
    const az = this._framed ? this.controls.getAzimuthalAngle() : Math.PI * 0.25;
    this.controls.target.copy(center);
    this.controls.minDistance = this.controls.maxDistance = D;
    this.camera.position.setFromSpherical(new THREE.Spherical(D, Math.PI / 4, az)).add(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this._framed = true;
  }

  _tintPlayer() {
    const elevated = this.engine.stand(this.engine.player) >= 2;   // on high ground or a box
    this.playerMesh.material.color.setHex(elevated ? COL.playerHigh : COL.player);
  }

  // ---- animate from a pre-move snapshot to the engine's current state ----
  animate(before) {
    this._finishAnim();
    const cur = this.engine;
    const items = [];
    // player
    items.push({ mesh: this.playerMesh, from: this.playerMesh.position.clone(), to: this._playerW(cur.player) });
    // a moved box
    const boxFrom = [...before.boxes].find((k) => !cur.boxes.has(k));
    const boxTo = [...cur.boxes].find((k) => !before.boxes.has(k));
    if (boxFrom && boxTo && this.boxMeshes.has(boxFrom)) {
      const mesh = this.boxMeshes.get(boxFrom);
      this.boxMeshes.delete(boxFrom);
      this.boxMeshes.set(boxTo, mesh);
      items.push({ mesh, from: mesh.position.clone(), to: this._boxW(cellOf(boxTo)) });
    }
    // a moved ramp
    let rampFrom = null, rampTo = null;
    for (const k of before.ramps.keys()) if (!cur.ramps.has(k)) rampFrom = k;
    for (const k of cur.ramps.keys()) if (!before.ramps.has(k)) rampTo = k;
    if (rampFrom && rampTo && this.rampMeshes.has(rampFrom)) {
      const mesh = this.rampMeshes.get(rampFrom);
      this.rampMeshes.delete(rampFrom);
      this.rampMeshes.set(rampTo, mesh);
      items.push({ mesh, from: mesh.position.clone(), to: this._rampW(cellOf(rampTo)) });
    }
    this.anim = { t: 0, dur: this.moveDur, items };
  }

  _advance(dt) {
    const a = this.anim;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = easeInOut(a.t);
    for (const it of a.items) {
      const x = lerp(it.from.x, it.to.x, e);
      const z = lerp(it.from.z, it.to.z, e);
      let y;
      if (Math.abs(it.to.y - it.from.y) < 1e-6) y = it.from.y;
      else if (it.to.y > it.from.y) y = lerp(it.from.y, it.to.y, easeOut(a.t));               // climb
      else y = lerp(it.from.y, it.to.y, easeIn(a.t)) - Math.sin(a.t * Math.PI) * 0.12;        // drop
      it.mesh.position.set(x, y, z);
    }
    if (a.t >= 1) this._finishAnim();
  }

  _finishAnim() {
    if (!this.anim) return;
    for (const it of this.anim.items) it.mesh.position.copy(it.to);
    this.anim = null;
    if (this.playerMesh && this.engine) this._tintPlayer();
  }

  isBusy() { return !!this.anim; }

  // celebratory confetti burst around the player
  confetti() {
    if (!this.playerMesh) return;
    const origin = this.playerMesh.position.clone();
    origin.y += 0.25;
    const colors = [0xffd166, 0x6c8cff, 0x5fd08a, 0xff7aa2, 0xffa94d, 0x8aa2ff];
    const group = new THREE.Group();
    const parts = [];
    for (let i = 0; i < 34; i++) {
      const m = new THREE.Mesh(this.geo.conf,
        new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true }));
      m.position.copy(origin);
      const a = Math.random() * Math.PI * 2;
      m.userData.v = new THREE.Vector3(Math.cos(a) * (0.7 + Math.random() * 1.6),
                                       1.6 + Math.random() * 2.0,
                                       Math.sin(a) * (0.7 + Math.random() * 1.6));
      m.userData.rot = new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      group.add(m); parts.push(m);
    }
    this.scene.add(group);
    this._confetti = { group, parts, t: 0, dur: 1.5 };
  }

  _advanceConfetti(dt) {
    const c = this._confetti;
    c.t += dt;
    for (const m of c.parts) {
      const v = m.userData.v;
      v.y -= 6.0 * dt;                          // gravity
      m.position.addScaledVector(v, dt);
      m.rotation.x += m.userData.rot.x * dt;
      m.rotation.y += m.userData.rot.y * dt;
      m.material.opacity = Math.max(0, 1 - c.t / c.dur);
    }
    if (c.t >= c.dur) {
      this.scene.remove(c.group);
      for (const m of c.parts) m.material.dispose();
      this._confetti = null;
    }
  }

  // illegal move: nudge the player toward the blocked cell, flash red, spring back
  bump(dir) {
    if (!this.playerMesh) return;
    if (this.anim) this._finishAnim();
    const D = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[dir];   // [dx, dz]
    if (!D) return;
    this.playerMesh.material.color.setHex(0xcf6a6a);                   // soft red during the bounce
    // peak travel = half a cell minus the sphere radius, so the ball meets the
    // wall edge instead of clipping into it
    this._bump = { t: 0, dur: 0.42, from: this.playerMesh.position.clone(), dx: D[0] * 0.22, dz: D[1] * 0.22 };
  }

  _advanceBump(dt) {
    const b = this._bump;
    b.t = Math.min(1, b.t + dt / b.dur);
    const o = Math.sin(b.t * Math.PI);   // 0 -> 1 -> 0, out and back
    this.playerMesh.position.set(b.from.x + b.dx * o, b.from.y, b.from.z + b.dz * o);
    if (b.t >= 1) {
      this.playerMesh.position.copy(b.from);
      this._bump = null;
      this._tintPlayer();                // restore the elevation-based color
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(w, h);   // updates canvas CSS size too, so it fills (and centers in) the panel
    this.camera.aspect = w / h;
    this._fit();   // re-fit so the whole board stays in frame at the new aspect
  }

  _loop(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.controls.update();
    if (this.anim) this._advance(dt);
    else if (this._bump) this._advanceBump(dt);
    if (this._confetti) this._advanceConfetti(dt);
    if (this.engine) this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }
}

function makeRampGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0.5, HIGH_TOP); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return g;
}
function cellOf(key) { return key.split(",").map(Number); }
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 2;
const easeIn = (t) => t * t;
