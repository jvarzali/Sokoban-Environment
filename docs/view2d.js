// view2d.js - top-down 2D renderer with smooth movement.
// A static terrain layer is drawn once per map; the player, boxes, and ramps are
// persistent absolutely-positioned elements that slide between cells via CSS
// transitions (so nothing teleports). build() snaps instantly; animate(before)
// tweens whatever moved, mirroring view3d's API.
const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };
const DELTA = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };

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
    const pad = 16;   // keep a little breathing room off the panel edges
    const availW = parent ? parent.clientWidth - pad : 480;
    const availH = parent ? parent.clientHeight - pad : 480;
    this.cols = cols; this.rows = rows;
    // largest square cell that fits the panel in both dimensions -> fills it
    this.cell = Math.max(8, Math.floor(Math.min(availW / cols, availH / rows)));
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
        if (!engine.inb(here) || t === "wall") continue;   // impassable cells render blank
        const tile = document.createElement("div");
        tile.className = "t2d " + (t === "high" ? "high" : "low");
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
    const core = document.createElement("div");   // inner visual; bounce animates this
    core.className = "player2d-core";
    p.appendChild(core);
    this.playerCore = core;
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

  // illegal move: lunge the player toward the blocked cell, flash red, spring back.
  // Animates the inner core (not the outer cell position), so it never fights the
  // slide transform and is always visible.
  bump(dir) {
    if (!this.playerCore) return;
    const [dr, dc] = DELTA[dir] || [0, 0];
    // travel just far enough that the ball's edge meets the wall (half a cell
    // minus the ball's radius), so it never clips into the wall cell.
    const amt = this.cell * 0.22;
    this.playerCore.classList.add("bumping");
    const anim = this.playerCore.animate(
      [{ transform: "translate(0,0)", easing: "cubic-bezier(.3,.6,.3,1)" },     // ease into the wall (no overshoot)
       { transform: `translate(${dc * amt}px, ${dr * amt}px)`, offset: 0.45, easing: "cubic-bezier(.4,0,.3,1.25)" }, // spring back (away from wall)
       { transform: "translate(0,0)" }],
      { duration: 430 },
    );
    anim.onfinish = anim.oncancel = () => this.playerCore.classList.remove("bumping");
  }

  // celebratory confetti burst around the player
  confetti() {
    if (!this.engine || !this.playerEl) return;
    const cell = this.cell;
    const cx = this.engine.player[1] * cell + cell / 2;
    const cy = this.engine.player[0] * cell + cell / 2;
    const colors = ["#ffd166", "#6c8cff", "#5fd08a", "#ff7aa2", "#ffa94d", "#8aa2ff"];
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("div");
      p.className = "confetti2d";
      const sz = 4 + Math.random() * 5;
      p.style.width = `${sz}px`;
      p.style.height = `${sz * 0.6}px`;
      p.style.background = colors[i % colors.length];
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      this.boardEl.appendChild(p);
      const ang = Math.random() * Math.PI * 2;
      const dist = cell * 0.7 + Math.random() * cell * 1.7;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist - cell * 0.4;   // bias slightly upward
      const rot = Math.random() * 720 - 360;
      const anim = p.animate(
        [{ transform: "translate(-50%,-50%) translate(0,0) rotate(0deg)", opacity: 1 },
         { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${rot}deg)`, opacity: 1, offset: 0.7 },
         { transform: `translate(-50%,-50%) translate(${dx}px,${dy + cell * 0.7}px) rotate(${rot}deg)`, opacity: 0 }],
        { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      anim.onfinish = anim.oncancel = () => p.remove();
    }
  }
}
