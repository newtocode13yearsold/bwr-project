#!/usr/bin/env node
// ============================================================================
// backup-kv.mjs — Full backup of the BWR Cloudflare KV database to a file.
//
// WHY: Your users, paths, reports, reviews, etc. live ONLY in Cloudflare KV,
//      not in the code. If that data is ever wiped, the code alone cannot
//      bring it back. This script downloads every key/value into a single
//      timestamped JSON file under ./backups/ so you always have a copy.
//
// HOW TO RUN (from the project folder, in a terminal):
//      node scripts/backup-kv.mjs
//
//   You must be logged into Cloudflare first. If it errors about auth, run:
//      npx wrangler login
//
// RESTORE: to put a backup back into KV, run:
//      node scripts/backup-kv.mjs --restore backups/<the-file>.json
//   (Restore only ADDS/overwrites keys from the file; it never deletes.)
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

// KV namespace id — matches "BWR_KV" in wrangler.jsonc.
const NAMESPACE_ID = "da878110f87d4dc6975a6bf3e44cd7ed";
const CONCURRENCY = 12; // how many keys to fetch at once (keeps it fast but polite)

// Call wrangler's JS entry point with the current Node — avoids the Windows
// ".cmd spawn EINVAL" problem you get when shelling out to npx.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRANGLER_JS = path.join(__dirname, "..", "node_modules", "wrangler", "bin", "wrangler.js");

async function wrangler(args) {
  const { stdout } = await execFileP(process.execPath, [WRANGLER_JS, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function listAllKeys() {
  const out = await wrangler([
    "kv", "key", "list",
    "--namespace-id", NAMESPACE_ID,
    "--remote",
  ]);
  return JSON.parse(out).map((k) => k.name);
}

async function getValue(key) {
  const out = await wrangler([
    "kv", "key", "get", key,
    "--namespace-id", NAMESPACE_ID,
    "--remote",
  ]);
  return out;
}

// Write the value through a temp file (--path) instead of passing it as a CLI
// argument: photo: data-URIs are ~1 MB and Windows caps a command line at
// ~32 KB, so argv-passing silently loses exactly the biggest keys. A file also
// can't be misparsed as a flag when a value starts with "-".
async function putValue(key, value, idx) {
  const tmp = path.join(tmpdir(), `bwr-kv-restore-${process.pid}-${idx}.tmp`);
  await writeFile(tmp, value, "utf8");
  try {
    await wrangler([
      "kv", "key", "put", key,
      "--path", tmp,
      "--namespace-id", NAMESPACE_ID,
      "--remote",
    ]);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Keys that only make sense with their KV expiration timer. `kv key put` can't
// restore a TTL (the backup can't read the remaining time anyway), so restoring
// these would make rate-limit blocks and login lockouts PERMANENT and caches
// eternally stale. They all rebuild themselves — skip them.
const SKIP_RESTORE_PREFIXES = [
  "ratelimit:",      // request rate-limit windows
  "loginattempts:",  // login lockout counters
  "osm:",            // 7-day OpenStreetMap cache
  "aisugg:",         // legacy AI-suggestion cache (48 h)
  "leaderboard:cache", // 5-min leaderboard cache
  "reviewsummary",   // 5-min rating aggregate cache
];

// Run an async fn over items with a fixed concurrency limit.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function doBackup() {
  console.log("Listing all keys…");
  const keys = await listAllKeys();
  console.log(`Found ${keys.length} keys. Downloading values…`);

  const data = {};
  const failed = [];
  let done = 0;
  await mapLimit(keys, CONCURRENCY, async (key) => {
    try {
      data[key] = await getValue(key);
    } catch (e) {
      console.warn(`  ! failed to read ${key}: ${e.message}`);
      failed.push(key);
      data[key] = null;
    }
    done++;
    if (done % 50 === 0 || done === keys.length) {
      process.stdout.write(`\r  ${done}/${keys.length}`);
    }
  });
  process.stdout.write("\n");

  const backupsDir = path.join(process.cwd(), "backups");
  if (!existsSync(backupsDir)) await mkdir(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(backupsDir, `kv-backup-${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify({
      namespaceId: NAMESPACE_ID,
      takenAt: new Date().toISOString(),
      keyCount: keys.length - failed.length,
      failedKeys: failed,
      data,
    }, null, 2),
    "utf8",
  );
  // Be honest about partial backups: a backup that says "complete" while
  // missing keys is worse than no backup. Non-zero exit so cron/CI notices.
  if (failed.length > 0) {
    console.error(`\n⚠️  BACKUP INCOMPLETE: ${failed.length}/${keys.length} keys failed to download.`);
    console.error(`Saved what we got to: ${file} (failed keys listed inside under "failedKeys").`);
    console.error(`Re-run the backup — Cloudflare may have rate-limited us.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nBackup saved: ${file}`);
  console.log(`(${keys.length} keys) — keep this file somewhere safe.`);
}

async function doRestore(file) {
  console.log(`Restoring from ${file} …`);
  const raw = JSON.parse(await readFile(file, "utf8"));
  const nullKeys = Object.entries(raw.data).filter(([, v]) => v === null).map(([k]) => k);
  const skipped = [];
  const entries = Object.entries(raw.data).filter(([key, v]) => {
    if (v === null) return false;
    if (SKIP_RESTORE_PREFIXES.some((p) => key.startsWith(p))) { skipped.push(key); return false; }
    return true;
  });
  if (nullKeys.length > 0) {
    console.warn(`⚠️  This backup is INCOMPLETE: ${nullKeys.length} keys were never downloaded (null):`);
    nullKeys.slice(0, 20).forEach((k) => console.warn(`   - ${k}`));
    if (nullKeys.length > 20) console.warn(`   … and ${nullKeys.length - 20} more.`);
  }
  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} ephemeral cache/lock keys (they rebuild themselves and would lose their expiry).`);
  }
  console.log(`${entries.length} keys to write. This ADDS/overwrites; it never deletes.`);
  const failed = [];
  let done = 0;
  await mapLimit(entries, CONCURRENCY, async ([key, value], idx) => {
    try {
      await putValue(key, value, idx);
    } catch (e) {
      console.warn(`  ! failed to write ${key}: ${e.message}`);
      failed.push(key);
    }
    done++;
    if (done % 50 === 0 || done === entries.length) {
      process.stdout.write(`\r  ${done}/${entries.length}`);
    }
  });
  process.stdout.write("\n");
  if (failed.length > 0) {
    console.error(`⚠️  RESTORE INCOMPLETE: ${failed.length}/${entries.length} keys failed to write:`);
    failed.slice(0, 20).forEach((k) => console.error(`   - ${k}`));
    if (failed.length > 20) console.error(`   … and ${failed.length - 20} more.`);
    console.error("Re-run the restore to retry (writes are idempotent overwrites).");
    process.exitCode = 1;
    return;
  }
  console.log("Restore complete.");
}

const restoreIdx = process.argv.indexOf("--restore");
if (restoreIdx !== -1) {
  const file = process.argv[restoreIdx + 1];
  if (!file) {
    console.error("Usage: node scripts/backup-kv.mjs --restore backups/<file>.json");
    process.exit(1);
  }
  doRestore(file).catch((e) => { console.error(e); process.exit(1); });
} else {
  doBackup().catch((e) => { console.error(e); process.exit(1); });
}
