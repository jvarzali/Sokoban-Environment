# Mountain Sokoban — Mesocosm Environment Plan

A top-down Sokoban over a **two-height grid**. Every cell is one of: blank-low,
blank-high, wall, ramp (4 locked orientations), box, or player. There is no
"underneath" — heights are terrain, like a mountain. You move square to square
(N/S/E/W); you climb the one height step only via a correctly-oriented ramp, but
you can drop down a ledge anywhere for free.

**Goal:** get the **player** to a target cell. Boxes and ramps are obstacles/tools.

---

## 1. Map encoding (the JSON file)

A map is a JSON object with a `grid` (list of rows of integers) plus a `goal`
coordinate. **Rows may be ragged** — different lengths are fine; any position off
the end of a row, or outside the grid, is treated as wall/void (impassable).

### Cell codes

| Code | Meaning | Elevation |
|:--:|---|:--:|
| `0` | blank | low (0) |
| `1` | blank | high (2) |
| `2` | box on high ground *(added — see §8)* | high (2) |
| `3` | wall / void — never passable, never standable | — |
| `4` | ramp, climbs **North** | sits on low |
| `5` | ramp, climbs **East**  | sits on low |
| `6` | ramp, climbs **South** | sits on low |
| `7` | ramp, climbs **West**  | sits on low |
| `8` | box on low ground | low (0) |
| `9` | player | (its terrain) |

Two walkable heights only: **low (0)** and **high (2)**. Ramps bridge the step.

### Why the engine splits terrain from entities
`9` (player) and `8`/`2` (box) are codes for *things standing on terrain*. A flat
integer grid loses the terrain under them once they move. So on load the engine
decodes the grid into a **static terrain layer** (low / high / wall) plus
**entity positions** (player, set of boxes, dict of ramps→orientation). The grid
you author is the input; the engine re-emits a fresh composite grid each step
(§5). Coordinates are `[row, col]`, 0-indexed.

### Example map
```json
{
  "name": "ascent-01",
  "grid": [
    [3, 3, 3, 3, 3],
    [3, 0, 1, 1, 3],
    [3, 9, 4, 0, 3],
    [3, 0, 0, 0, 3],
    [3, 3, 3, 3, 3]
  ],
  "goal": [1, 3],
  "max_steps": 60
}
```
Ramp `4` at `[2,2]` climbs North; the cell north of it `[1,2]` is high (`1`).
Solution sketch: player `[2,1]` → S `[3,1]` → E `[3,2]` → N (approach the ramp
from its downhill/south side) climbs onto `[1,2]` → E onto the goal `[1,3]`.

---

## 2. Heights & movement (player)

Let `elev(low)=0`, `elev(high)=2`. A move A → B (B adjacent, cardinal):

| Case | Condition | Allowed? |
|------|-----------|----------|
| Flat | same height | yes |
| Descend | high → low | yes, no ramp needed |
| Climb (blank) | low → high, no ramp involved | no — that's a cliff |
| Climb (ramp) | via a ramp, see §3 | yes |

The player can never stop on a wall (`3`) or on a ramp cell, and can't occupy a
cell holding a box.

---

## 3. Ramps (locked orientation)

A ramp is a **pushable object you don't stand on** (like a box), living on low
ground. Its code fixes the **uphill direction** (`4`=N, `5`=E, `6`=S, `7`=W) and
pushing never rotates it. A ramp has an *axis* (the uphill direction and its
opposite) and two *perpendicular* sides.

When the player moves into a ramp cell in direction `d`:

- **Climb** — `d` == uphill dir **and** the cell beyond is high and empty → the
  player crosses the ramp and lands on that high cell. (Approach from the
  downhill/low side, moving uphill.)
- **Descend along ramp** — `d` == downhill dir and the cell beyond is low/empty →
  player crosses down to it. (Plain descent off a ledge also works without a ramp.)
- **Push** — otherwise (perpendicular approach, or a climb/descend that doesn't
  line up): the ramp slides one cell in `d` *if* that cell is empty low ground;
  the player takes the ramp's old cell. Else the move is blocked.

```
ramp code 4 (uphill = North):

      [ high ]   <- climb lands here (must be high & empty)
        ↑
      [ ramp ]   <- you pass over it, never stop on it
        ↑
      [ low  ]   <- approach from here moving N to climb
   push it E/W by entering from the W/E side
```

Because orientation is locked and ramps only slide onto low ground, repositioning
a ramp to line up a low cell with the cliff it must reach is the core puzzle.

---

## 4. Boxes

A box is pushed when the player moves into it and the cell beyond is valid:

| Box pushed to… | Allowed? | Result |
|---|:--:|---|
| equal-height empty cell | yes | slides flat |
| **lower** empty cell (off a ledge) | **yes** | box drops to the low cell |
| higher cell | no | can't push uphill |
| wall / void / box / ramp | no | blocked |

Single-object push only (no chains). To push a box, the player must also be able
to legally occupy the box's old cell (i.e. the player isn't trying to climb a
cliff to do it). Illegal push → nothing moves, the step is flagged `invalid`.

---

## 5. State / observation

Each step the env emits the composite grid (codes from §1) plus a few scalars.
`player_elevation` disambiguates the single `9` cell (the grid can't show the
player's height); box height is already encoded by `8` vs `2`.

```json
{
  "grid": [[3,3,3,3,3], [3,0,1,1,3], [3,9,4,0,3], ...],
  "player": [2, 1],
  "player_elevation": 0,
  "goal": [1, 3],
  "steps_used": 7,
  "steps_remaining": 53
}
```

### Action space
Four text tokens: `"N" | "S" | "E" | "W"` (accept `up/down/left/right`). Anything
else → no-op step, `info.invalid = 1`.

### Reward / termination
Binary: `1.0` on the step the player reaches `goal`, else `0.0`.
`terminated = win`, `truncated = steps >= max_steps`.

---

## 6. Files (the Mesocosm package)

```
mountain-sokoban/
  env.py                # SokobanEnv: load grid, rules, re-emit grid
  adapter.py            # serve(SokobanEnv, ...)
  benchanything.json    # manifest + scoring
  requirements.txt      # just the SDK
  maps/*.json           # authored maps
```

### env.py
```python
# env.py — Mountain Sokoban
import json, glob
from src.env_sdk import BaseEnv, StepResult

DELTA     = {"N": (-1, 0), "S": (1, 0), "E": (0, 1), "W": (0, -1)}
OPP       = {"N": "S", "S": "N", "E": "W", "W": "E"}
ALIAS     = {"up": "N", "down": "S", "left": "W", "right": "E"}
RAMP_DIR  = {4: "N", 5: "E", 6: "S", 7: "W"}     # code -> uphill direction
DIR_RAMP  = {v: k for k, v in RAMP_DIR.items()}
ELEV      = {"low": 0, "high": 2}
MAPS = [json.load(open(p)) for p in sorted(glob.glob("maps/*.json"))]

class SokobanEnv(BaseEnv):
    def reset(self, seed=None, **params):
        m = MAPS[(seed or 0) % len(MAPS)]
        g = m["grid"]
        self.nrows = len(g)
        self.rowlen = [len(r) for r in g]
        self.terrain, self.ramps, self.boxes, self.player = [], {}, set(), None
        for r, row in enumerate(g):
            trow = []
            for c, v in enumerate(row):
                if   v == 3:          trow.append("wall")
                elif v in (1, 2):     trow.append("high")   # 1 blank-high, 2 box-high
                else:                 trow.append("low")     # 0,4-7,8,9 on low
                if   v in RAMP_DIR:   self.ramps[(r, c)] = RAMP_DIR[v]
                elif v in (8, 2):     self.boxes.add((r, c))
                elif v == 9:          self.player = (r, c)
            self.terrain.append(trow)
        self.goal = tuple(m["goal"])
        self.max_steps = m.get("max_steps", 100)
        self.steps = 0
        return self._obs()

    def step(self, action):
        a = ALIAS.get(action.strip().lower(), action.strip().upper())
        invalid = a not in DELTA
        if not invalid:
            invalid = not self._try_move(a)
        self.steps += 1
        won = self.player == self.goal
        return StepResult(
            observation=self._obs(),
            reward=1.0 if won else 0.0,
            terminated=won,
            truncated=self.steps >= self.max_steps and not won,
            info={"success": "1.0" if won else "0.0",
                  "steps": str(self.steps),
                  "invalid": "1.0" if invalid else "0.0"},
        )

    # --- geometry helpers ---
    def _in(self, x):  return 0 <= x[0] < self.nrows and 0 <= x[1] < self.rowlen[x[0]]
    def _terr(self, x): return self.terrain[x[0]][x[1]] if self._in(x) else "wall"
    def _occ(self, x):  return x in self.boxes or x in self.ramps
    def _step(self, x, d): return (x[0] + d[0], x[1] + d[1])

    # --- movement ---
    def _try_move(self, dir):
        d, p = DELTA[dir], self.player
        t = self._step(p, d)
        if self._terr(t) == "wall":
            return False
        if t in self.ramps:
            return self._ramp(p, t, dir, d)
        if t in self.boxes:
            return self._push_box(p, t, d)
        dh = ELEV[self._terr(t)] - ELEV[self._terr(p)]      # blank target
        if dh <= 0:                                          # flat or descend
            self.player = t; return True
        return False                                         # cliff (low->high)

    def _ramp(self, p, t, dir, d):
        up = self.ramps[t]
        b = self._step(t, d)                                 # cell beyond ramp
        if dir == up and self._terr(b) == "high" and not self._occ(b):
            self.player = b; return True                     # climb
        if dir == OPP[up] and self._terr(b) == "low" and not self._occ(b):
            self.player = b; return True                     # descend along ramp
        if self._terr(b) == "low" and not self._occ(b):      # else push the ramp
            del self.ramps[t]; self.ramps[b] = up
            self.player = t; return True
        return False

    def _push_box(self, p, t, d):
        c = self._step(t, d)                                 # box destination
        if self._terr(c) == "wall" or self._occ(c):
            return False
        if ELEV[self._terr(c)] - ELEV[self._terr(t)] > 0:    # no pushing uphill
            return False
        if ELEV[self._terr(t)] - ELEV[self._terr(p)] > 0:    # player can't climb to push
            return False
        self.boxes.discard(t); self.boxes.add(c)             # flat slide or fall-off
        self.player = t; return True

    def _obs(self):
        grid = []
        for r in range(self.nrows):
            row = []
            for c in range(self.rowlen[r]):
                cell, terr = (r, c), self.terrain[r][c]
                if   terr == "wall":      row.append(3)
                elif cell in self.ramps:  row.append(DIR_RAMP[self.ramps[cell]])
                elif cell in self.boxes:  row.append(2 if terr == "high" else 8)
                elif cell == self.player: row.append(9)
                else:                     row.append(1 if terr == "high" else 0)
            grid.append(row)
        return {"grid": grid, "player": list(self.player),
                "player_elevation": ELEV[self._terr(self.player)],
                "goal": list(self.goal),
                "steps_used": self.steps,
                "steps_remaining": self.max_steps - self.steps}
```

### adapter.py
```python
import argparse
from env import SokobanEnv
from src.env_sdk import serve

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    serve(SokobanEnv, host=a.host, port=a.port)
```

### benchanything.json
```json
{
  "adapter": "adapter.py",
  "name": "Mountain Sokoban",
  "description": "Top-down two-height maze. Push ramps (locked orientation) to climb, push boxes (incl. off ledges) to clear a path, reach the goal cell.",
  "binding_vow": {
    "version": "1.0.0",
    "observation_space": { "type": "json" },
    "action_space": { "type": "text", "description": "One of N, S, E, W (up/down/left/right aliases ok)." },
    "reward": { "type": "binary", "range": { "low": 0.0, "high": 1.0 } },
    "episode": { "max_steps": 100, "deterministic_reset": true, "supports_seed": true }
  },
  "scoring": {
    "primary_metric": "success_rate",
    "higher_is_better": true,
    "metrics": [
      { "name": "success_rate", "type": "terminal_field", "field": "success", "aggregation": "pass_rate" },
      { "name": "avg_steps",    "type": "terminal_field", "field": "steps",   "aggregation": "mean" },
      { "name": "invalid_rate", "type": "terminal_field", "field": "invalid", "aggregation": "mean" }
    ]
  }
}
```

---

## 7. Build order

1. `env.py` + one hardcoded map; unit-test: flat move, descend off ledge,
   ramp-climb (aligned), ramp-push (perpendicular), box flat-slide,
   box fall-off-ledge, blocked box-uphill, ragged-edge = wall.
2. Wire `adapter.py`; run the deck's local checklist by hand (curl health/reset/
   step/close).
3. Author 15–30 maps easy→hard; verify solvable with a BFS over state
   `(player, frozenset(boxes), frozenset(ramps.items()))` — also flags deadlocks.
4. `benchanything.json` + `requirements.txt`, push to a public repo, submit.

## 8. Gaps I filled — confirm or correct

You specified codes 0,1,3,4–7,8,9. Three things weren't covered; my choices:
- **`2` = box resting on high ground.** Needed so a box can *start* on the
  plateau to be pushed off (boxes can never climb up, so they only reach high
  ground by being authored there). `2` was your only unused value.
- **`goal` as a separate `[row,col]` field**, not a tile code — the goal cell
  still has terrain (low or high) under it, so a code would collide.
- **`player_elevation` scalar** in the observation — the lone `9` can't show
  whether the player is on low or high ground.

Also assumed: ramps are authored at the foot of a cliff (on a low cell whose
uphill neighbor is high); ramps never leave low ground. Tell me if instead you
want a third height, the goal as a tile code, or ramps that can fall off ledges.
