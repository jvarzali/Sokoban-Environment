"""BFS solvability checker for Sokoban maps.

For each map it does a breadth-first search over the full game state
`(player, frozenset(boxes), frozenset(ramps.items()))`, reusing the live engine
(`SokobanEnv._try_move`) so the search obeys exactly the same rules the env
enforces. Reports the shortest solution length, or flags a map as UNSOLVABLE
(its goal is unreachable from the start = an authored deadlock).

Usage:
    python verify_maps.py            # check every maps/*.json
    python verify_maps.py maps/x.json [...]   # check specific files
"""
from __future__ import annotations

import glob
import json
import os
import sys
from collections import deque

from env import SokobanEnv, DELTA


def _state(env):
    return (env.player, frozenset(env.boxes), frozenset(env.ramps.items()))


def _restore(env, state):
    player, boxes, ramps = state
    env.player = player
    env.boxes = set(boxes)
    env.ramps = dict(ramps)


def solve(map_dict, max_states=500_000):
    """Return (solved, num_steps, num_states_explored).

    `num_steps` is the shortest action sequence reaching the goal, or None.
    """
    env = SokobanEnv()
    env.reset(map=map_dict)
    goal = env.goal

    start = _state(env)
    if start[0] == goal:
        return True, 0, 1

    seen = {start}
    frontier = deque([(start, 0)])
    explored = 0
    while frontier:
        state, dist = frontier.popleft()
        explored += 1
        if explored > max_states:
            return False, None, explored  # gave up; treat as unsolved
        for d in DELTA:
            _restore(env, state)
            if not env._try_move(d):
                continue
            nxt = _state(env)
            if nxt in seen:
                continue
            if nxt[0] == goal:
                return True, dist + 1, explored
            seen.add(nxt)
            frontier.append((nxt, dist + 1))
    return False, None, explored


def main(argv):
    paths = argv or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "maps", "*.json")))
    if not paths:
        print("no maps found")
        return 1
    failures = 0
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            m = json.load(fh)
        solved, steps, explored = solve(m)
        name = m.get("name", os.path.basename(path))
        cap = m.get("max_steps", 100)
        if not solved:
            failures += 1
            print(f"  UNSOLVABLE  {name:<16} ({explored} states explored)")
        elif steps > cap:
            failures += 1
            print(f"  OVER-CAP    {name:<16} needs {steps} > max_steps {cap}")
        else:
            print(f"  ok          {name:<16} solved in {steps} steps "
                  f"(cap {cap}, {explored} states)")
    print(f"\n{len(paths) - failures}/{len(paths)} maps OK")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
