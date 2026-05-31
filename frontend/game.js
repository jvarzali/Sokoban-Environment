// game.js - Mountain Sokoban engine (browser port of env.py).
// Pure rules, no UI. Mirrors env.py exactly so every client (2D, 3D, parity
// test) shares one verified source of truth. Exposed as window.Sokoban in the
// browser and module.exports under Node. Maps come from maps.js.

const DELTA = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };
const OPP   = { N: "S", S: "N", E: "W", W: "E" };
const RAMP_DIR = { 4: "N", 5: "E", 6: "S", 7: "W" };
const DIR_RAMP = { N: 4, E: 5, S: 6, W: 7 };
const ELEV = { low: 0, high: 2 };

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
        else if (v === 9 || v === 10) this.player = [r, c];
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

  // Elevation of the standable surface at x (terrain, +2 if a box sits there
  // since a box is one step tall). null for walls.
  stand(x) {
    const t = this.terr(x);
    if (t === "wall") return null;
    return ELEV[t] + (this.boxes.has(this.key(x)) ? 2 : 0);
  }

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
    const h = this.stand(p);                                  // player's current surface
    if (this.ramps.has(this.key(t))) return this._ramp(p, t, dir, d);
    if (this.boxes.has(this.key(t))) return this._enterBox(p, t, d, h);
    if (ELEV[this.terr(t)] <= h) { this.player = t; return true; }   // flat or descend
    return false;                                             // cliff (need a ramp)
  }

  // Step onto a box from at/above its top; from its base level push it instead.
  // You can never climb up onto a box.
  _enterBox(p, t, d, h) {
    const boxBase = ELEV[this.terr(t)];
    if (h >= boxBase + 2) { this.player = t; return true; }   // step onto the box top
    if (h === boxBase) return this._push(p, t, d, h);         // level -> push
    return false;                                             // box base is up a cliff
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

  _push(p, t, d, h) {
    const c = this.add(t, d);
    if (this.terr(c) === "wall" || this.occ(c)) return false;
    if (ELEV[this.terr(c)] - ELEV[this.terr(t)] > 0) return false;  // no uphill
    if (ELEV[this.terr(t)] - h > 0) return false;                   // can't climb to push
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

// Shared BFS solver: returns the shortest action list to the goal, or null.
Sokoban.solve = function solve(map) {
  const stateKey = (g) => {
    const boxes = [...g.boxes].sort().join("|");
    const ramps = [...g.ramps.entries()].map(([k, v]) => `${k}:${v}`).sort().join("|");
    return `${g.player[0]},${g.player[1]};${boxes};${ramps}`;
  };
  const s = new Sokoban(map);
  if (s.player[0] === s.goal[0] && s.player[1] === s.goal[1]) return [];
  const seen = new Set([stateKey(s)]);
  let frontier = [{ snap: s.snapshot(), path: [] }];
  const probe = new Sokoban(map);
  for (let depth = 0; depth < 10000 && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const dir of ["N", "S", "E", "W"]) {
        probe.restore(node.snap);
        if (!probe.move(dir)) continue;
        if (probe.player[0] === probe.goal[0] && probe.player[1] === probe.goal[1]) {
          return [...node.path, dir];
        }
        const k = stateKey(probe);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ snap: probe.snapshot(), path: [...node.path, dir] });
      }
    }
    frontier = next;
  }
  return null;
};

if (typeof window !== "undefined") window.Sokoban = Sokoban;
if (typeof module !== "undefined" && module.exports) module.exports = { Sokoban };
