# Mountain Sokoban

A top-down Sokoban over a **two-height grid**. Every cell is terrain (low or
high), a wall, a ramp, a box, or the player. You walk square to square
(N/S/E/W), drop down a ledge anywhere for free, but climb the one height step
**only** by crossing a correctly-oriented ramp. Push ramps and boxes (boxes can
be shoved off ledges) to clear a path and reach the **goal** cell.

Full rule spec: [`mountain-sokoban-plan.md`](mountain-sokoban-plan.md).

## Cell codes

| Code | Meaning | Elevation |
|:--:|---|:--:|
| `0` | blank | low |
| `1` | blank | high |
| `2` | box on high ground | high |
| `3` | wall / void | — |
| `4`–`7` | ramp, climbs N / E / S / W | on low |
| `8` | box on low ground | low |
| `9` | player on low ground | low |
| `10` | player on high ground | high |

The goal is a separate `[row, col]` field. Rows may be ragged; anything off the
grid is treated as wall.

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
