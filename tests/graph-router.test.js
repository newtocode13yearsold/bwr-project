'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  haversineM, nodeKey, buildGraph, dijkstra,
  rebuildPath, nearestNode, graphToResult,
  graphAtob, graphLoop,
} = require('../public/js/graph-router.js');

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
