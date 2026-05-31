// app.js - controller. Owns one engine instance and drives both views (2D grid
// + 3D scene) from it, plus map selection, undo, view toggle, and trajectory
// playback. The engine (window.Sokoban) is the single source of truth; the views
// only render. Pacing is timer-based so playback works in any view mode.
import { View2D } from "./view2d.js";
import { View3D } from "./view3d.js";

const Sokoban = window.Sokoban;
const MAPS = window.SOKOBAN_MAPS || [];
const DIRS = ["N", "S", "E", "W"];
const KEYS = { ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E", w: "N", s: "S", a: "W", d: "E" };
const ALIAS = { UP: "N", DOWN: "S", LEFT: "W", RIGHT: "E" };

const $ = (id) => document.getElementById(id);
const hud = $("hud");
const elevBadge = $("elev");
const playBtn = $("play");
const stage = $("stage");

let view2d = null, view3d = null, view3dError = null;
let engine = null, mapIndex = 0, mode = "2d";
let history = [];
let queue = [], playing = false, speed = 1, timer = null;

// ---- core ------------------------------------------------------------------
function loadMap(i) {
  stopPlayback();
  queue = [];
  mapIndex = (i + MAPS.length) % MAPS.length;
  engine = new Sokoban(MAPS[mapIndex]);
  history = [];
  $("mapSelect").value = String(mapIndex);
  view2d.build(engine);
  if (view3d) view3d.build(engine);
  updateHud(null);
}

// Parse the trajectory box (JSON array or whitespace/comma separated) into a
// list of N/S/E/W actions, or null if there's nothing valid.
function parseTrajectory() {
  const raw = $("traj").value.trim();
  if (!raw) return null;
  let acts;
  try { acts = JSON.parse(raw); } catch { acts = raw.split(/[\s,]+/); }
  acts = acts.map((a) => String(a).trim().toUpperCase()).map((a) => ALIAS[a] || a).filter((a) => DIRS.includes(a));
  return acts.length ? acts : null;
}

function doMove(dir, animated) {
  if (engine.won || engine.steps >= engine.maxSteps) return false;
  const before = engine.snapshot();
  const ok = engine.move(dir);
  if (!ok) { if (!playing) flash(); return false; }
  history.push(before);
  if (animated) view2d.animate(before); else view2d.build(engine);
  if (view3d) { if (animated) view3d.animate(before); else view3d.build(engine); }
  updateHud(null);
  if (engine.won) stopPlayback();
  return true;
}

function undo() {
  stopPlayback();
  if (!history.length) return;
  engine.restore(history.pop());
  view2d.build(engine);
  if (view3d) view3d.build(engine);
  updateHud(null);
}

// ---- playback --------------------------------------------------------------
function interval() { return 360 / speed; }

function startPlayback(actions) {
  if (actions) queue = actions.slice();
  if (!queue.length) return;
  playing = true;
  syncPlayBtn();
  tickPlayback();
}

function tickPlayback() {
  clearTimeout(timer);
  if (!playing) return;
  if (!queue.length || engine.won) { stopPlayback(); return; }
  doMove(queue.shift(), true);
  timer = setTimeout(tickPlayback, interval());
}

function stopPlayback() {
  playing = false;
  clearTimeout(timer);
  syncPlayBtn();
}

function syncPlayBtn() { playBtn.textContent = playing ? "⏸ Pause" : "▶ Play"; }

// ---- view mode -------------------------------------------------------------
function setMode(m) {
  if (m === "3d" || m === "split") {
    if (view3dError) { flash("3D unavailable: " + view3dError); if (m === "3d") return; }
  }
  mode = m;
  stage.className = "stage mode-" + m;
  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === m));
  // views need a re-measure once their panel is visible
  requestAnimationFrame(() => {
    view2d.build(engine);
    if (view3d) view3d.resize();
  });
}

// ---- HUD -------------------------------------------------------------------
function updateHud(flashMsg) {
  const high = engine.terr(engine.player) === "high";
  elevBadge.textContent = high ? "high" : "low";
  elevBadge.className = high ? "badge high" : "badge low";
  let msg, cls = "hud";
  if (flashMsg) { msg = flashMsg; cls = "hud invalid"; }
  else if (engine.won) { msg = `✔ Solved "${engine.name}" in ${engine.steps} steps`; cls = "hud win"; }
  else if (engine.steps >= engine.maxSteps) { msg = `✗ Out of steps (${engine.steps}/${engine.maxSteps})`; cls = "hud fail"; }
  else msg = `${engine.name} — steps ${engine.steps}/${engine.maxSteps}`;
  hud.textContent = msg;
  hud.className = cls;
}
let flashTimer = null;
function flash(msg) {
  updateHud(msg || `${engine.name} — blocked`);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => updateHud(null), 220);
}

// ---- wiring ----------------------------------------------------------------
function init() {
  if (!MAPS.length) { hud.textContent = "No maps (run python frontend/build_maps.py)"; return; }

  view2d = new View2D($("board"));
  try {
    view3d = new View3D($("viewport"));
  } catch (err) {
    view3dError = err.message || String(err);
    console.error("3D init failed:", err);
  }

  const sel = $("mapSelect");
  MAPS.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = `${i + 1}. ${m.name}`;
    sel.appendChild(o);
  });
  sel.addEventListener("change", (e) => loadMap(Number(e.target.value)));
  $("prev").addEventListener("click", () => loadMap(mapIndex - 1));
  $("next").addEventListener("click", () => loadMap(mapIndex + 1));
  $("reset").addEventListener("click", () => loadMap(mapIndex));
  $("undo").addEventListener("click", undo);

  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));

  // Play / Pause: resume an in-progress replay, else load the trajectory box
  // (a pasted run / file) and play it from the start of the map.
  playBtn.addEventListener("click", () => {
    if (playing) { stopPlayback(); return; }
    if (!queue.length) {
      const acts = parseTrajectory();
      if (!acts) { flash("paste a trajectory to play"); return; }
      loadMap(mapIndex);          // replay from the map's initial state
      queue = acts;
    }
    startPlayback();
  });
  $("step").addEventListener("click", () => {
    stopPlayback();
    if (!queue.length) {
      const acts = parseTrajectory();
      if (!acts) { flash("paste a trajectory to step through"); return; }
      loadMap(mapIndex);
      queue = acts;
    }
    if (queue.length) doMove(queue.shift(), true);
  });
  $("speed").addEventListener("input", (e) => {
    speed = Number(e.target.value);
    $("speedVal").textContent = `${speed}x`;
    const dur = Math.min(0.32, (interval() * 0.9) / 1000);
    view2d.moveDur = dur;
    if (view3d) view3d.moveDur = dur;
  });
  $("playTraj").addEventListener("click", () => {
    const acts = parseTrajectory();
    if (!acts) { flash("no valid moves in trajectory"); return; }
    loadMap(mapIndex);
    startPlayback(acts);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") { loadMap(mapIndex); return; }
    if (e.key === "u" || e.key === "U") { undo(); return; }
    const dir = KEYS[e.key];
    if (dir) { e.preventDefault(); if (!playing) doMove(dir, true); }
  });
  window.addEventListener("resize", () => {
    view2d.build(engine);
    if (view3d) view3d.resize();
  });

  // Expose before loadMap so replay.js can call it as soon as the page loads.
  window.appRenderFrame = (game, hudMsg, hudCls) => {
    view2d.build(game);
    if (view3d) view3d.build(game);
    const high = game.terr(game.player) === "high";
    elevBadge.textContent = high ? "high" : "low";
    elevBadge.className = high ? "badge high" : "badge low";
    hud.textContent = hudMsg ?? game.name;
    hud.className = hudCls ?? "hud";
  };

  setMode("2d");
  loadMap(0);
}

init();
