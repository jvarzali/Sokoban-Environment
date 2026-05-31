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
      } else if (game.player[0] === r && game.player[1] === c) {
        // Player wins; encode 11/12 if also standing on a box
        row.push(game.boxes.has(k) ? (t === "high" ? 12 : 11) : (t === "high" ? 10 : 9));
      } else if (game.boxes.has(k)) {
        row.push(t === "high" ? 2 : 8);
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

// Expand one LLM-call step into frames using the actual board_before / board_after
// observations from the export — no re-execution from verbose reasoning text.
//
// The board_before for the very first LLM call of an episode is often stale
// (it carries the final state of the *previous* episode). We detect this by
// comparing goals and grid dimensions; if they disagree we skip that frame so
// the viewer never shows the wrong map.
function expandLLMStep(llmStep) {
  const baseObs  = getObs(llmStep.board_before);   // may be null / stale
  const afterObs = llmStep.board_after;             // flat obs from the export
  const reasoning = llmStep.reasoning || llmStep.action || "";

  // Decide whether board_before is from the same map as board_after.
  const bg = baseObs?.goal, ag = afterObs?.goal;
  const sameMap = !!(
    baseObs?.grid && afterObs?.grid &&
    bg && ag &&
    bg[0] === ag[0] && bg[1] === ag[1] &&
    baseObs.grid.length === afterObs.grid.length
  );

  const frames = [];

  // Thinking frame — only emit when board_before is from the correct map.
  if (sameMap) {
    frames.push({
      obs: baseObs,
      action: null,
      reasoning,
      isLLMStart: true,
      isInvalid: false,
      terminated: false,
      truncated: false,
      reward: 0,
    });
  }

  // Result frame — the actual state after the env processed this LLM call.
  if (afterObs?.grid) {
    const parsedAction = parseAction(llmStep.action || "");
    const isInvalid = llmStep.info?.invalid === "1.0";
    frames.push({
      obs: afterObs,
      action: "NSEW".includes(parsedAction) ? parsedAction : null,
      reasoning,
      isLLMStart: !sameMap,   // mark as new-call start when we skipped thinking frame
      isInvalid,
      terminated: llmStep.terminated || false,
      truncated:  llmStep.truncated  || false,
      reward:     llmStep.reward     || 0,
    });
  } else if (baseObs?.grid) {
    // No board_after at all — fall back to showing board_before only.
    frames.push({
      obs: baseObs,
      action: null,
      reasoning,
      isLLMStart: true,
      isInvalid: false,
      terminated: llmStep.terminated || false,
      truncated:  llmStep.truncated  || false,
      reward:     llmStep.reward     || 0,
    });
  }

  return frames;
}

// ── state ──────────────────────────────────────────────────────────────────
let replayData   = null;
let episodes     = [];     // [{id, seed, won, steps:[frame…]}]
let epIndex      = 0;
let stepIndex    = 0;

// ── auto-play state ────────────────────────────────────────────────────────
let replayPlaying = false;
let replayTimer   = null;
let replaySpeed   = 2;

function replayInterval() { return 600 / replaySpeed; }

function startAutoPlay() {
  replayPlaying = true;
  replayPlayBtn.textContent = "⏸ Pause replay";
  tickAutoPlay();
}

function stopAutoPlay() {
  replayPlaying = false;
  clearTimeout(replayTimer);
  replayPlayBtn.textContent = "▶ Auto-play";
}

function tickAutoPlay() {
  clearTimeout(replayTimer);
  if (!replayPlaying) return;
  const ep = episodes[epIndex];
  if (!ep || stepIndex >= ep.steps.length - 1) { stopAutoPlay(); return; }
  // Stop if the current frame already signals episode end.
  const cur = ep.steps[stepIndex];
  if (cur && (cur.terminated || cur.truncated)) { stopAutoPlay(); return; }
  stepFwd();
  replayTimer = setTimeout(tickAutoPlay, replayInterval());
}

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
const replayPlayBtn = document.getElementById("replayPlayBtn");

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
  stopAutoPlay();
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
replayPrev.addEventListener("click", () => { stopAutoPlay(); stepBack(); replayPrev.focus(); });
replayNext.addEventListener("click", () => { stopAutoPlay(); stepFwd();  replayNext.focus(); });
replayPlayBtn.addEventListener("click", () => {
  if (!episodes.length) return;
  if (replayPlaying) { stopAutoPlay(); return; }
  // If at the end of an episode, restart from the beginning
  const ep = episodes[epIndex];
  if (ep && stepIndex >= ep.steps.length - 1) { stepIndex = 0; renderReplay(); }
  startAutoPlay();
});
document.getElementById("replaySpeed").addEventListener("input", (e) => {
  replaySpeed = Number(e.target.value);
  document.getElementById("replaySpeedVal").textContent = `${replaySpeed}x`;
});
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

  // Render in the main 2D/3D viewer
  const obs = frame.obs || {};
  if (!window.appRenderFrame) {
    replayStatus.textContent = "Viewer not ready — reload the page.";
    replayStatus.className = "status fail";
    return;
  }
  if (!obs.grid) {
    replayStatus.textContent = "No grid data for this frame.";
    replayStatus.className = "status fail";
    return;
  }
  const maxSteps = (obs.steps_used || 0) + (obs.steps_remaining || 100);
  const tempGame = new Sokoban({
    name: `Replay seed ${ep.seed}`,
    grid: obs.grid,
    goal: obs.goal,
    max_steps: maxSteps,
  });
  if (!tempGame.player) {
    replayStatus.textContent = "No player found in frame grid.";
    replayStatus.className = "status fail";
    return;
  }
  let hudMsg, hudCls = "hud";
  if (frame.terminated) {
    hudMsg = `✔ Replay: seed ${ep.seed} solved in ${obs.steps_used} steps`;
    hudCls = "hud win";
  } else if (frame.truncated) {
    hudMsg = `✗ Replay: seed ${ep.seed} — out of steps`;
    hudCls = "hud fail";
  } else {
    hudMsg = `Replay: seed ${ep.seed} — step ${obs.steps_used ?? "?"}/${maxSteps}`;
  }
  try {
    window.appRenderFrame(tempGame, hudMsg, hudCls);
  } catch (e) {
    console.error("appRenderFrame error:", e);
    replayStatus.textContent = `Render error: ${e.message}`;
    replayStatus.className = "status fail";
    return;
  }

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
