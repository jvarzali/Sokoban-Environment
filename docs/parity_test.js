// parity_test.js - confirm the browser engine matches the Python engine.
// No hard-coded solution lengths: it runs the canonical Python BFS
// (verify_maps.py) for the source-of-truth shortest length per map, then checks
// a dev-only JS BFS (defined below, over the shared engine) produces the same
// length. The shipped app contains no solver. Requires Python on PATH.
// Run: node frontend/parity_test.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Sokoban } = require("./game.js");

const root = path.join(__dirname, "..");
const mapsDir = path.join(root, "maps");

// Canonical truth: Python's per-map shortest solution length, parsed from
// verify_maps.py output ("ok <name> solved in <N> steps ...").
function pythonSteps() {
  let out;
  try {
    out = execFileSync("python", ["verify_maps.py"], { cwd: root, encoding: "utf8" });
  } catch (e) {
    out = (e.stdout || "").toString();   // verify_maps exits non-zero if a map fails
  }
  const steps = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*ok\s+(\S+)\s+solved in (\d+) steps/);
    if (m) steps[m[1]] = Number(m[2]);
  }
  return steps;
}

// Dev-only BFS over the shared engine (the app itself ships no solver).
function jsSolveLen(map) {
  const stateKey = (g) => {
    const boxes = [...g.boxes].sort().join("|");
    const ramps = [...g.ramps.entries()].map(([k, v]) => `${k}:${v}`).sort().join("|");
    return `${g.player[0]},${g.player[1]};${boxes};${ramps}`;
  };
  const s = new Sokoban(map);
  if (s.player[0] === s.goal[0] && s.player[1] === s.goal[1]) return 0;
  const seen = new Set([stateKey(s)]);
  let frontier = [{ snap: s.snapshot(), dist: 0 }];
  const probe = new Sokoban(map);
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      for (const dir of ["N", "S", "E", "W"]) {
        probe.restore(node.snap);
        if (!probe.move(dir)) continue;
        if (probe.player[0] === probe.goal[0] && probe.player[1] === probe.goal[1]) return node.dist + 1;
        const k = stateKey(probe);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ snap: probe.snapshot(), dist: node.dist + 1 });
      }
    }
    frontier = next;
  }
  return null;
}

const py = pythonSteps();
const files = fs.readdirSync(mapsDir).filter((f) => f.endsWith(".json")).sort();
let fails = 0;
for (const f of files) {
  const map = JSON.parse(fs.readFileSync(path.join(mapsDir, f), "utf8"));
  const js = jsSolveLen(map);
  const want = py[map.name];
  const ok = want !== undefined && js === want;
  if (!ok) fails++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(map.name).padEnd(12)} js=${js} py=${want}`);
}
console.log(`\n${files.length - fails}/${files.length} maps match the Python engine`);
process.exit(fails ? 1 : 0);
