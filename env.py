# env.py - Sokoban
#
# A top-down Sokoban over a two-height grid. Terrain is low (0) or high (2);
# walls are impassable. The player walks flat, drops down ledges for free, and
# climbs the one height step only by crossing a correctly-oriented ramp. Boxes
# and ramps are single-push obstacles/tools. Reach the goal cell to win.
#
# See sokoban-plan.md for the full rule spec.
import json
import glob
import os
import re

from src.env_sdk import BaseEnv, StepResult

DELTA    = {"N": (-1, 0), "S": (1, 0), "E": (0, 1), "W": (0, -1)}
OPP      = {"N": "S", "S": "N", "E": "W", "W": "E"}
ALIAS    = {"up": "N", "down": "S", "left": "W", "right": "E",
            "north": "N", "south": "S", "east": "E", "west": "W"}
RAMP_DIR = {4: "N", 5: "E", 6: "S", 7: "W"}      # code -> uphill direction
DIR_RAMP = {v: k for k, v in RAMP_DIR.items()}
ELEV     = {"low": 0, "high": 2}

_MAPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "maps")


def load_maps():
    """Load every authored map, sorted by filename, for deterministic seeding."""
    maps = []
    for path in sorted(glob.glob(os.path.join(_MAPS_DIR, "*.json"))):
        with open(path, encoding="utf-8") as fh:
            maps.append(json.load(fh))
    return maps


MAPS = load_maps()


_ACTION_RE = re.compile(
    r'\b(north|south|east|west|up|down|left|right|[nsew])\b', re.IGNORECASE
)


def _parse_action(raw: str) -> str:
    """Extract the first direction token from a free-form agent response."""
    token = raw.strip()
    # Fast path: exact single token
    direct = ALIAS.get(token.lower(), token.upper())
    if direct in DELTA:
        return direct
    # Scan for the first direction word in a verbose response
    m = _ACTION_RE.search(token)
    if m:
        return ALIAS.get(m.group().lower(), m.group().upper())
    return token.upper()  # will be flagged invalid


class SokobanEnv(BaseEnv):
    def reset(self, seed=None, **params):
        # Tests / tools may inject a map dict directly; otherwise pick by seed.
        m = params.get("map")
        if m is None:
            if not MAPS:
                raise RuntimeError("no maps found in maps/*.json")
            m = MAPS[(seed or 0) % len(MAPS)]
        g = m["grid"]
        self.nrows = len(g)
        self.rowlen = [len(r) for r in g]
        self.terrain, self.ramps, self.boxes, self.player = [], {}, set(), None
        for r, row in enumerate(g):
            trow = []
            for c, v in enumerate(row):
                if   v == 3:        trow.append("wall")
                elif v in (1, 2):   trow.append("high")   # 1 blank-high, 2 box-high
                else:               trow.append("low")     # 0,4-7,8,9 on low
                if   v in RAMP_DIR: self.ramps[(r, c)] = RAMP_DIR[v]
                elif v in (8, 2):   self.boxes.add((r, c))
                elif v == 9:        self.player = (r, c)
            self.terrain.append(trow)
        if self.player is None:
            raise ValueError("map has no player (code 9)")
        self.goal = tuple(m["goal"])
        self.max_steps = m.get("max_steps", 100)
        self.optimal_steps = m.get("optimal_steps", None)
        self.steps = 0
        return self._obs()

    def step(self, action):
        a = _parse_action(action)
        invalid = a not in DELTA
        if not invalid:
            invalid = not self._try_move(a)
        self.steps += 1
        won = self.player == self.goal
        reward = 1.0 if won else 0.0
        efficiency = round(self.optimal_steps / self.steps, 4) if (won and self.optimal_steps) else 0.0
        return StepResult(
            observation=self._obs(),
            reward=reward,
            terminated=won,
            truncated=self.steps >= self.max_steps and not won,
            info={"success": "1.0" if won else "0.0",
                  "steps": str(self.steps),
                  "invalid": "1.0" if invalid else "0.0",
                  "optimal_steps": str(self.optimal_steps) if self.optimal_steps else "",
                  "efficiency": str(efficiency)},
        )

    # --- geometry helpers ---
    def _in(self, x):   return 0 <= x[0] < self.nrows and 0 <= x[1] < self.rowlen[x[0]]
    def _terr(self, x): return self.terrain[x[0]][x[1]] if self._in(x) else "wall"
    def _occ(self, x):  return x in self.boxes or x in self.ramps
    def _step(self, x, d): return (x[0] + d[0], x[1] + d[1])

    def _stand(self, x):
        """Elevation of the standable surface at x (terrain, +2 if a box sits
        there since a box is one step tall). None for walls."""
        terr = self._terr(x)
        if terr == "wall":
            return None
        return ELEV[terr] + (2 if x in self.boxes else 0)

    # --- movement ---
    def _try_move(self, direction):
        d, p = DELTA[direction], self.player
        t = self._step(p, d)
        if self._terr(t) == "wall":
            return False
        h = self._stand(p)                                   # player's current surface
        if t in self.ramps:
            return self._ramp(p, t, direction, d)
        if t in self.boxes:
            return self._enter_box(p, t, d, h)
        if ELEV[self._terr(t)] <= h:                         # blank target: flat or descend
            self.player = t
            return True
        return False                                         # cliff (need a ramp)

    def _ramp(self, p, t, direction, d):
        up = self.ramps[t]
        b = self._step(t, d)                                 # cell beyond ramp
        if direction == up and self._terr(b) == "high" and not self._occ(b):
            self.player = b
            return True                                      # climb
        if direction == OPP[up] and self._terr(b) == "low" and not self._occ(b):
            self.player = b
            return True                                      # descend along ramp
        if self._terr(b) == "low" and not self._occ(b):      # else push the ramp
            del self.ramps[t]
            self.ramps[b] = up
            self.player = t
            return True
        return False

    def _enter_box(self, p, t, d, h):
        """Move onto a box's cell. A box top sits one step above its terrain;
        you step onto it from a surface at/above that top, but from the box's
        base level you push it instead. You can never climb up onto a box."""
        box_base = ELEV[self._terr(t)]
        if h >= box_base + 2:                                # step onto the box top
            self.player = t
            return True
        if h == box_base:                                    # level with its base -> push
            return self._push_box(p, t, d, h)
        return False                                         # box base is up a cliff

    def _push_box(self, p, t, d, h):
        c = self._step(t, d)                                 # box destination
        if self._terr(c) == "wall" or self._occ(c):
            return False
        if ELEV[self._terr(c)] - ELEV[self._terr(t)] > 0:    # no pushing uphill
            return False
        if ELEV[self._terr(t)] - h > 0:                      # player can't climb to push
            return False
        self.boxes.discard(t)
        self.boxes.add(c)                                    # flat slide or fall-off
        self.player = t
        return True

    def _obs(self):
        grid = []
        for r in range(self.nrows):
            row = []
            for c in range(self.rowlen[r]):
                cell, terr = (r, c), self.terrain[r][c]
                if   terr == "wall":      row.append(3)
                elif cell in self.ramps:  row.append(DIR_RAMP[self.ramps[cell]])
                elif cell == self.player:                    # player wins over a box it stands on
                    if cell in self.boxes:   row.append(11 if terr == "low" else 12)
                    else:                    row.append(10 if terr == "high" else 9)
                elif cell in self.boxes:  row.append(2 if terr == "high" else 8)
                else:                     row.append(1 if terr == "high" else 0)
            grid.append(row)
        # Build ASCII map.
        # Symbols: # wall  . low ground  H high ground
        #  @ player(low)  P player(high)  Q player-on-box
        #  G goal(low — walk to it)  * goal(high — need ramp to reach)
        #  b box(low)  B box(high)
        #  ^ ramp climbs N  > ramp climbs E  v ramp climbs S  < ramp climbs W
        _SYM = {0:'.', 1:'H', 2:'B', 3:'#', 4:'^', 5:'>', 6:'v', 7:'<',
                8:'b', 9:'@', 10:'P', 11:'Q', 12:'Q'}
        gr, gc = self.goal
        goal_on_high = self.terrain[gr][gc] == "high"
        goal_ch = '*' if goal_on_high else 'G'
        ascii_rows = []
        for r, row in enumerate(grid):
            line = ""
            for c, v in enumerate(row):
                if r == gr and c == gc and v not in (9, 10, 11, 12):
                    line += goal_ch
                else:
                    line += _SYM.get(v, "?")
            ascii_rows.append(line)

        # Explicit English description
        pr, pc = self.player
        player_elev = self._stand(self.player)
        elev_name = {0: "low ground", 2: "high ground", 4: "top of a box"}.get(player_elev, "unknown")
        goal_elev_name = "high ground" if goal_on_high else "low ground"

        player_sym = 'P' if player_elev == 2 else ('Q' if player_elev == 4 else '@')
        notes = [f"Player ({player_sym}) at row {pr}, col {pc} on {elev_name}."]
        if goal_on_high:
            notes.append(f"Goal (*) at row {gr}, col {gc} on HIGH ground — you cannot walk there directly, you must use a ramp to climb up.")
        else:
            notes.append(f"Goal (G) at row {gr}, col {gc} on low ground — walk there to win.")

        _OPP_STEP  = {"N": (1, 0),  "S": (-1, 0), "E": (0, -1), "W": (0, 1)}
        _LAND_STEP = {"N": (-1, 0), "S": (1, 0),  "E": (0, 1),  "W": (0, -1)}
        for (r, c), d in sorted(self.ramps.items()):
            sr, sc = r + _OPP_STEP[d][0],  c + _OPP_STEP[d][1]
            lr, lc = r + _LAND_STEP[d][0], c + _LAND_STEP[d][1]
            land_in   = self._in((lr, lc))
            land_high = land_in and self.terrain[lr][lc] == "high"
            sym = _SYM[DIR_RAMP[d]]
            if land_high:
                notes.append(
                    f"Ramp ({sym}) at [{r},{c}] climbs {d}: "
                    f"stand at [{sr},{sc}] and move {d} — you land on high ground at [{lr},{lc}].")
            else:
                notes.append(
                    f"Ramp ({sym}) at [{r},{c}] faces {d} but its landing cell [{lr},{lc}] is "
                    f"low ground — this ramp is NOT usable for climbing in its current position. "
                    f"Push it to a new position by approaching it from the side (N or S if the ramp "
                    f"faces E/W, or E/W if the ramp faces N/S) so that it faces high ground.")

        for (r, c) in sorted(self.boxes):
            t = "high" if self.terrain[r][c] == "high" else "low"
            notes.append(f"Box at [{r},{c}] on {t} ground (push it or stand on top of it).")

        dr = gr - pr
        dc = gc - pc
        dir_hint = ("" if dr == 0 else (f"{abs(dr)} row{'s' if abs(dr)>1 else ''} {'south' if dr>0 else 'north'}"))
        dir_hint += (" and " if dr != 0 and dc != 0 else "")
        dir_hint += ("" if dc == 0 else (f"{abs(dc)} col{'s' if abs(dc)>1 else ''} {'east' if dc>0 else 'west'}"))
        notes.append(f"Goal is {dir_hint} from you.")

        obs = {"description": " ".join(notes),
               "ascii": ascii_rows,
               "player": list(self.player),
               "goal": list(self.goal),
               "steps_remaining": self.max_steps - self.steps,
               "player_elevation": self._stand(self.player),
               "grid": grid}
        if self.optimal_steps is not None:
            obs["optimal_steps"] = self.optimal_steps
        return obs
