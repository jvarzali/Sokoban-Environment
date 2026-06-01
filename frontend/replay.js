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

// Explicit "ACTION: X" marker — takes priority, mirroring env.py's _parse_action.
// With the text action space the agent reasons freely and ends with "ACTION: X",
// so the recorded action is a whole paragraph; the marker is the move it committed.
const ACTION_MARKER_RE = /\bACTION\s*:\s*(north|south|east|west|up|down|left|right|[nsew])\b/i;
function parseAgentAction(raw) {
  if (raw == null) return "?";
  const t = String(raw).trim();
  const m = ACTION_MARKER_RE.exec(t);
  if (m) return ALIAS_MAP[m[1].toLowerCase()] || m[1].toUpperCase();
  return parseAction(t);   // fallback: bare direction / first direction token
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

// Expand one LLM-call step into frames.
//
// Stale data: the board_after for the very first LLM call of each episode is
// always from a different episode (platform export artifact). board_before at
// step 1 is always correct (steps_used=0 = initial episode state). We detect
// the mismatch by comparing goals/grid-dimensions. When they disagree we
// simulate the action locally from board_before instead of trusting board_after.
//
// Multi-step calls: with action_space.type="text" the platform executes every
// direction token it finds in a verbose LLM response (4–18 steps per call).
// We detect this (afterObs.steps_used − baseObs.steps_used > 1) and re-simulate
// each step with the local JS engine so the viewer shows every move.
function expandLLMStep(llmStep) {
  const baseObs  = getObs(llmStep.board_before);   // always correct (steps_used=0)
  const afterObs = llmStep.board_after;             // may be stale at step 1
  const reasoning = llmStep.reasoning || llmStep.action || "";

  // Decide whether board_before and board_after are from the same map.
  const bg = baseObs?.goal, ag = afterObs?.goal;
  const sameMap = !!(
    baseObs?.grid && afterObs?.grid &&
    bg && ag &&
    bg[0] === ag[0] && bg[1] === ag[1] &&
    baseObs.grid.length === afterObs.grid.length
  );

  const frames = [];

  // When board_after is stale (different map), use board_before as the source
  // of truth and simulate the action locally — never show the wrong map.
  if (!sameMap) {
    if (!baseObs?.grid) return frames;
    // Thinking frame: correct initial episode state.
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
    // Simulate the action on the local engine so we show the result move.
    const parsedAct = parseAction(llmStep.action || "");
    if ("NSEW".includes(parsedAct)) {
      const maxSteps = (baseObs.steps_used || 0) + (baseObs.steps_remaining || 100);
      const game = new Sokoban({
        name: "replay", grid: baseObs.grid, goal: baseObs.goal, max_steps: maxSteps,
      });
      const valid = game.move(parsedAct);
      frames.push({
        obs: obsFromGame(game, baseObs),
        action: parsedAct,
        reasoning,
        isLLMStart: false,
        isInvalid: !valid,
        terminated: llmStep.terminated || false,
        truncated:  llmStep.truncated  || false,
        reward:     llmStep.reward     || 0,
      });
    }
    return frames;
  }

  // Same map: emit the thinking frame.
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

  // Detect multi-step: platform executed more than 1 env step from this LLM call.
  const beforeSteps = baseObs?.steps_used ?? 0;
  const afterSteps  = afterObs?.steps_used;
  const numSteps    = (afterSteps != null && afterSteps > beforeSteps)
    ? afterSteps - beforeSteps : 1;

  if (numSteps > 1) {
    // Re-simulate each intermediate step with the local game engine.
    // We extract direction tokens from the LLM reasoning in order — the same
    // tokens the platform parsed — and replay the first numSteps of them.
    const allActions = extractAllActions(reasoning);
    const actions    = allActions.slice(0, numSteps);   // platform uses first N tokens

    const maxSteps = beforeSteps + (baseObs.steps_remaining || 100);
    const game = new Sokoban({
      name: "replay",
      grid: baseObs.grid,
      goal: baseObs.goal,
      max_steps: maxSteps,
    });

    for (let i = 0; i < actions.length; i++) {
      const act    = actions[i];
      const valid  = game.move(act);
      const isLast = i === actions.length - 1;
      const obs    = obsFromGame(game, baseObs);
      frames.push({
        obs,
        action: act,
        reasoning: isLast ? reasoning : null,
        isLLMStart: false,
        isInvalid: !valid,
        terminated: isLast ? (llmStep.terminated || false) : false,
        truncated:  isLast ? (llmStep.truncated  || false) : false,
        reward:     isLast ? (llmStep.reward      || 0)    : 0,
      });
    }

    // If the reasoning had fewer tokens than numSteps, show board_after as the
    // authoritative final state so we never silently drop env steps.
    if (actions.length < numSteps && afterObs?.grid) {
      const parsedAction = parseAction(llmStep.action || "");
      frames.push({
        obs: afterObs,
        action: "NSEW".includes(parsedAction) ? parsedAction : null,
        reasoning,
        isLLMStart: false,
        isInvalid: llmStep.info?.invalid === "1.0",
        terminated: llmStep.terminated || false,
        truncated:  llmStep.truncated  || false,
        reward:     llmStep.reward     || 0,
      });
    }
    return frames;
  }

  // Single env-step: show board_after as the result frame.
  if (afterObs?.grid) {
    const parsedAction = parseAction(llmStep.action || "");
    const isInvalid = llmStep.info?.invalid === "1.0";
    frames.push({
      obs: afterObs,
      action: "NSEW".includes(parsedAction) ? parsedAction : null,
      reasoning,
      isLLMStart: false,
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

let playMode    = null;     // "single" (this level) | "all" (every level)
let shownEndKey = null;     // guards one popup per arrival at a level's final frame
let resultTimer = null;
const RESULT_MS = 2600;     // how long the end-of-level popup stays up

function replayInterval() { return 600 / replaySpeed; }

function startPlay(modeName) {
  if (!episodes.length) return;
  playMode = modeName;
  replayPlaying = true;
  updatePlayButtons();
  const ep = episodes[epIndex];
  if (ep && stepIndex >= ep.steps.length - 1) { stepIndex = 0; renderReplay(); }   // restart if at end
  tickPlay();
}

function stopPlay() {
  replayPlaying = false;
  playMode = null;
  clearTimeout(replayTimer);
  updatePlayButtons();
}

function updatePlayButtons() {
  replayPlayBtn.textContent = (replayPlaying && playMode === "single") ? "⏸ Pause" : "▶ Play";
  replayAutoBtn.textContent = (replayPlaying && playMode === "all")    ? "⏸ Pause" : "⏭ Auto-play";
}

function tickPlay() {
  clearTimeout(replayTimer);
  if (!replayPlaying) return;
  const ep = episodes[epIndex];
  if (!ep) { stopPlay(); return; }
  if (stepIndex >= ep.steps.length - 1) { onEnd(); return; }   // already at the final frame
  stepFwd();                                                    // render next frame (may pop/confetti)
  const cur = ep.steps[stepIndex];
  if (stepIndex >= ep.steps.length - 1 || (cur && (cur.terminated || cur.truncated))) {
    onEnd();
  } else {
    replayTimer = setTimeout(tickPlay, replayInterval());
  }
}

// End of an episode during playback. The win/fail popup + confetti were already
// shown by renderReplay; decide what happens next.
function onEnd() {
  clearTimeout(replayTimer);
  if (playMode === "all") {
    replayTimer = setTimeout(() => {
      if (!replayPlaying) return;
      if (epIndex < episodes.length - 1) {
        epIndex++; stepIndex = 0; renderReplay();
        tickPlay();                  // roll into the next level
      } else {
        stopPlay();                  // finished the last level
      }
    }, RESULT_MS + 250);
  } else {
    stopPlay();                      // single level: stop, leave the popup up
  }
}

function gotoLevel(delta) {
  stopPlay();
  if (!episodes.length) return;
  epIndex = Math.max(0, Math.min(episodes.length - 1, epIndex + delta));
  stepIndex = 0;
  renderReplay();
}

// ── end-of-level popup + confetti ────────────────────────────────────────────
function maybeCelebrate(ep) {
  const key = `${epIndex}`;
  if (key === shownEndKey) return;          // already shown for this level's end
  shownEndKey = key;
  if (ep.won && window.appCelebrate) window.appCelebrate();
  showResult(ep.won);
}
function showResult(won) {
  if (!resultPopup) return;
  resultPopup.textContent = won ? "🎉 Level completed!" : "✗ Level failed";
  resultPopup.className = won ? "show win" : "show fail";
  clearTimeout(resultTimer);
  resultTimer = setTimeout(hideResult, RESULT_MS);
}
function hideResult() { if (resultPopup) resultPopup.className = ""; }

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
const replayAutoBtn = document.getElementById("replayAutoBtn");
const replayLevelPrev = document.getElementById("replayLevelPrev");
const replayLevelNext = document.getElementById("replayLevelNext");
const resultPopup   = document.getElementById("resultPopup");

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

// Build frames from raw trace events, simulating every action on the correct
// initial map. Traces give per-env-step resolution (all actions present, even
// when one LLM call produced multiple direction tokens). The board_before/
// board_after observations in traces are contaminated when the platform runs
// episodes concurrently on a shared env, so we ignore them for rendering and
// drive the visuals entirely from the local JS engine on the correct initial map.
function buildEpisodeFramesFromTraces(traceEvents) {
  const sorted = [...traceEvents].sort((a, b) =>
    a.step !== b.step ? a.step - b.step : (a.timestamp < b.timestamp ? -1 : 1));

  // Initial board state comes from the phase:"start" observation (always correct).
  const startEvt = sorted.find(e =>
    e.event_type === "observation" && e.payload?.phase === "start");
  const initObs = startEvt?.payload?.data?.observation || startEvt?.payload?.data;
  if (!initObs?.grid) return null;

  // Collect the ordered action sequence and per-step result metadata.
  const byStep = {};
  for (const e of sorted) {
    if (!byStep[e.step]) byStep[e.step] = {};
    if (e.event_type === "action")
      byStep[e.step].action = e.payload?.action;
    if (e.event_type === "step_result")
      byStep[e.step].result = e.payload;
  }
  const stepNums = Object.keys(byStep).map(Number).sort((a, b) => a - b).filter(s => s >= 1);

  const maxSteps = (initObs.steps_used || 0) + (initObs.steps_remaining || 100);
  const game = new Sokoban({ name: "replay", grid: initObs.grid, goal: initObs.goal, max_steps: maxSteps });

  const frames = [];
  for (const stepNum of stepNums) {
    const { action: rawAction, result = {} } = byStep[stepNum];
    if (!rawAction) continue;

    // The recorded action is the agent's full response; parse out the committed
    // move (ACTION: marker first) the same way env.py does. For old discrete runs
    // this is already a bare "W" and parses through unchanged.
    const act = parseAgentAction(rawAction);
    const reasoning = String(rawAction).trim();

    // Thinking frame before this move (shows the reasoning that produced it).
    frames.push({
      obs:        obsFromGame(game, initObs),
      action:     null,
      reasoning,
      isLLMStart: true,
      isInvalid:  false,
      terminated: false,
      truncated:  false,
      reward:     0,
    });

    if (game.won) break;

    const valid = game.move(act);

    frames.push({
      obs:        obsFromGame(game, initObs),
      action:     act,
      reasoning,
      isLLMStart: false,
      isInvalid:  !valid,
      terminated: game.won,
      truncated:  !game.won ? (result.truncated || false) : false,
      reward:     game.won ? 1.0 : 0,
    });

    if (game.won) break;
  }

  return frames.length ? frames : null;
}

// Build all frames for one episode by anchoring to the initial board state
// and simulating every action locally — never trusting exported board_before /
// board_after data after step 1, which is often from a different episode.
function buildEpisodeFrames(rawSteps) {
  if (!rawSteps.length) return [];

  // The initial board state is always in step 1's board_before at steps_used=0.
  const initObs = getObs(rawSteps[0].board_before);
  if (!initObs?.grid) return rawSteps.flatMap(s => expandLLMStep(s));

  const maxSteps = (initObs.steps_used || 0) + (initObs.steps_remaining || 100);
  const game = new Sokoban({
    name: "replay",
    grid: initObs.grid,
    goal: initObs.goal,
    max_steps: maxSteps,
  });

  const frames = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const llmStep  = rawSteps[i];
    const reasoning = llmStep.reasoning || llmStep.action || "";
    const isLastCall = i === rawSteps.length - 1;

    // Thinking frame — board state before this LLM call's actions.
    frames.push({
      obs: obsFromGame(game, initObs),
      action: null,
      reasoning,
      isLLMStart: true,
      isInvalid: false,
      terminated: false,
      truncated: false,
      reward: 0,
    });

    if (game.won) break;

    // Extract actions: for single-char responses (discrete mode) this is one
    // token; for verbose text responses it may be many direction tokens.
    const allActions = extractAllActions(reasoning);
    const actionsToRun = allActions.length > 0
      ? allActions
      : (() => { const p = parseAction(reasoning); return "NSEW".includes(p) ? [p] : []; })();

    for (let j = 0; j < actionsToRun.length; j++) {
      const act    = actionsToRun[j];
      const valid  = game.move(act);
      const isLastAction = j === actionsToRun.length - 1;

      frames.push({
        obs: obsFromGame(game, initObs),
        action: act,
        reasoning: isLastAction ? reasoning : null,
        isLLMStart: false,
        isInvalid: !valid,
        terminated: game.won,
        truncated:  isLastAction && isLastCall && !game.won ? (llmStep.truncated || false) : false,
        reward:     game.won ? 1.0 : 0,
      });

      if (game.won) break;
    }

    if (game.won) break;
  }

  return frames;
}

function buildEpisodes() {
  const epMeta = {};
  for (const ep of (replayData.episodes || [])) {
    epMeta[ep.id] = ep;
  }
  episodes = [];
  const tracesMap = replayData.traces || {};
  for (const [id, rawSteps] of Object.entries(replayData.replay || {})) {
    const meta  = epMeta[id] || {};
    // Prefer traces (per-env-step resolution) over replay (per-LLM-call).
    // Fall back to buildEpisodeFrames when traces are absent or yield nothing.
    const steps = (tracesMap[id] && buildEpisodeFramesFromTraces(tracesMap[id]))
               || buildEpisodeFrames(rawSteps);
    // Trust the local simulation over platform metadata — platform scores can
    // be wrong when concurrent episodes share a single env instance.
    const wonLocally = steps.some(f => f.terminated);
    const wonPlatform = meta.terminal_info?.success === "1.0" || meta.total_reward >= 1.0;
    const won = wonLocally || wonPlatform;
    episodes.push({ id, seed: meta.seed ?? "?", won, steps });
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
  stopPlay();
  epIndex = Number(e.target.value);
  stepIndex = 0;
  renderReplay();
});
replayEpSel.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp"   || e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    stopPlay();
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   stepBack();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") stepFwd();
    replayEpSel.value = String(epIndex);
  }
});
replayPrev.addEventListener("click", () => { stopPlay(); stepBack(); replayPrev.focus(); });
replayNext.addEventListener("click", () => { stopPlay(); stepFwd();  replayNext.focus(); });
replayLevelPrev.addEventListener("click", () => gotoLevel(-1));
replayLevelNext.addEventListener("click", () => gotoLevel(1));
// Play = run THIS level from file; Auto-play = run through every level one by one
replayPlayBtn.addEventListener("click", () => {
  if (replayPlaying && playMode === "single") { stopPlay(); return; }
  startPlay("single");
});
replayAutoBtn.addEventListener("click", () => {
  if (replayPlaying && playMode === "all") { stopPlay(); return; }
  startPlay("all");
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
  stopPlay();
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

  // Invalid move: the player tried to go `frame.action` but it was blocked.
  // The board didn't change, so play the red lunge/bounce toward the blocked
  // cell after the rebuild (the rebuild recreates the player, so bump must run
  // after appRenderFrame). Only on the result frame, not the thinking frame.
  if (frame.isInvalid && !frame.isLLMStart && "NSEW".includes(frame.action) && window.appBump) {
    requestAnimationFrame(() => window.appBump(frame.action));
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

  // End-of-level popup + confetti (once per arrival at the final frame)
  if (stepIndex === total - 1) {
    maybeCelebrate(ep);
  } else {
    shownEndKey = null;
    hideResult();
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
