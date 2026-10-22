'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  haversineM, nodeKey, buildGraph, dijkstra,
  rebuildPath, nearestNode, graphToResult,
  graphAtob, graphAtobHybrid, graphLoop, trimSpurs,
  isClosedFor, excludeClosedPaths,
} = require('../public/js/graph-router.js');

describe('trimSpurs', () => {
  test('removes a single out-and-back whisker', () => {
    // A→B→C then straight back to B is a whisker off the C→D→A loop closure.
    assert.deepEqual(trimSpurs(['A', 'B', 'C', 'B', 'D', 'A']), ['A', 'B', 'D', 'A']);
  });
  test('peels a multi-node stub layer by layer', () => {
    assert.deepEqual(trimSpurs(['A', 'B', 'C', 'D', 'C', 'B', 'E', 'A']), ['A', 'B', 'E', 'A']);
  });
  test('leaves a clean loop untouched', () => {
    const loop = ['A', 'B', 'C', 'D', 'A'];
    assert.deepEqual(trimSpurs(loop), loop);
  });
  test('removes a geometric sliver when neighbours are within SPUR_EPS_M', () => {
    // Loop A→…→A with a whisker: from A the route steps out to tip T then
    // returns to A' (~8 m from A, a different node) before running the real
    // loop B→C→A. Exact-key test misses the sliver (T's flanks are A and A',
    // distinct keys); the coord lookup collapses it. The genuine loop nodes
    // B and C have well-separated neighbours and survive.
    const coords = {
      A:  [49.35000, 2.90000],
      T:  [49.35030, 2.90000],           // ~33 m out — the tip
      Ap: [49.35007, 2.90000],           // ~8 m from A — the near-return
      B:  [49.35007, 2.90200],           // ~145 m east
      C:  [49.34900, 2.90100],
    };
    const coordOf = (k) => coords[k];
    assert.deepEqual(
      trimSpurs(['A', 'T', 'Ap', 'B', 'C', 'A'], coordOf),
      ['A', 'Ap', 'B', 'C', 'A'],
    );
    // Without the coord lookup the sliver is invisible (exact-key only).
    assert.deepEqual(
      trimSpurs(['A', 'T', 'Ap', 'B', 'C', 'A']),
      ['A', 'T', 'Ap', 'B', 'C', 'A'],
    );
  });
});

// ─── Test network: a simple rectangle in the Compiegne forest ─────────────────
//
//   A [49.35000, 2.90000]  ──P1──  B [49.35100, 2.90000]
//   |                                        |
//   P4                                      P2
//   |                                        |
//   D [49.35000, 2.90100]  ──P3──  C [49.35100, 2.90100]
//
// Each segment ≈ 85–111 m. Total perimeter ≈ 390 m.
// Nodes A–D share exact coordinates across paths → auto-connected via shared keys.

const A = [49.35000, 2.90000];
const B = [49.35100, 2.90000];
const C = [49.35100, 2.90100];
const D = [49.35000, 2.90100];

const SQUARE_PATHS = [
  { coordinates: [A, B] },
  { coordinates: [B, C] },
  { coordinates: [C, D] },
  { coordinates: [D, A] },
];

// ─── haversineM ───────────────────────────────────────────────────────────────

describe('haversineM', () => {
  test('same point → 0 m', () => {
    assert.equal(haversineM(49.35, 2.9, 49.35, 2.9), 0);
  });

  test('symmetry: d(A,B) === d(B,A)', () => {
    const d1 = haversineM(49.35, 2.9, 49.36, 2.9);
    const d2 = haversineM(49.36, 2.9, 49.35, 2.9);
    assert.ok(Math.abs(d1 - d2) < 0.001);
  });

  test('0.001° latitude ≈ 111 m at any longitude', () => {
    const d = haversineM(49.35, 2.9, 49.351, 2.9);
    assert.ok(d > 100 && d < 120, `expected ~111 m, got ${d.toFixed(1)} m`);
  });

  test('positive distance for different points', () => {
    assert.ok(haversineM(49.35, 2.9, 49.36, 2.91) > 0);
  });
});

// ─── nodeKey ──────────────────────────────────────────────────────────────────

describe('nodeKey', () => {
  test('formats to 5 decimal places', () => {
    assert.equal(nodeKey(49.35, 2.9), '49.35000,2.90000');
  });

  test('rounds correctly', () => {
    assert.equal(nodeKey(49.123456789, 2.987654321), '49.12346,2.98765');
  });

  test('same coordinates → same key', () => {
    assert.equal(nodeKey(49.35, 2.9), nodeKey(49.35, 2.9));
  });
});

// ─── buildGraph ───────────────────────────────────────────────────────────────

describe('buildGraph', () => {
  test('single 3-point path → 3 nodes, 2 bidirectional edges', () => {
    const { nodes, adj } = buildGraph([{ coordinates: [A, B, C] }]);
    assert.equal(nodes.size, 3);
    const kA = nodeKey(...A), kB = nodeKey(...B), kC = nodeKey(...C);
    assert.ok(adj.get(kA).some(e => e.to === kB), 'A→B missing');
    assert.ok(adj.get(kB).some(e => e.to === kA), 'B→A missing');
    assert.ok(adj.get(kB).some(e => e.to === kC), 'B→C missing');
    assert.ok(adj.get(kC).some(e => e.to === kB), 'C→B missing');
  });

  test('square network → 4 nodes', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    assert.equal(nodes.size, 4);
  });

  test('square network → each node has exactly 2 neighbours', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    for (const [, edges] of adj) {
      assert.equal(edges.length, 2);
    }
  });

  test('duplicate paths do not add duplicate edges', () => {
    const paths = [SQUARE_PATHS[0], SQUARE_PATHS[0]];
    const { adj } = buildGraph(paths);
    const kA = nodeKey(...A), kB = nodeKey(...B);
    const edgesAtoB = adj.get(kA).filter(e => e.to === kB);
    assert.equal(edgesAtoB.length, 1, 'duplicate edge created');
  });

  test('endpoints within 80 m but not sharing a node → connected', () => {
    // Path1 ends at [49.35000, 2.90000], Path2 starts at [49.350005, 2.90000] (~5 cm apart)
    const nearA = [49.350005, 2.90000];
    const paths = [
      { coordinates: [B, A] },
      { coordinates: [nearA, C] },
    ];
    const { adj } = buildGraph(paths);
    const kA = nodeKey(...A), kNearA = nodeKey(...nearA);
    // They map to the same nodeKey (≤5 decimal places), so connected via shared key
    // OR they differ but are within 80 m → connected via proximity link
    const connected = adj.has(kA) && (
      kA === kNearA || adj.get(kA).some(e => e.to === kNearA)
    );
    assert.ok(connected, 'close endpoints should be connected');
  });

  test('endpoints farther than 80 m are NOT connected', () => {
    // A and C are ~134 m apart (diagonal of the rectangle)
    const p1 = { coordinates: [A, B] };
    const p2 = { coordinates: [C, D] };
    const { adj } = buildGraph([p1, p2]);
    const kA = nodeKey(...A), kC = nodeKey(...C);
    assert.ok(!adj.get(kA).some(e => e.to === kC), 'far endpoints should not be connected');
  });

  test('edge distances are positive', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    for (const [, edges] of adj) {
      for (const e of edges) assert.ok(e.d > 0);
    }
  });
});

// ─── dijkstra ─────────────────────────────────────────────────────────────────

describe('dijkstra', () => {
  test('distance to start node is 0', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const start = nodeKey(...A);
    const { dist } = dijkstra(adj, start);
    assert.equal(dist.get(start), 0);
  });

  test('all 4 nodes reachable from A', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const { dist } = dijkstra(adj, nodeKey(...A));
    assert.equal(dist.size, 4);
  });

  test('early exit when end node is reached', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const start = nodeKey(...A), end = nodeKey(...B);
    const { dist } = dijkstra(adj, start, end);
    assert.ok(dist.has(end));
    assert.ok(dist.get(end) > 0);
  });

  test('disconnected graph: isolated node has no distance', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const isolated = 'isolated_node';
    adj.set(isolated, []);
    const { dist } = dijkstra(adj, nodeKey(...A));
    assert.equal(dist.get(isolated), undefined);
  });

  test('shorter path wins over longer path', () => {
    // A-B direct, and A-D-C-B indirect: direct A→B should be shorter
    const { adj } = buildGraph(SQUARE_PATHS);
    const { dist } = dijkstra(adj, nodeKey(...A));
    const dAB = dist.get(nodeKey(...B));
    const dAD = dist.get(nodeKey(...D));
    // AB ≈ 111 m (north), AD ≈ 72 m (east) — AD should be shorter
    assert.ok(dAD < dAB, `expected AD (${dAD?.toFixed(0)}) < AB (${dAB?.toFixed(0)})`);
  });
});

// ─── rebuildPath ──────────────────────────────────────────────────────────────

describe('rebuildPath', () => {
  test('returns path from start to end', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const start = nodeKey(...A), end = nodeKey(...C);
    const { prev } = dijkstra(adj, start, end);
    const path = rebuildPath(prev, start, end);
    assert.ok(path !== null);
    assert.equal(path[0], start);
    assert.equal(path[path.length - 1], end);
  });

  test('path length ≥ 2', () => {
    const { adj } = buildGraph(SQUARE_PATHS);
    const start = nodeKey(...A), end = nodeKey(...C);
    const { prev } = dijkstra(adj, start, end);
    const path = rebuildPath(prev, start, end);
    assert.ok(path.length >= 2);
  });

  test('returns null when end is unreachable', () => {
    const prev = new Map(); // empty → no predecessors
    const path = rebuildPath(prev, 'X', 'Y');
    assert.equal(path, null);
  });

  test('single-node path: start === end', () => {
    const prev = new Map();
    const path = rebuildPath(prev, 'A', 'A');
    assert.deepEqual(path, ['A']);
  });
});

// ─── nearestNode ──────────────────────────────────────────────────────────────

describe('nearestNode', () => {
  test('returns the single node when only one exists', () => {
    const nodes = new Map([['k', { lat: 49.35, lon: 2.9, k: 'k' }]]);
    const n = nearestNode(nodes, 0, 0);
    assert.equal(n.k, 'k');
  });

  test('returns the closest of several nodes', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    // Query very close to B
    const n = nearestNode(nodes, 49.35099, 2.89999);
    assert.equal(n.k, nodeKey(...B));
  });

  test('returns null for an empty graph', () => {
    const n = nearestNode(new Map(), 49.35, 2.9);
    assert.equal(n, null);
  });
});

// ─── graphToResult ────────────────────────────────────────────────────────────

describe('graphToResult', () => {
  test('coords array matches key count', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    const keys = [nodeKey(...A), nodeKey(...B), nodeKey(...C)];
    const r = graphToResult(nodes, keys, 'foot');
    assert.equal(r.coords.length, 3);
  });

  test('meters > 0 for multi-node path', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    const keys = [nodeKey(...A), nodeKey(...B)];
    const r = graphToResult(nodes, keys, 'foot');
    assert.ok(r.meters > 0);
  });

  test('seconds = meters / 1.11 for foot', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    const keys = [nodeKey(...A), nodeKey(...B)];
    const r = graphToResult(nodes, keys, 'foot');
    assert.ok(Math.abs(r.seconds - r.meters / 1.11) < 0.01);
  });

  test('seconds = meters / 4.17 for bike', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    const keys = [nodeKey(...A), nodeKey(...B)];
    const r = graphToResult(nodes, keys, 'bike');
    assert.ok(Math.abs(r.seconds - r.meters / 4.17) < 0.01);
  });

  test('single-node path → 0 meters', () => {
    const { nodes } = buildGraph(SQUARE_PATHS);
    const r = graphToResult(nodes, [nodeKey(...A)], 'foot');
    assert.equal(r.meters, 0);
  });
});

// ─── graphAtob ────────────────────────────────────────────────────────────────

describe('graphAtob', () => {
  test('returns a valid result with coords and meters', () => {
    const r = graphAtob(...A, ...C, SQUARE_PATHS);
    assert.ok(Array.isArray(r.coords) && r.coords.length >= 2);
    assert.ok(r.meters > 0);
    assert.ok(r.seconds > 0);
  });

  test('first coord is near start, last coord is near end', () => {
    const r = graphAtob(...A, ...C, SQUARE_PATHS);
    const [startLat, startLon] = r.coords[0];
    const [endLat, endLon]     = r.coords[r.coords.length - 1];
    assert.ok(haversineM(startLat, startLon, ...A) < 200, 'start coord not near A');
    assert.ok(haversineM(endLat, endLon, ...C) < 200, 'end coord not near C');
  });

  test('throws when paths array is empty', () => {
    assert.throws(
      () => graphAtob(...A, ...C, []),
      /Aucun chemin/,
    );
  });

  test('throws when no path connects start to end', () => {
    // Two isolated single-edge paths with no shared nodes
    const isolated = [
      { coordinates: [[0, 0], [0, 0.001]] },
      { coordinates: [[10, 10], [10, 10.001]] },
    ];
    assert.throws(
      () => graphAtob(0, 0, 10, 10, isolated),
      /Aucun chemin/,
    );
  });
});

// ─── graphLoop ────────────────────────────────────────────────────────────────

describe('graphLoop', () => {
  test('returns a valid result', () => {
    const r = graphLoop(...A, 0.4, SQUARE_PATHS);
    assert.ok(Array.isArray(r.coords) && r.coords.length >= 2);
    assert.ok(r.meters > 0);
    assert.ok(r.seconds > 0);
  });

  test('loop closes: first and last coords are the same node', () => {
    const r = graphLoop(...A, 0.4, SQUARE_PATHS);
    const first = r.coords[0];
    const last  = r.coords[r.coords.length - 1];
    assert.deepEqual(first, last, 'loop does not close back to start');
  });

  test('throws when paths array is empty', () => {
    assert.throws(
      () => graphLoop(...A, 1, []),
      /Aucun chemin/,
    );
  });

  test('throws when fewer than 4 nodes in the graph', () => {
    // Only 3 nodes
    const tiny = [{ coordinates: [A, B, C] }];
    assert.throws(
      () => graphLoop(...A, 1, tiny),
      /Pas assez de chemins/,
    );
  });

  test('throws when graph has no return path (linear dead-end network)', () => {
    // Straight vertical line, each segment ≈ 220 m so no endpoint is within 80 m
    // of any non-adjacent endpoint → no proximity snapping, no cycle possible.
    const line = [
      { coordinates: [[49.350, 2.9], [49.352, 2.9]] },
      { coordinates: [[49.352, 2.9], [49.354, 2.9]] },
      { coordinates: [[49.354, 2.9], [49.356, 2.9]] },
      { coordinates: [[49.356, 2.9], [49.358, 2.9]] },
    ];
    assert.throws(
      () => graphLoop(49.350, 2.9, 0.4, line),
      /boucle|aller/i,
    );
  });

  test('distance is within 3× of requested (network is small so exact match impossible)', () => {
    const targetKm = 0.4;
    const r = graphLoop(...A, targetKm, SQUARE_PATHS);
    assert.ok(r.meters < targetKm * 3000, `result too long: ${r.meters.toFixed(0)} m`);
    assert.ok(r.meters > 0);
  });

  test('bike pathTyp gives faster seconds than foot for same route', () => {
    const rFoot = graphLoop(...A, 0.4, SQUARE_PATHS, 'foot');
    const rBike = graphLoop(...A, 0.4, SQUARE_PATHS, 'bike');
    assert.ok(rBike.seconds < rFoot.seconds, 'bike should be faster than foot');
  });
});

// ─── graphLoop daily seed (direction variety) ─────────────────────────────────
// A 5×5 grid offers many turnaround directions, so the per-day seed can steer
// the loop differently from one day to the next.
const GRID_PATHS = (() => {
  const paths = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const lat = 49.350 + i * 0.001;
      const lon = 2.900 + j * 0.001;
      if (j < 4) paths.push({ coordinates: [[lat, lon], [lat, lon + 0.001]] });
      if (i < 4) paths.push({ coordinates: [[lat, lon], [lat + 0.001, lon]] });
    }
  }
  return paths;
})();
const GRID_CENTER = [49.352, 2.902];

describe('graphLoop daily seed', () => {
  test('seed=0 is deterministic (default unchanged)', () => {
    const a = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS);
    const b = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS, 'foot', 0);
    assert.deepEqual(a.coords, b.coords, 'unseeded loop should be stable');
  });

  test('same seed → same loop (stable within a day)', () => {
    const a = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS, 'foot', 42);
    const b = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS, 'foot', 42);
    assert.deepEqual(a.coords, b.coords);
  });

  test('different seeds can produce different loops', () => {
    const shapes = new Set();
    for (let seed = 1; seed <= 8; seed++) {
      const r = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS, 'foot', seed);
      shapes.add(JSON.stringify(r.coords));
    }
    assert.ok(shapes.size > 1, 'expected at least two distinct loop shapes across seeds');
  });

  test('seeded loops still close back to start and stay valid', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = graphLoop(...GRID_CENTER, 0.6, GRID_PATHS, 'foot', seed);
      assert.deepEqual(r.coords[0], r.coords[r.coords.length - 1], `loop ${seed} does not close`);
      assert.ok(r.meters > 0 && r.seconds > 0);
    }
  });
});

// ─── Closed paths (impraticable / vélo interdit) ──────────────────────────────
// Layout: START (49.400, 2.900) → END (49.400, 2.910) is a straight ~724 m line.
// The open alternative is a ~1.8 km detour north and back. Whenever the direct line
// is closed, the route must take the detour.

describe('closed paths', () => {
  const START = [49.400, 2.900];
  const END   = [49.400, 2.910];
  const direct = (extra = {}) => ({ coordinates: [START, END], ...extra });
  const detour = { status: 'easy', coordinates: [START, [49.405, 2.900], [49.405, 2.910], END] };
  // True if the route has a point in the middle stretch of the direct line.
  const usesDirect = (r) => r.coords.some(([la, lo]) => Math.abs(la - 49.400) < 0.0002 && lo > 2.9015 && lo < 2.9085)
    || r.coords.some((c, i) => i > 0 && c[0] === 49.400 && r.coords[i - 1][0] === 49.400
      && Math.abs(c[1] - r.coords[i - 1][1]) > 0.005);
  // Run the A→B hybrid router after applying closures, like routes-engine does.
  const route = (admin, osm, mode = 'foot') => {
    const x = excludeClosedPaths(admin, osm, mode);
    return graphAtobHybrid(...START, ...END, x.admin, x.osm, mode);
  };

  test('isClosedFor: impraticable closes for everyone, vélo interdit only for bikes', () => {
    assert.equal(isClosedFor({ status: 'not_passable' }, 'foot'), true);
    assert.equal(isClosedFor({ status: 'not_passable' }, 'bike'), true);
    assert.equal(isClosedFor({ status: 'no_bike' }, 'foot'), false);
    assert.equal(isClosedFor({ status: 'no_bike' }, 'bike'), true);
    assert.equal(isClosedFor({ _noBike: true }, 'foot'), false);
    assert.equal(isClosedFor({ _noBike: true }, 'bike'), true);
    assert.equal(isClosedFor({ status: 'hard' }, 'bike'), false);
  });

  test('excludeClosedPaths: closed admin paths move to the osm list, flagged', () => {
    const closed = direct({ status: 'not_passable' });
    const x = excludeClosedPaths([closed, detour], [{ coordinates: [START, END] }], 'foot');
    assert.deepEqual(x.admin, [detour]);
    assert.equal(x.osm.length, 2);
    assert.equal(x.osm[0]._blocked, true);
    assert.equal(x.osm[0]._shadow, true);
    assert.equal(x.osm[1]._shadowable, true);
  });

  test('an impraticable admin path is never routed over', () => {
    const open = route([direct({ status: 'easy' }), detour], []);
    assert.ok(usesDirect(open), 'control: the open direct line should be used');
    const r = route([direct({ status: 'not_passable' }), detour], []);
    assert.ok(!usesDirect(r), 'route went over the impassable path');
    assert.ok(r.meters > 1500);
  });

  test('the OSM copy lying under an impraticable admin path is cut too', () => {
    // OSM trace of the same trail, ~4 m off and with its own vertices.
    const osmCopy = { coordinates: [START, [49.40004, 2.902], [49.40004, 2.904], [49.40004, 2.906], [49.40004, 2.908], END] };
    const control = route([direct({ status: 'easy' }), detour], [osmCopy]);
    assert.ok(control.meters < 1000, 'control: the open line should be used');
    const r = route([direct({ status: 'not_passable' }), detour], [osmCopy]);
    assert.ok(r.meters > 1500, `route used the OSM copy of the closed trail (${Math.round(r.meters)} m)`);
  });

  test('gap-bridging links never hop a short closed section (broken bridge)', () => {
    // Two OSM ways end 43 m apart either side of a closed bridge — close enough for
    // the 80 m endpoint join. The bridge itself is closed (admin + OSM copy).
    const W = [49.400, 2.8997], E = [49.400, 2.9003];
    const a = [49.400, 2.890], b = [49.400, 2.910];
    const osm = [
      { coordinates: [a, W] }, { coordinates: [E, b] }, { coordinates: [W, E] },
      { coordinates: [a, [49.405, 2.890], [49.405, 2.910], b] },
    ];
    const control = excludeClosedPaths([], osm, 'foot');
    assert.ok(graphAtobHybrid(...a, ...b, control.admin, control.osm, 'foot').meters < 1600);
    const x = excludeClosedPaths([{ status: 'not_passable', coordinates: [W, E] }], osm, 'foot');
    const r = graphAtobHybrid(...a, ...b, x.admin, x.osm, 'foot');
    assert.ok(r.meters > 2500, `crossed the closed bridge (${Math.round(r.meters)} m)`);
  });

  test('crossing a closed trail is still allowed', () => {
    // N–S trail crossing a closed E–W trail, with vertices 5 m either side of it.
    const closed = { status: 'not_passable', coordinates: [[49.400, 2.895], [49.400, 2.905]] };
    const ns = { coordinates: [[49.395, 2.900], [49.39995, 2.900], [49.400, 2.900], [49.40005, 2.900], [49.405, 2.900]] };
    const x = excludeClosedPaths([closed], [ns], 'foot');
    const r = graphAtobHybrid(49.395, 2.900, 49.405, 2.900, x.admin, x.osm, 'foot');
    assert.ok(r.meters < 1200, `crossing was blocked (${Math.round(r.meters)} m)`);
  });

  test('no route at all rather than one over a closed path', () => {
    const stubs = [
      { coordinates: [START, [49.401, 2.900]] },
      { coordinates: [END, [49.401, 2.910]] },
    ];
    const x = excludeClosedPaths([direct({ status: 'not_passable' })], stubs, 'foot');
    assert.throws(() => graphAtob(...START, ...END, [...x.admin, ...x.osm], 'foot'), /Aucun chemin/);
  });

  test('vélo interdit (admin) is used on foot but skipped by bike', () => {
    const admin = [direct({ status: 'no_bike' }), detour];
    assert.ok(usesDirect(route(admin, [], 'foot')), 'walkers may use a no-bike path');
    assert.ok(!usesDirect(route(admin, [], 'bike')), 'bike route used a vélo-interdit path');
  });

  test('OSM bicycle=no is used on foot but skipped by bike', () => {
    const osm = [{ coordinates: [START, END], _noBike: true }, { coordinates: detour.coordinates }];
    assert.ok(usesDirect(route([], osm, 'foot')));
    assert.ok(!usesDirect(route([], osm, 'bike')), 'bike route used a bicycle=no way');
  });

  test('loops avoid closed paths too', () => {
    // Two stacked blocks whose bottom side is closed: the loop must not use it.
    const paths = [
      { status: 'not_passable', coordinates: [START, END] },
      { status: 'easy', coordinates: [END, [49.405, 2.910]] },
      { status: 'easy', coordinates: [[49.405, 2.910], [49.405, 2.900]] },
      { status: 'easy', coordinates: [[49.405, 2.900], START] },
      { status: 'easy', coordinates: [[49.405, 2.900], [49.410, 2.900], [49.410, 2.910], [49.405, 2.910]] },
    ];
    const x = excludeClosedPaths(paths, [], 'foot');
    const r = graphLoop(49.405, 2.900, 2.5, [...x.admin, ...x.osm], 'foot');
    assert.ok(!usesDirect(r), 'loop used the closed side');
  });

  test('buildGraph adds no node for a closed path', () => {
    const { nodes } = buildGraph([{ coordinates: [START, END], _blocked: true }, { coordinates: [[49.41, 2.9], [49.411, 2.9]] }]);
    assert.ok(!nodes.has(nodeKey(...START)) && !nodes.has(nodeKey(...END)));
  });
});
