// game.js - Mountain Sokoban rules + renderer (browser port of env.py).
// The engine here mirrors env.py exactly so the playable client matches the
// environment the agent is scored against. Maps come from maps.js.

const DELTA = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };
const OPP   = { N: "S", S: "N", E: "W", W: "E" };
const KEYS  = {
  ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E",
  w: "N", s: "S", a: "W", d: "E", W: "N", S: "S", A: "W", D: "E",
};
const RAMP_DIR = { 4: "N", 5: "E", 6: "S", 7: "W" };
const DIR_RAMP = { N: 4, E: 5, S: 6, W: 7 };
const ELEV = { low: 0, high: 2 };
const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };

// ---- engine ----------------------------------------------------------------
class Sokoban {
  constructor(map) {
    this.name = map.name || "map";
    this.maxSteps = map.max_steps || 100;
    this.goal = [map.goal[0], map.goal[1]];
    const g = map.grid;
    this.nrows = g.length;
    this.rowlen = g.map((r) => r.length);
    this.terrain = [];
    this.ramps = new Map();   // "r,c" -> dir
    this.boxes = new Set();    // "r,c"
    this.player = null;
    for (let r = 0; r < g.length; r++) {
      const trow = [];
      for (let c = 0; c < g[r].length; c++) {
        const v = g[r][c];
        if (v === 3) trow.push("wall");
        else if (v === 1 || v === 2) trow.push("high");
        else trow.push("low");
        if (RAMP_DIR[v]) this.ramps.set(`${r},${c}`, RAMP_DIR[v]);
        else if (v === 8 || v === 2) this.boxes.add(`${r},${c}`);
        else if (v === 9) this.player = [r, c];
      }
      this.terrain.push(trow);
    }
    this.steps = 0;
    this.won = false;
  }

  key(x) { return `${x[0]},${x[1]}`; }
  inb(x) { return x[0] >= 0 && x[0] < this.nrows && x[1] >= 0 && x[1] < this.rowlen[x[0]]; }
  terr(x) { return this.inb(x) ? this.terrain[x[0]][x[1]] : "wall"; }
  occ(x) { const k = this.key(x); return this.boxes.has(k) || this.ramps.has(k); }
  add(x, d) { return [x[0] + d[0], x[1] + d[1]]; }

  // Returns true if the move changed state (a "valid" step), else false.
  move(dir) {
    if (this.won) return false;
    const d = DELTA[dir];
    if (!d) return false;
    const ok = this._try(dir, d);
    this.steps += 1;
    if (this.player[0] === this.goal[0] && this.player[1] === this.goal[1]) this.won = true;
    return ok;
  }

  _try(dir, d) {
    const p = this.player;
    const t = this.add(p, d);
    if (this.terr(t) === "wall") return false;
    if (this.ramps.has(this.key(t))) return this._ramp(p, t, dir, d);
    if (this.boxes.has(this.key(t))) return this._push(p, t, d);
    const dh = ELEV[this.terr(t)] - ELEV[this.terr(p)];
    if (dh <= 0) { this.player = t; return true; }   // flat or descend
    return false;                                      // cliff
  }

  _ramp(p, t, dir, d) {
    const up = this.ramps.get(this.key(t));
    const b = this.add(t, d);
    if (dir === up && this.terr(b) === "high" && !this.occ(b)) { this.player = b; return true; }
    if (dir === OPP[up] && this.terr(b) === "low" && !this.occ(b)) { this.player = b; return true; }
    if (this.terr(b) === "low" && !this.occ(b)) {
      this.ramps.delete(this.key(t));
      this.ramps.set(this.key(b), up);
      this.player = t;
      return true;
    }
    return false;
  }

  _push(p, t, d) {
    const c = this.add(t, d);
    if (this.terr(c) === "wall" || this.occ(c)) return false;
    if (ELEV[this.terr(c)] - ELEV[this.terr(t)] > 0) return false;  // no uphill
    if (ELEV[this.terr(t)] - ELEV[this.terr(p)] > 0) return false;  // can't climb to push
    this.boxes.delete(this.key(t));
    this.boxes.add(this.key(c));
    this.player = t;
    return true;
  }

  snapshot() {
    return {
      player: [...this.player],
      boxes: new Set(this.boxes),
      ramps: new Map(this.ramps),
      steps: this.steps,
      won: this.won,
    };
  }
  restore(s) {
    this.player = [...s.player];
    this.boxes = new Set(s.boxes);
    this.ramps = new Map(s.ramps);
    this.steps = s.steps;
    this.won = s.won;
  }
}

// ---- UI --------------------------------------------------------------------
const maps = (typeof window !== "undefined" && window.SOKOBAN_MAPS) || [];
let game = null;
let history = [];
let mapIndex = 0;

const inBrowser = typeof document !== "undefined";
const boardEl = inBrowser ? document.getElementById("board") : null;
const statusEl = inBrowser ? document.getElementById("status") : null;
const selectEl = inBrowser ? document.getElementById("mapSelect") : null;
const elevEl = inBrowser ? document.getElementById("elev") : null;

function loadMap(i) {
  mapIndex = (i + maps.length) % maps.length;
  game = new Sokoban(maps[mapIndex]);
  history = [];
  selectEl.value = String(mapIndex);
  render(null);
}

function doMove(dir) {
  if (!game || game.won) return;
  const before = game.snapshot();
  const ok = game.move(dir);
  if (ok) history.push(before);
  render(ok ? null : "invalid");
}

function undo() {
  if (history.length) { game.restore(history.pop()); render(null); }
}

function render(flash) {
  const cell = Math.max(28, Math.min(56, Math.floor(520 / Math.max(game.nrows, maxCols()))));
  boardEl.style.gridTemplateColumns = `repeat(${maxCols()}, ${cell}px)`;
  boardEl.innerHTML = "";
  for (let r = 0; r < game.nrows; r++) {
    for (let c = 0; c < maxCols(); c++) {
      const div = document.createElement("div");
      div.className = "tile";
      div.style.width = div.style.height = `${cell}px`;
      div.style.fontSize = `${Math.floor(cell * 0.5)}px`;
      const here = [r, c];
      const t = game.terr(here);
      const k = `${r},${c}`;
      const isGoal = game.goal[0] === r && game.goal[1] === c;
      if (!game.inb(here) || t === "wall") {
        div.classList.add("wall");
      } else {
        div.classList.add(t === "high" ? "high" : "low");
        if (isGoal) div.classList.add("goal");
        if (game.ramps.has(k)) {
          const a = document.createElement("span");
          a.className = "ramp";
          a.textContent = ARROW[game.ramps.get(k)];
          div.appendChild(a);
        } else if (game.boxes.has(k)) {
          const b = document.createElement("span");
          b.className = "box" + (t === "high" ? " onhigh" : "");
          b.textContent = "■";
          div.appendChild(b);
        } else if (game.player[0] === r && game.player[1] === c) {
          const p = document.createElement("span");
          p.className = "player" + (t === "high" ? " phigh" : "");
          p.textContent = "●";
          div.appendChild(p);
        } else if (isGoal) {
          const ring = document.createElement("span");
          ring.className = "goalring";
          ring.textContent = "◎";
          div.appendChild(ring);
        }
      }
      boardEl.appendChild(div);
    }
  }
  const pe = ELEV[game.terr(game.player)];
  elevEl.textContent = pe === 2 ? "high" : "low";
  elevEl.className = pe === 2 ? "badge high" : "badge low";
  let msg;
  if (game.won) {
    msg = `✔ Solved "${game.name}" in ${game.steps} steps!`;
    statusEl.className = "status win";
  } else if (game.steps >= game.maxSteps) {
    msg = `✗ Out of steps (${game.steps}/${game.maxSteps}). Press Reset.`;
    statusEl.className = "status fail";
  } else {
    msg = `${game.name} — steps ${game.steps}/${game.maxSteps}`;
    statusEl.className = flash === "invalid" ? "status invalid" : "status";
  }
  statusEl.textContent = msg;
}

function maxCols() { return Math.max(...game.rowlen); }

// ---- wiring ----------------------------------------------------------------
function init() {
  if (!maps.length) {
    statusEl.textContent = "No maps loaded (run python frontend/build_maps.py).";
    return;
  }
  maps.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${i + 1}. ${m.name}`;
    selectEl.appendChild(o);
  });
  selectEl.addEventListener("change", (e) => loadMap(Number(e.target.value)));
  // Prevent arrow keys on the map select from switching maps unintentionally.
  selectEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "ArrowUp"   || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  document.getElementById("reset").addEventListener("click", () => loadMap(mapIndex));
  document.getElementById("undo").addEventListener("click", undo);
  document.getElementById("prev").addEventListener("click", () => loadMap(mapIndex - 1));
  document.getElementById("next").addEventListener("click", () => loadMap(mapIndex + 1));
  document.querySelectorAll("[data-dir]").forEach((btn) =>
    btn.addEventListener("click", () => doMove(btn.dataset.dir)));
  window.addEventListener("keydown", (e) => {
    // Don't process game keys when the replay pane is active.
    if (document.getElementById("replayPane")?.classList.contains("active")) return;
    if (e.key === "r" || e.key === "R") { loadMap(mapIndex); return; }
    if (e.key === "u" || e.key === "U") { undo(); return; }
    const dir = KEYS[e.key];
    if (dir) { e.preventDefault(); doMove(dir); }
  });
  loadMap(0);
}

if (inBrowser) init();
if (typeof module !== "undefined" && module.exports) module.exports = { Sokoban };
