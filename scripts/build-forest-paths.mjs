#!/usr/bin/env node
// Pre-bake the whole Compiègne-forest OpenStreetMap path network into a static asset
// (public/data/forest-paths.json) so the route planner can build its routing graph
// entirely client-side, with no live Overpass call on the hot path.
//
// Why: a cold /api/osm request is throttled from Cloudflare's egress IPs (~24 s / 502)
// and never warms the worker KV cache, so every new area stayed a slow cold miss. The
// forest barely changes, so we fetch its paths ONCE here (run manually) and ship them.
//
//   npm run build:forest-paths
//
// Admin-curated paths (/api/paths) stay live and are merged with this static base layer
// at route time — only the OpenStreetMap base layer is frozen into this file. Re-run this
// script if the OSM forest paths change enough to matter.
//
// The output shape matches osmDataToCoordPaths() in public/js/routes-engine.js exactly:
//   [ { coordinates: [[lat,lon], …], _highway?: string, _surface?: string }, … ]
// and the query/highway filter mirrors the worker's /api/osm handler
// (worker/handlers/content.js).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with FOREST_BOUNDS in public/js/config.js.
const BOUNDS = { minLat: 49.28, minLng: 2.74, maxLat: 49.50, maxLng: 3.05 };

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'forest-paths.json');

// Same path-type filter the worker uses. `>;` pulls in every node the ways reference.
const QUERY = `[out:json][timeout:180];(way["highway"~"^(path|track|footway|bridleway|cycleway)$"](${BOUNDS.minLat},${BOUNDS.minLng},${BOUNDS.maxLat},${BOUNDS.maxLng});>;);out body;`;

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOverpass() {
  let lastErr;
  for (const url of MIRRORS) {
    try {
      process.stdout.write(`Fetching from ${url} … `);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'BWR-Oise/1.0 (https://bwrmaps.com; thomaslegros71@gmail.com)',
        },
        body: `data=${encodeURIComponent(QUERY)}`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.elements)) throw new Error('malformed response');
      console.log(`ok (${data.elements.length} elements)`);
      return data;
    } catch (e) {
      console.log(`failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw new Error(`all Overpass mirrors failed: ${lastErr?.message}`);
}

// Mirror of osmDataToCoordPaths() in public/js/routes-engine.js, plus 5-decimal
// rounding (the graph snaps nodes at 0.00001° precision anyway — see nodeKey).
function toCoordPaths(data) {
  const nodeMap = {};
  for (const el of data.elements) {
    if (el.type === 'node') nodeMap[el.id] = [+el.lat.toFixed(5), +el.lon.toFixed(5)];
  }
  const out = [];
  for (const el of data.elements) {
    if (el.type !== 'way') continue;
    const coordinates = el.nodes.map((id) => nodeMap[id]).filter(Boolean);
    if (coordinates.length < 2) continue;
    const p = { coordinates };
    if (el.tags?.highway) p._highway = el.tags.highway;
    if (el.tags?.surface) p._surface = el.tags.surface;
    out.push(p);
  }
  return out;
}

const raw = await fetchOverpass();
const paths = toCoordPaths(raw);
if (!paths.length) {
  console.error('Refusing to write: no paths parsed from Overpass response.');
  process.exit(1);
}

let coords = 0;
for (const p of paths) coords += p.coordinates.length;

await mkdir(dirname(OUT), { recursive: true });
const json = JSON.stringify(paths);
await writeFile(OUT, json);

console.log(`Wrote ${OUT}`);
console.log(`  ${paths.length} ways, ${coords} coordinates, ${(json.length / 1048576).toFixed(2)} MB`);
