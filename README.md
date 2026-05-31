# Mountain Sokoban

A top-down Sokoban over a **two-height grid**. Every cell is terrain (low or
high), a wall, a ramp, a box, or the player. You walk square to square
(N/S/E/W), drop down a ledge anywhere for free, but climb the one height step
**only** by crossing a correctly-oriented ramp. Push ramps and boxes (boxes can
be shoved off ledges) — or **stand on top of a box** to cross at the higher
level — to clear a path and reach the **goal** cell.

Full rule spec: [`mountain-sokoban-plan.md`](mountain-sokoban-plan.md).

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

Reach the goal cell to win (reward `1.0`); the episode truncates at `max_steps`.

## Layout

```
env.py            # SokobanEnv: load map, rules, re-emit composite grid
adapter.py        # serves SokobanEnv over JSON/HTTP
verify_maps.py    # BFS solvability checker for maps/*.json
benchanything.json# manifest + scoring
requirements.txt  # depends only on the Mesocosm env SDK
maps/*.json       # 16 authored maps, easy -> hard, all BFS-verified solvable
src/env_sdk.py    # local stand-in for the Mesocosm SDK (swap at submission)
tests/test_env.py # engine unit tests
frontend/         # browser viewers (2D + 3D) that reuse a JS port of the engine
```

## Frontend (play / watch in the browser)

One page under `frontend/index.html` with a **2D / 3D / Split** view toggle. Both
views share `game.js` — a JS port of `env.py` verified move-for-move against it
(`node frontend/parity_test.js`). Features: arrow keys / WASD to move, undo, map
picker, **★ Solve & play** to watch the BFS solution animate, a speed slider, and
a trajectory box to replay an agent's run (paste `["S","E","N","E"]`). The 3D
view (Three.js, vendored in `frontend/vendor/`, no internet needed) orbits/zooms
and tweens the player up ramps and boxes off ledges.

**Serve it over HTTP — don't open the file directly.** The app uses ES modules,
which browsers block on `file://`:

```bash
python -m http.server 8000        # from the repo root
# then open http://localhost:8000/frontend/
```

Regenerate the bundled maps after editing `maps/` with `python frontend/build_maps.py`.

```
frontend/
  index.html      # the app (2D / 3D / Split toggle)
  game.js         # engine: JS port of env.py (also used by parity_test)
  view2d.js       # 2D grid renderer        app.js  # controller (wires it together)
  view3d.js       # 3D Three.js renderer     maps.js # bundled maps (build_maps.py)
  vendor/         # vendored three.module.js + OrbitControls.js
  parity_test.js  # node check: JS engine == Python engine
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

### HTTP protocol (local shim)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{"status":"ok"}` |
| POST | `/reset` | `{"seed": n}` | `{"observation": <obs>}` |
| POST | `/step` | `{"action":"N"}` | `{observation, reward, terminated, truncated, info}` |
| POST | `/close` | — | `{"closed": true}` |

`reset` picks a map by `seed % num_maps` (deterministic). Actions are
`N`/`S`/`E`/`W` (with `up`/`down`/`left`/`right` aliases); anything else is a
no-op flagged `info.invalid = "1.0"`. Reward is `1.0` on the step the player
reaches the goal, else `0.0`.
