// replay.js — Agent replay viewer. Reads the JSON exported by `mesocosm run export`.
// Each LLM call is expanded into individual move frames using the local game engine,
// so the viewer steps through one env action at a time instead of one LLM call at a time.

const ACTION_RE = /\b(north|south|east|west|up|down|left|right|[nsew])\b/i;
const ACTION_RE_ALL = /\b(north|south|east|west|up|down|left|right|[nsew])\b/gi;
const ALIAS_MAP = {
  up:"N", down:"S", left:"W", right:"E",
  north:"N", south:"S", east:"E", west:"W",
};
const DIR_RAMP_MAP = { N: 4, E: 5, S: 6, W: 7 };

function parseAction(raw) {
  const t = raw.trim();
  const direct = ALIAS_MAP[t.toLowerCase()] || t.toUpperCase();
  if ("NSEW".includes(direct) && direct.length === 1) return direct;
  const m = ACTION_RE.exec(t);
  if (m) return ALIAS_MAP[m[1].toLowerCase()] || m[1].toUpperCase();
  return "?";
}

// Extract every direction token from a (potentially verbose) LLM response.
function extractAllActions(text) {
  return [...text.matchAll(ACTION_RE_ALL)]
    .map(m => ALIAS_MAP[m[1].toLowerCase()] || m[1].toUpperCase())
    .filter(a => "NSEW".includes(a) && a.length === 1);
}

// Normalise the two board_before formats: {observation:{…}} or flat {grid:…}.
function getObs(boardField) {
  if (!boardField) return null;
  return boardField.observation || boardField;
}

// Render the current Sokoban state back into an observation object.
function obsFromGame(game, baseObs) {
  const grid = [];
  for (let r = 0; r < game.nrows; r++) {
    const row = [];
    for (let c = 0; c < game.rowlen[r]; c++) {
      const k = `${r},${c}`;
      const t = game.terrain[r][c];
      if (t === "wall") {
        row.push(3);
      } else if (game.ramps.has(k)) {
        row.push(DIR_RAMP_MAP[game.ramps.get(k)]);
      } else if (game.boxes.has(k)) {
        row.push(t === "high" ? 2 : 8);
      } else if (game.player[0] === r && game.player[1] === c) {
        row.push(t === "high" ? 10 : 9);
      } else {
        row.push(t === "high" ? 1 : 0);
      }
    }
    grid.push(row);
  }
  const stepsUsed  = (baseObs.steps_used  || 0) + game.steps;
  const stepsLeft  = Math.max(0, (baseObs.steps_remaining || 100) - game.steps);
  return {
    grid,
    player: [...game.player],
    player_elevation: game.terr(game.player) === "high" ? 2 : 0,
    goal: baseObs.goal,
    steps_used: stepsUsed,
    steps_remaining: stepsLeft,
  };
}

// Expand one LLM-call step into an array of individual move frames.
// Frame 0 is the "thinking" frame (board_before, no action yet).
// Frames 1..N are one frame per direction token executed.
function expandLLMStep(llmStep) {
  const baseObs = getObs(llmStep.board_before);
  if (!baseObs || !baseObs.grid) {
    return [{
      obs: baseObs, action: null, reasoning: llmStep.reasoning,
      isInvalid: false, isLLMStart: true, terminated: false, truncated: false, reward: 0,
    }];
  }

  let game;
  try {
    const maxSteps = (baseObs.steps_used || 0) + (baseObs.steps_remaining || 100);
    game = new Sokoban({ name: "replay", grid: baseObs.grid, goal: baseObs.goal, max_steps: maxSteps });
  } catch (e) {
    return [{ obs: baseObs, action: null, reasoning: llmStep.reasoning,
              isInvalid: false, isLLMStart: true, terminated: false, truncated: false, reward: 0 }];
  }

  const frames = [];

  // Thinking frame — what the agent saw before deciding
  frames.push({
    obs: obsFromGame(game, baseObs),
    action: null,
    reasoning: llmStep.reasoning,
    isLLMStart: true,
    isInvalid: false,
    terminated: false,
    truncated: false,
    reward: 0,
  });

  for (const dir of extractAllActions(llmStep.action || "")) {
    const ok = game.move(dir);
    frames.push({
      obs: obsFromGame(game, baseObs),
      action: dir,
      reasoning: llmStep.reasoning,
      isLLMStart: false,
      isInvalid: !ok,
      terminated: game.won,
      truncated: !game.won && game.steps >= game.maxSteps,
      reward: game.won ? 1.0 : 0.0,
    });
    if (game.won || game.steps >= game.maxSteps) break;
  }

  return frames;
}

// ── state ──────────────────────────────────────────────────────────────────
let replayData   = null;
let episodes     = [];     // [{id, seed, won, steps:[frame…]}]
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
  for (const [id, rawSteps] of Object.entries(replayData.replay || {})) {
    const meta = epMeta[id] || {};
    // Expand each LLM call into individual move frames
    const steps = rawSteps.flatMap(s => expandLLMStep(s));
    episodes.push({ id, seed: meta.seed ?? "?", won: meta.total_reward > 0, steps });
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
replayEpSel.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp"   || e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   stepBack();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") stepFwd();
    replayEpSel.value = String(epIndex);
  }
});
replayPrev.addEventListener("click", () => { stepBack(); replayPrev.focus(); });
replayNext.addEventListener("click", () => { stepFwd();  replayNext.focus(); });
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("replayPane").classList.contains("active")) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tag = document.activeElement?.tagName;
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
  replayEpSel.value = String(epIndex);

  const frame = ep.steps[stepIndex];
  const total = ep.steps.length;
  replayStep.textContent = `Move ${stepIndex + 1} / ${total}`;
  replayPrev.disabled = stepIndex === 0;
  replayNext.disabled = stepIndex === total - 1;

  drawGrid(frame.obs);

  // Action line
  if (frame.action) {
    replayAction.innerHTML =
      `<b>Action:</b> <code style="font-size:16px;color:${frame.isInvalid?"#e07":"#5d5"}">${frame.action}</code>` +
      (frame.isInvalid ? " <span style='color:#e07'>(invalid)</span>" : "") +
      `  <b>Reward:</b> ${frame.reward}` +
      (frame.terminated ? "  <span style='color:#5d5'>✓ WIN</span>" : "") +
      (frame.truncated  ? "  <span style='color:#e55'>✗ truncated</span>" : "");
  } else {
    replayAction.innerHTML =
      `<span style="color:var(--muted);font-size:13px">⟳ LLM deciding…</span>`;
  }

  // Reasoning
  replayThink.value = frame.reasoning || "(no reasoning)";

  // Info bar
  const obs = frame.obs || {};
  replayInfo.textContent =
    `env step: ${obs.steps_used ?? "–"}  |  steps left: ${obs.steps_remaining ?? "–"}` +
    (frame.isLLMStart ? "  |  ← new LLM call" : "");

  // Status
  if (frame.terminated) {
    replayStatus.textContent = `✓ Solved in ${obs.steps_used} env steps`;
    replayStatus.className = "status win";
  } else if (frame.truncated) {
    replayStatus.textContent = `✗ Out of steps`;
    replayStatus.className = "status fail";
  } else {
    replayStatus.textContent = `Seed ${ep.seed} — env step ${obs.steps_used ?? "?"}`;
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
