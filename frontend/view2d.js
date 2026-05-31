// view2d.js - top-down 2D renderer. Reads engine state and paints a CSS grid
// into the given board element. Stateless: app.js calls render() after changes.
const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };

export class View2D {
  constructor(boardEl) {
    this.boardEl = boardEl;
  }

  maxCols(g) { return Math.max(...g.rowlen); }

  render(g) {
    const cols = this.maxCols(g);
    // Fit to the panel; fall back to a sensible size before layout settles.
    const avail = this.boardEl.parentElement
      ? Math.min(this.boardEl.parentElement.clientWidth - 24,
                 this.boardEl.parentElement.clientHeight - 24)
      : 520;
    const cell = Math.max(22, Math.min(64, Math.floor((avail || 520) / Math.max(g.nrows, cols))));
    this.boardEl.style.gridTemplateColumns = `repeat(${cols}, ${cell}px)`;
    this.boardEl.innerHTML = "";
    for (let r = 0; r < g.nrows; r++) {
      for (let c = 0; c < cols; c++) {
        const div = document.createElement("div");
        div.className = "tile";
        div.style.width = div.style.height = `${cell}px`;
        div.style.fontSize = `${Math.floor(cell * 0.5)}px`;
        const here = [r, c];
        const t = g.terr(here);
        const k = `${r},${c}`;
        const isGoal = g.goal[0] === r && g.goal[1] === c;
        if (!g.inb(here) || t === "wall") {
          div.classList.add("wall");
        } else {
          div.classList.add(t === "high" ? "high" : "low");
          if (isGoal) div.classList.add("goal");
          const playerHere = g.player[0] === r && g.player[1] === c;
          const boxHere = g.boxes.has(k);
          if (g.ramps.has(k)) {
            div.appendChild(span("ramp", ARROW[g.ramps.get(k)]));
          } else if (playerHere) {
            // player wins over a box it is standing on; mark the cell as a box top
            if (boxHere) div.classList.add("onbox");
            div.appendChild(span("player" + (g.stand([r, c]) >= 2 ? " phigh" : ""), "●"));
          } else if (boxHere) {
            div.appendChild(span("box" + (t === "high" ? " onhigh" : ""), "■"));
          } else if (isGoal) {
            div.appendChild(span("goalring", "◎"));
          }
        }
        this.boardEl.appendChild(div);
      }
    }
  }
}

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
