// app.js - view controller for the replay viewer. Owns the 2D + 3D renderers and
// the view-mode toggle. There is no manual play: replay.js loads run-export files
// and drives the views through window.appRenderFrame. The engine (window.Sokoban)
// is only used to build a frame's board for rendering.
import { View2D } from "./view2d.js";
import { View3D } from "./view3d.js";

const Sokoban = window.Sokoban;
const MAPS = window.SOKOBAN_MAPS || [];

const $ = (id) => document.getElementById(id);
const hud = $("hud");
const elevBadge = $("elev");
const stage = $("stage");

let view2d = null, view3d = null, view3dError = null, mode = "2d";
let current = null;   // the Sokoban currently shown (so resize/mode-change can re-fit)

function render(game, hudMsg, hudCls) {
  current = game;
  view2d.build(game);
  if (view3d) view3d.build(game);
  if (elevBadge) {
    const high = (game.stand ? game.stand(game.player) : 0) >= 2;
    elevBadge.textContent = high ? "high" : "low";
    elevBadge.className = high ? "badge high" : "badge low";
  }
  if (hud) { hud.textContent = hudMsg ?? game.name; hud.className = hudCls ?? "hud"; }
}

function setMode(m) {
  if ((m === "3d" || m === "split") && view3dError) {
    if (hud) { hud.textContent = "3D unavailable: " + view3dError; hud.className = "hud fail"; }
    if (m === "3d") return;
  }
  mode = m;
  stage.className = "stage mode-" + m;
  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === m));
  requestAnimationFrame(() => {
    if (current) view2d.build(current);
    if (view3d) view3d.resize();
  });
}

function init() {
  view2d = new View2D($("board"));
  try {
    view3d = new View3D($("viewport"));
  } catch (err) {
    view3dError = err.message || String(err);
    console.error("3D init failed:", err);
  }

  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));

  window.addEventListener("resize", () => {
    if (current) view2d.build(current);
    if (view3d) view3d.resize();
  });

  // replay.js renders each frame through this hook
  window.appRenderFrame = (game, hudMsg, hudCls) => render(game, hudMsg, hudCls);
  // replay.js calls this on a win to burst confetti around the ball in the views
  window.appCelebrate = () => { if (view2d) view2d.confetti(); if (view3d) view3d.confetti(); };
  // replay.js calls this on an invalid move so the ball lunges, flashes red, springs back
  window.appBump = (dir) => { if (view2d) view2d.bump(dir); if (view3d) view3d.bump(dir); };

  setMode("2d");

  // initial preview so the board isn't blank before a run is loaded
  if (MAPS.length) render(new Sokoban(MAPS[0]), "Load a run export to begin");
  else if (hud) hud.textContent = "No maps (run python frontend/build_maps.py)";
}

init();
