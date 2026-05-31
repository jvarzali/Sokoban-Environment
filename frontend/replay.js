// replay.js — Agent replay viewer. Reads the JSON exported by `mesocosm run export`.

const ACTION_RE = /\b(north|south|east|west|up|down|left|right|[nsew])\b/i;
const ALIAS_MAP = {
  up:"N", down:"S", left:"W", right:"E",
  north:"N", south:"S", east:"E", west:"W",
};
function parseAction(raw) {
  const t = raw.trim();
  const direct = ALIAS_MAP[t.toLowerCase()] || t.toUpperCase();
  if ("NSEW".includes(direct) && direct.length === 1) return direct;
  const m = ACTION_RE.exec(t);
  if (m) return ALIAS_MAP[m[1].toLowerCase()] || m[1].toUpperCase();
  return "?";
}

// ── state ──────────────────────────────────────────────────────────────────
let replayData   = null;   // parsed export JSON
let episodes     = [];     // [{id, seed, won, steps:[...]}]
let epIndex      = 0;
let stepIndex    = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────
const replayBoard   = document.getElementById("replayBoard");
const replayStatus  = document.getElementById("replayStatus");
const replayEpSel   = document.getElementById("replayEpSel");
const replayStep    = document.getElementById("replayStep");
const replayAction  = document.getElementById("replayAction");
const replayThink   = document.getElementById("replayThink");
const replayInfo    = document.getElementById("replayInfo");
const replayPrev    = document.getElementById("replayPrev");
const replayNext    = document.getElementById("replayNext");

// ── load ───────────────────────────────────────────────────────────────────
document.getElementById("replayFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      replayData = JSON.parse(ev.target.result);
      buildEpisodes();
    } catch (err) {
      replayStatus.textContent = "Invalid JSON: " + err.message;
    }
  };
  reader.readAsText(file);
});

function buildEpisodes() {
  const epMeta = {};
  for (const ep of (replayData.episodes || [])) {
    epMeta[ep.id] = ep;
  }
  episodes = [];
  for (const [id, steps] of Object.entries(replayData.replay || {})) {
    const meta = epMeta[id] || {};
    episodes.push({
      id,
      seed: meta.seed ?? "?",
      won: meta.total_reward > 0,
      steps,
    });
  }
  episodes.sort((a, b) => a.seed - b.seed);

  replayEpSel.innerHTML = "";
  for (const [i, ep] of episodes.entries()) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `Seed ${ep.seed}  ${ep.won ? "✓ Win" : "✗ Fail"}`;
    replayEpSel.appendChild(o);
  }

  epIndex = 0;
  stepIndex = 0;
  renderReplay();
}

// ── navigation ─────────────────────────────────────────────────────────────
replayEpSel.addEventListener("change", (e) => {
  epIndex = Number(e.target.value);
  stepIndex = 0;
  renderReplay();
});
// Prevent the select from swallowing arrow keys — delegate to step navigation instead.
replayEpSel.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp"   || e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   stepBack();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") stepFwd();
  }
});
replayPrev.addEventListener("click", () => { stepBack(); replayPrev.focus(); });
replayNext.addEventListener("click", () => { stepFwd();  replayNext.focus(); });
// Arrow key step navigation — fires for the whole pane except when focus is in
// the episode select (handled above) or a text input where the user is typing.
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("replayPane").classList.contains("active")) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tag = document.activeElement?.tagName;
  // Let the textarea keep arrow keys for its own scrolling unless it's readonly.
  if (tag === "INPUT") return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "ArrowLeft")  stepBack();
  if (e.key === "ArrowRight") stepFwd();
});

function stepBack() {
  if (stepIndex > 0) { stepIndex--; renderReplay(); }
}
function stepFwd() {
  const ep = episodes[epIndex];
  if (ep && stepIndex < ep.steps.length - 1) { stepIndex++; renderReplay(); }
}

// ── render ─────────────────────────────────────────────────────────────────
function renderReplay() {
  const ep = episodes[epIndex];
  if (!ep) { replayStatus.textContent = "No data loaded."; return; }

  const step = ep.steps[stepIndex];
  const total = ep.steps.length;
  replayStep.textContent = `Step ${stepIndex + 1} / ${total}`;
  replayPrev.disabled = stepIndex === 0;
  replayNext.disabled = stepIndex === total - 1;

  // Always use board_before — board_after in the export is captured after the env
  // has already been reset to the next episode (platform bug), so it shows the
  // wrong map. board_before is always correct: it's what the agent actually saw.
  const boardData = step.board_before;
  const obs = boardData?.observation || boardData;

  drawGrid(obs);

  // Action
  const parsed = parseAction(step.action || "");
  const invalid = step.info?.invalid === "1.0";
  replayAction.innerHTML =
    `<b>Action:</b> <code style="font-size:16px;color:${invalid?"#e07":"#5d5"}">${parsed}</code>` +
    (invalid ? " <span style='color:#e07'>(invalid)</span>" : "") +
    `  <b>Reward:</b> ${step.reward}` +
    (step.terminated ? "  <span style='color:#5d5'>✓ WIN</span>" : "") +
    (step.truncated  ? "  <span style='color:#e55'>✗ truncated</span>" : "");

  // Thinking
  replayThink.value = step.reasoning || "(no reasoning)";

  // Info bar
  const info = step.info || {};
  replayInfo.textContent =
    `env steps: ${info.steps ?? "–"}  |  success: ${info.success ?? "–"}  |  invalid: ${info.invalid ?? "–"}`;

  // Status line
  if (step.terminated) {
    replayStatus.textContent = `✓ Solved in ${info.steps} env steps`;
    replayStatus.className = "status win";
  } else if (step.truncated) {
    replayStatus.textContent = `✗ Out of steps (${info.steps})`;
    replayStatus.className = "status fail";
  } else {
    replayStatus.textContent = `Seed ${ep.seed} — env step ${info.steps ?? "?"}`;
    replayStatus.className = "status";
  }
}

function drawGrid(obs) {
  if (!obs || !obs.grid) { replayBoard.innerHTML = "(no grid)"; return; }
  const grid = obs.grid;
  const goal = obs.goal;
  const nrows = grid.length;
  const ncols = Math.max(...grid.map((r) => r.length));
  const cell = Math.max(28, Math.min(52, Math.floor(500 / Math.max(nrows, ncols))));

  replayBoard.style.gridTemplateColumns = `repeat(${ncols}, ${cell}px)`;
  replayBoard.innerHTML = "";

  const RAMP_ARROW = { 4:"↑", 5:"→", 6:"↓", 7:"←" };

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const div = document.createElement("div");
      div.className = "tile";
      div.style.width = div.style.height = `${cell}px`;
      div.style.fontSize = `${Math.floor(cell * 0.5)}px`;

      const v = c < grid[r].length ? grid[r][c] : 3;
      const isGoal = goal && goal[0] === r && goal[1] === c;

      if (v === 3) {
        div.classList.add("wall");
      } else {
        const isHigh = v === 1 || v === 2 || v === 10;
        div.classList.add(isHigh ? "high" : "low");
        if (isGoal) div.classList.add("goal");

        let inner = null;
        if (v >= 4 && v <= 7) {
          inner = document.createElement("span");
          inner.className = "ramp";
          inner.textContent = RAMP_ARROW[v];
        } else if (v === 8 || v === 2) {
          inner = document.createElement("span");
          inner.className = "box" + (v === 2 ? " onhigh" : "");
          inner.textContent = "■";
        } else if (v === 9 || v === 10) {
          inner = document.createElement("span");
          inner.className = "player" + (v === 10 ? " phigh" : "");
          inner.textContent = "●";
        } else if (isGoal) {
          inner = document.createElement("span");
          inner.className = "goalring";
          inner.textContent = "◎";
        }
        if (inner) div.appendChild(inner);
      }
      replayBoard.appendChild(div);
    }
  }
}
