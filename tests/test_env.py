"""Unit tests for the Mountain Sokoban engine (build-order step 1).

Covers: flat move, descend off ledge, blocked cliff, ramp climb (aligned),
ramp push (perpendicular), ramp descend (along axis), box flat-slide,
box fall-off-ledge, blocked box-uphill, ragged-edge = wall, plus win/reward
and invalid-action accounting.

Maps are injected directly via reset(map=...). A few tests place the player on
high ground by hand, since the map format always decodes code 9 onto low terrain.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from env import SokobanEnv  # noqa: E402


def make(grid, goal=(0, 0), max_steps=100):
    env = SokobanEnv()
    env.reset(map={"grid": grid, "goal": list(goal), "max_steps": max_steps})
    return env


class TestMovement(unittest.TestCase):
    def test_flat_move(self):
        env = make([[9, 0, 0]], goal=(0, 2))
        res = env.step("E")
        self.assertEqual(env.player, (0, 1))
        self.assertEqual(res.info["invalid"], "0.0")

    def test_descend_off_ledge(self):
        # [0,0] high, [0,1] low, player code lives at [1,0] then hops to high.
        env = make([[1, 0], [9, 3]], goal=(1, 0))
        env.player = (0, 0)  # stand on the high cell
        env.step("E")
        self.assertEqual(env.player, (0, 1))  # free drop high -> low

    def test_cliff_is_blocked(self):
        env = make([[9, 1]], goal=(0, 1))  # low -> high, no ramp
        res = env.step("E")
        self.assertEqual(env.player, (0, 0))
        self.assertEqual(res.info["invalid"], "1.0")

    def test_wall_is_blocked(self):
        env = make([[9, 3, 0]], goal=(0, 2))
        res = env.step("E")
        self.assertEqual(env.player, (0, 0))
        self.assertEqual(res.info["invalid"], "1.0")

    def test_ragged_edge_is_wall(self):
        # row 1 is shorter; [1,2] is off the end of its row -> wall.
        env = make([[9, 0, 0], [0, 0]], goal=(0, 0))
        env.player = (0, 2)
        res = env.step("S")
        self.assertEqual(env.player, (0, 2))
        self.assertEqual(res.info["invalid"], "1.0")


class TestRamps(unittest.TestCase):
    def test_climb_aligned(self):
        grid = [[3, 1, 3],
                [3, 4, 3],
                [3, 9, 3]]
        env = make(grid, goal=(0, 1))
        res = env.step("N")  # uphill into the ramp -> land on the high cell
        self.assertEqual(env.player, (0, 1))
        self.assertEqual(res.observation["player_elevation"], 2)
        self.assertEqual(res.observation["grid"][0][1], 10)  # player on high -> code 10
        self.assertEqual(res.reward, 1.0)

    def test_push_perpendicular(self):
        grid = [[3, 3, 3, 3],
                [9, 4, 0, 3]]
        env = make(grid, goal=(0, 0))
        env.step("E")  # enter ramp from the side -> shove it east
        self.assertEqual(env.player, (1, 1))
        self.assertEqual(env.ramps, {(1, 2): "N"})

    def test_push_blocked_when_target_not_low(self):
        # Pushing the ramp would land it on high ground -> illegal, nothing moves.
        grid = [[3, 3, 3],
                [9, 4, 1]]
        env = make(grid, goal=(0, 0))
        res = env.step("E")
        self.assertEqual(env.player, (1, 0))
        self.assertEqual(env.ramps, {(1, 1): "N"})
        self.assertEqual(res.info["invalid"], "1.0")

    def test_descend_along_ramp(self):
        grid = [[1, 3],
                [4, 3],
                [0, 3],
                [9, 3]]
        env = make(grid, goal=(2, 0))
        env.player = (0, 0)  # on the high cell above the ramp
        env.step("S")        # downhill across the ramp to the low cell beyond
        self.assertEqual(env.player, (2, 0))


class TestBoxes(unittest.TestCase):
    def test_flat_slide(self):
        env = make([[9, 8, 0, 3]], goal=(0, 0))
        env.step("E")
        self.assertEqual(env.player, (0, 1))
        self.assertEqual(env.boxes, {(0, 2)})

    def test_fall_off_ledge(self):
        # box on high ground pushed onto low ground -> it drops.
        env = make([[1, 2, 0], [9, 3, 3]], goal=(0, 0))
        env.player = (0, 0)  # player up on the plateau, west of the box
        env.step("E")
        self.assertEqual(env.player, (0, 1))
        self.assertEqual(env.boxes, {(0, 2)})

    def test_uphill_push_blocked(self):
        env = make([[9, 8, 1]], goal=(0, 0))  # box can't be shoved up a cliff
        res = env.step("E")
        self.assertEqual(env.player, (0, 0))
        self.assertEqual(env.boxes, {(0, 1)})
        self.assertEqual(res.info["invalid"], "1.0")

    def test_push_into_box_blocked(self):
        env = make([[9, 8, 8, 0]], goal=(0, 0))  # no chained pushes
        res = env.step("E")
        self.assertEqual(env.player, (0, 0))
        self.assertEqual(env.boxes, {(0, 1), (0, 2)})
        self.assertEqual(res.info["invalid"], "1.0")


class TestEpisode(unittest.TestCase):
    def test_win_reward_and_terminate(self):
        env = make([[9, 0]], goal=(0, 1))
        res = env.step("E")
        self.assertEqual(res.reward, 1.0)
        self.assertTrue(res.terminated)
        self.assertFalse(res.truncated)
        self.assertEqual(res.info["success"], "1.0")

    def test_invalid_action_is_noop(self):
        env = make([[9, 0]], goal=(0, 1))
        res = env.step("jump")
        self.assertEqual(env.player, (0, 0))
        self.assertEqual(res.info["invalid"], "1.0")
        self.assertEqual(res.reward, 0.0)

    def test_alias_and_truncation(self):
        env = make([[9, 3]], goal=(0, 1), max_steps=2)
        env.step("right")             # alias for E, blocked by wall -> no win
        res = env.step("left")        # alias for W, off-grid -> blocked
        self.assertTrue(res.truncated)
        self.assertFalse(res.terminated)

    def test_obs_recomposes_grid(self):
        env = make([[9, 8, 0]], goal=(0, 2))
        obs = env.step("E").observation  # player to (0,1), box to (0,2)
        self.assertEqual(obs["grid"], [[0, 9, 8]])  # player on low -> 9
        self.assertEqual(obs["player"], [0, 1])

    def test_player_on_high_is_code_10(self):
        env = make([[1, 0], [9, 3]], goal=(1, 0))
        env.player = (0, 0)  # manually place on high ground
        obs = env._obs()
        self.assertEqual(obs["grid"][0][0], 10)
        self.assertEqual(obs["player_elevation"], 2)

    def test_player_never_on_ramp_in_obs(self):
        # After a ramp push, the ramp slides away and the player occupies the
        # vacated low cell — never the ramp cell itself.
        grid = [[3, 3, 3, 3],
                [9, 4, 0, 3]]
        env = make(grid, goal=(0, 0))
        env.step("E")  # push ramp east; player -> (1,1), ramp -> (1,2)
        obs = env._obs()
        self.assertEqual(obs["grid"][1][1], 9)    # player code (low), not a ramp code
        self.assertEqual(obs["grid"][1][2], 4)    # ramp is at (1,2)


if __name__ == "__main__":
    unittest.main()
