// view2d.js - top-down 2D renderer with smooth movement.
// A static terrain layer is drawn once per map; the player, boxes, and ramps are
// persistent absolutely-positioned elements that slide between cells via CSS
// transitions (so nothing teleports). build() snaps instantly; animate(before)
// tweens whatever moved, mirroring view3d's API.
const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };

export class View2D {
  constructor(boardEl) {
    this.boardEl = boardEl;
    this.engine = null;
    this.cell = 40;
    this.moveDur = 0.32;
    this.boxEls = new Map();   // "r,c" -> element
    this.rampEls = new Map();  // "r,c" -> element
    this.playerEl = null;
  }

  _fit() {
    const cols = Math.max(...this.engine.rowlen), rows = this.engine.nrows;
    const parent = this.boardEl.parentElement;
    const avail = parent ? Math.min(parent.clientWidth - 24, parent.clientHeight - 24) : 480;
    this.cols = cols; this.rows = rows;
    this.cell = Math.max(20, Math.min(76, Math.floor((avail || 480) / Math.max(rows, cols))));
    this.boardEl.style.position = "relative";
    this.boardEl.style.width = `${cols * this.cell}px`;
    this.boardEl.style.height = `${rows * this.cell}px`;
  }

  // entity element sized as a fraction of the cell, transitions off until placed
  _entity(cls, frac) {
    const el = document.createElement("div");
    el.className = "e2d " + cls;
    const s = Math.round(this.cell * frac);
    el._sz = s;
    el.style.width = el.style.height = `${s}px`;
    el.style.transition = "none";
    return el;
  }

  _place(el, r, c) {
    const off = (this.cell - el._sz) / 2;
    el.style.transform = `translate(${c * this.cell + off}px, ${r * this.cell + off}px)`;
  }

  _enableTransitions() {
    const t = `transform ${this.moveDur}s ease-in-out`;
    for (const el of this.boxEls.values()) el.style.transition = t;
    for (const el of this.rampEls.values()) el.style.transition = t;
    if (this.playerEl) this.playerEl.style.transition = t;
  }

  _tintPlayer() {
    this.playerEl.classList.toggle("phigh", this.engine.stand(this.engine.player) >= 2);
  }

  // full instant (re)build: static terrain + fresh entities at current state
  build(engine) {
    this.engine = engine;
    this._fit();
    this.boardEl.innerHTML = "";
    this.boxEls.clear(); this.rampEls.clear(); this.playerEl = null;
    const cell = this.cell;

    for (let r = 0; r < engine.nrows; r++) {
      for (let c = 0; c < Math.max(...engine.rowlen); c++) {
        const here = [r, c];
        const t = engine.terr(here);
        const tile = document.createElement("div");
        tile.className = "t2d " + (!engine.inb(here) || t === "wall" ? "wall" : t === "high" ? "high" : "low");
        tile.style.width = tile.style.height = `${cell}px`;
        tile.style.left = `${c * cell}px`;
        tile.style.top = `${r * cell}px`;
        if (engine.goal[0] === r && engine.goal[1] === c) tile.classList.add("goal");
        this.boardEl.appendChild(tile);
      }
    }

    for (const [k, dir] of engine.ramps) {
      const el = this._entity("ramp2d", 0.78);
      el.textContent = ARROW[dir];
      el.style.fontSize = `${Math.floor(cell * 0.5)}px`;
      const [r, c] = k.split(",").map(Number);
      this._place(el, r, c);
      this.boardEl.appendChild(el);
      this.rampEls.set(k, el);
    }
    for (const k of engine.boxes) {
      const [r, c] = k.split(",").map(Number);
      const el = this._entity("box2d", 0.86);
      if (engine.terr([r, c]) === "high") el.classList.add("onhigh");
      this._place(el, r, c);
      this.boardEl.appendChild(el);
      this.boxEls.set(k, el);
    }
    const p = this._entity("player2d", 0.56);
    this.playerEl = p;
    this._place(p, engine.player[0], engine.player[1]);
    this.boardEl.appendChild(p);
    this._tintPlayer();

    // turn transitions on after this frame so the initial layout doesn't animate
    requestAnimationFrame(() => this._enableTransitions());
  }

  // tween whatever changed between the pre-move snapshot and the current state
  animate(before) {
    const e = this.engine;
    this._enableTransitions();   // also picks up any speed change

    this._place(this.playerEl, e.player[0], e.player[1]);
    this._tintPlayer();

    const boxFrom = [...before.boxes].find((k) => !e.boxes.has(k));
    const boxTo = [...e.boxes].find((k) => !before.boxes.has(k));
    if (boxFrom && boxTo && this.boxEls.has(boxFrom)) {
      const el = this.boxEls.get(boxFrom);
      this.boxEls.delete(boxFrom);
      this.boxEls.set(boxTo, el);
      const [r, c] = boxTo.split(",").map(Number);
      el.classList.toggle("onhigh", e.terr([r, c]) === "high");
      this._place(el, r, c);
    }

    let rampFrom = null, rampTo = null;
    for (const k of before.ramps.keys()) if (!e.ramps.has(k)) rampFrom = k;
    for (const k of e.ramps.keys()) if (!before.ramps.has(k)) rampTo = k;
    if (rampFrom && rampTo && this.rampEls.has(rampFrom)) {
      const el = this.rampEls.get(rampFrom);
      this.rampEls.delete(rampFrom);
      this.rampEls.set(rampTo, el);
      const [r, c] = rampTo.split(",").map(Number);
      this._place(el, r, c);
    }
  }
}
