/**
 * One-time cleanup: deletes duplicate visit: keys from production KV.
 * Keeps any bucket with ≤5 entries (legitimate traffic).
 * Run: node scripts/cleanup-visits.mjs
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseTOML } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));

// Read wrangler config
const ACCOUNT = 'd91c4dcc15204cd85b1b26853203ff31';
const NS      = 'da878110f87d4dc6975a6bf3e44cd7ed';

// Read oauth token from wrangler config
const configPath = process.env.APPDATA
  ? join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml')
  : join(process.env.HOME, '.wrangler', 'config', 'default.toml');

const toml = readFileSync(configPath, 'utf-8');
const TOKEN = toml.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!TOKEN) { console.error('No oauth_token found in', configPath); process.exit(1); }

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`;
const H    = { Authorization: `Bearer ${TOKEN}` };

async function listAllKeys(prefix) {
  const keys = [];
  let cursor = '';
  do {
    const url = `${BASE}/keys?limit=1000&prefix=${encodeURIComponent(prefix)}` + (cursor ? `&cursor=${cursor}` : '');
    const data = await fetch(url, { headers: H }).then(r => r.json());
    keys.push(...(data.result || []).map(k => k.name));
    cursor = data.result_info?.cursor ?? '';
  } while (cursor);
  return keys;
}

async function getValues(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 20) {
    const batch = keys.slice(i, i + 20);
    const vals  = await Promise.all(batch.map(k =>
      fetch(`${BASE}/values/${encodeURIComponent(k)}`, { headers: H })
        .then(r => r.text()).then(t => ({ key: k, val: t }))
    ));
    out.push(...vals);
    if ((i / 20) % 5 === 0) process.stdout.write(`\rRead ${Math.min(i + 20, keys.length)}/${keys.length}…`);
  }
  console.log();
  return out;
}

async function bulkDelete(keys) {
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const r = await fetch(`${BASE}/bulk/delete`, {
      method:  'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body:    JSON.stringify(batch),
    }).then(r => r.json());
    console.log(`Batch ${Math.floor(i / 100) + 1}:`, r.success ? `deleted ${batch.length}` : JSON.stringify(r.errors));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const allKeys = await listAllKeys('visit:');
console.log(`Found ${allKeys.length} visit: keys`);

const entries  = await getValues(allKeys);
const buckets  = {};
for (const { key, val } of entries) {
  try {
    const v      = JSON.parse(val);
    const bucket = `${(v.timestamp || '').slice(0, 16)}|${v.page || '/'}`;
    (buckets[bucket] = buckets[bucket] || []).push(key);
  } catch {}
}

const toDelete = [];
let   kept     = 0;
for (const [bucket, keys] of Object.entries(buckets)) {
  if (keys.length > 5) {
    console.log(`  DUPLICATE (${keys.length}×): ${bucket}`);
    toDelete.push(...keys);
  } else {
    kept += keys.length;
  }
}

console.log(`\nTo delete: ${toDelete.length}  |  To keep: ${kept}`);
if (toDelete.length === 0) { console.log('Nothing to delete.'); process.exit(0); }

await bulkDelete(toDelete);
console.log('Done ✅');
