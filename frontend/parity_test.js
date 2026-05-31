// parity_test.js - confirm the browser engine matches the Python engine.
// BFS-solves every map with the JS Sokoban port and checks the shortest
// solution length equals what verify_maps.py reports. Run: node frontend/parity_test.js
const fs = require("fs");
const path = require("path");
const { Sokoban } = require("./game.js");

const mapsDir = path.join(__dirname, "..", "maps");
const files = fs.readdirSync(mapsDir).filter((f) => f.endsWith(".json")).sort();

// Shortest-solution lengths from `python verify_maps.py` (single source of truth).
const EXPECTED = {
  walk: 3, climb: 1, ascent: 4, pushramp: 7, boxdoor: 2, ledgepush: 3,
  descend: 5, corner: 5, summit: 6, zigzag: 16, overpass: 8, pushramp2: 7,
  doorbox: 3, overwall: 7, gauntlet: 7, island: 3,
};

function stateKey(g) {
  const boxes = [...g.boxes].sort().join("|");
  const ramps = [...g.ramps.entries()].map(([k, v]) => k + ":" + v).sort().join("|");
  return `${g.player[0]},${g.player[1]};${boxes};${ramps}`;
}

function bfs(map) {
  const start = new Sokoban(map);
  if (start.player[0] === start.goal[0] && start.player[1] === start.goal[1]) return 0;
  const seen = new Set([stateKey(start)]);
  let frontier = [start.snapshot()];
  let dist = 0;
  const probe = new Sokoban(map);
  while (frontier.length) {
    dist += 1;
    const next = [];
    for (const snap of frontier) {
      for (const dir of ["N", "S", "E", "W"]) {
        probe.restore(snap);
        if (!probe.move(dir)) continue;
        if (probe.player[0] === probe.goal[0] && probe.player[1] === probe.goal[1]) return dist;
        const k = stateKey(probe);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(probe.snapshot());
      }
    }
    frontier = next;
  }
  return null;
}

let fails = 0;
for (const f of files) {
  const map = JSON.parse(fs.readFileSync(path.join(mapsDir, f), "utf8"));
  const got = bfs(map);
  const want = EXPECTED[map.name];
  const ok = got === want;
  if (!ok) fails += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${map.name.padEnd(12)} js=${got} py=${want}`);
}
console.log(`\n${files.length - fails}/${files.length} maps match the Python engine`);
process.exit(fails ? 1 : 0);
