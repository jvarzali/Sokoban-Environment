# Sokoban

A top-down Sokoban over a **two-height grid**. Every cell is terrain (low or
high), a wall, a ramp, a box, or the player. You walk square to square
(N/S/E/W), drop down a ledge anywhere for free, but climb the one height step
**only** by crossing a correctly-oriented ramp. Push ramps and boxes (boxes can
be shoved off ledges) — or **stand on top of a box** to cross at the higher
level — to clear a path and reach the **goal** cell.

Live website: https://jvarzali.github.io/Sokoban-Environment/

Video demo: In progress

## Cell codes

| Code | Meaning | Elevation |
|:--:|---|:--:|
| `0` | blank | low |
| `1` | blank | high |
| `2` | box on high ground | high (box top: +1 step) |
| `3` | wall / void | — |
| `4`–`7` | ramp, climbs N / E / S / W | on low |
| `8` | box on low ground | low (box top: +1 step) |
| `9` | player on low ground | low |
| `10` | player on high ground | high |
| `11` | player standing on a box (box on low ground) | box top |
| `12` | player standing on a box (box on high ground) | box top |

The goal is a separate `[row, col]` field. Rows may be ragged; anything off the
grid is treated as wall.

## Rules

Heights are `low = 0`, `high = 2`, and a **box is one step (2) tall** — its top
surface sits one level above the terrain it rests on. Your **standing height**
is the terrain elevation plus 2 if you're on a box, so `player_elevation` in the
observation is `0`, `2`, or `4`.

A move into an adjacent cell:

- **Blank cell** — allowed if its surface is at or below your standing height
  (flat, or a free drop down a ledge). One step **up** is a cliff and is blocked
  unless a ramp bridges it.
- **Ramp** — climb it when you enter from the downhill side moving uphill and the
  high cell beyond is empty; descend along it the other way; otherwise it gets
  pushed one cell (only onto empty low ground), and you take its old square.
- **Box** — depends on your standing height vs. the box:
  - at/above the box **top** → you **step onto the box** (you can then walk
    across box tops and step off onto level/lower ground);
  - level with the box **base** → you **push** it (single push; onto equal or
    lower empty ground, including off a ledge; never uphill, never into another
    box/ramp/wall);
  - below the box base → blocked. **You can never climb up onto a box from
    below** — ramps remain the only way to gain height.

Reach the goal cell to win; the episode truncates at `max_steps`. The win reward is
**proportional to efficiency** — `optimal_steps / steps` (capped at `1.0`), so an
optimal solve scores `1.0`, twice the optimal number of moves scores `0.5`, and so on.

## Layout

```
env.py            # SokobanEnv: load map, rules, re-emit composite grid
adapter.py        # serves SokobanEnv over JSON/HTTP
verify_maps.py    # BFS solvability checker for maps/*.json
benchanything.json# manifest + scoring
requirements.txt  # depends only on the Mesocosm env SDK
maps/*.json       # 15 authored maps, easy -> hard, all BFS-verified solvable
src/env_sdk.py    # local stand-in for the Mesocosm SDK (swap at submission)
tests/test_env.py # engine unit tests
docs/         # browser viewers (2D + 3D) that reuse a JS port of the engine
```

## Frontend (watch agent runs in the browser)

One page under `docs/index.html` is a **replay viewer** with a **2D / 3D /
Split** toggle. Load a `mesocosm run export` JSON (file picker — exports live in
`docs/runs/`) and watch the agent play each episode back, one env step at a
time. It re-simulates every move with `game.js` — a JS port of `env.py` verified
move-for-move against it (`node docs/parity_test.js`) — so the visuals are
driven by the trusted engine rather than the (sometimes contaminated) exported
boards.

Controls: an episode/seed picker, ◀ / ▶ per-move stepping (or the <kbd>←</kbd>
<kbd>→</kbd> keys), **▶ Play** for one level and **⏭ Auto-play** through every
level, and a speed slider. Each step shows the agent's **reasoning** for that move
(it ends with `ACTION: X`, and the reward shown is the efficiency value the move
earned), and an **invalid move flashes the ball red and bounces it** off the blocked
cell. Wins pop a banner with confetti. The 3D view (Three.js, vendored in
`docs/vendor/`, no internet needed) orbits/zooms and tweens the player up ramps
and boxes off ledges.

The layout is **resizable**: drag the handle above the bottom panel to grow/shrink
it (the reasoning box grows with it), and in **Split** mode drag the divider between
the 2D and 3D views. Both are clamped so neither side can get too small.

**Serve it over HTTP — don't open the file directly.** The app uses ES modules,
which browsers block on `file://`:

```bash
python -m http.server 8000        # from the repo root
# then open http://localhost:8000/docs/  and load a file from docs/runs/
```

Regenerate the bundled maps after editing `maps/` with `python docs/build_maps.py`.

```
docs/
  index.html      # the replay viewer (2D / 3D / Split toggle)
  app.js          # view controller: owns the 2D + 3D renderers, view toggle
  replay.js       # loads run-export JSON, builds per-move frames, drives playback
  resize.js       # drag-to-resize the bottom pane and the 2D|3D split divider
  game.js         # engine: JS port of env.py (also used by parity_test)
  view2d.js       # 2D grid renderer         view3d.js # 3D Three.js renderer
  maps.js         # bundled maps             build_maps.py # regenerates maps.js
  vendor/         # vendored three.module.js + OrbitControls.js
  parity_test.js  # node check: JS engine == Python engine
  runs/           # exported run JSONs to load in the viewer
```

`src/env_sdk.py` is a minimal local shim so the package runs and tests pass
without the framework installed. Replace it with the real Mesocosm SDK at
submission time — `env.py` and `adapter.py` need no changes.

## Run

```bash
# unit tests (engine rules)
python -m unittest tests.test_env -v

# verify every map is solvable within its step cap
python verify_maps.py

# serve the environment
python adapter.py --host 127.0.0.1 --port 8765
```

### Mesocosm benchmark runs

The action space is `text` (vow `2.1.0`): the agent writes its reasoning, then
ends with `ACTION: X` (`env.py` parses the marker). This avoids the platform's
forced structured-output path, which suppresses chain-of-thought on discrete
action spaces. The reward is `scalar`, proportional to efficiency (see Rules).

```bash
# validate the manifest against platform policy
mesocosm validate benchanything.json

# local test run (Ollama, no API) — seeds are space-separated integers
mesocosm run local --manifest benchanything.json \
  --model ollama/<model> --episodes 15 --seeds 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14

# publish/update the env on the platform (pulls the pushed repo)
mesocosm env submit --name Sokoban --github-url <repo-url>

# platform run — vow 2.1.0, pass system_prompt so the agent knows the game rules
mesocosm run create --domain <id> --vow-version 2.1.0 --model <model> \
  --episodes 15 \
  --system-prompt "$(cat system_prompt.txt)"
```

### HTTP protocol (local shim)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{"status":"ok"}` |
| POST | `/reset` | `{"seed": n}` | `{"observation": <obs>}` |
| POST | `/step` | `{"action":"N"}` | `{observation, reward, terminated, truncated, info}` |
| POST | `/close` | — | `{"closed": true}` |

`reset` picks a map by `seed % num_maps` (deterministic). Actions are
`N`/`S`/`E`/`W` (with `up`/`down`/`left`/`right` aliases); anything else is a
no-op flagged `info.invalid = "1.0"`. Reward is `0.0` until the player reaches the
goal, then `optimal_steps / steps` (capped at `1.0`) — i.e. proportional to how
efficiently the level was solved.
