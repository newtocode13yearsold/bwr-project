// Replace the production "Actualités" feed with scripts/news/news-2026-10.json.
//
//   node scripts/news/refresh-news.mjs            → dry run (shows what would change)
//   node scripts/news/refresh-news.mjs --apply    → backup, delete old news, publish new
//
// Needs `npx wrangler login` first. Every current news:* value is saved to
// scripts/news/news-backup-<date>.json before anything is deleted.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NS = 'da878110f87d4dc6975a6bf3e44cd7ed'; // BWR_KV (wrangler.jsonc)
const here = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');

const wrangler = (...args) =>
  execFileSync('npx', ['wrangler', 'kv', ...args, '--namespace-id', NS, '--remote'], {
    encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024,
  });
const listKeys = (prefix) => JSON.parse(wrangler('key', 'list', '--prefix', prefix)).map(k => k.name);

const oldNews = listKeys('news:');
const oldReacts = listKeys('newsreact:');
console.log(`Actualités actuelles : ${oldNews.length} (+ ${oldReacts.length} votes)`);

// Newest first in the JSON file → staggered createdAt so the feed keeps that order.
const fresh = JSON.parse(readFileSync(join(here, 'news-2026-10.json'), 'utf8'));
const base = Date.parse('2026-09-30T18:00:00.000Z');
const items = fresh.map((n, i) => {
  const at = new Date(base - i * 90 * 60 * 1000).toISOString();
  return {
    id: randomUUID(), title: n.title, content: n.content || '', category: n.category,
    url: n.url || '', urlLabel: n.urlLabel || '', imageDataUri: '', imageUrl: '',
    createdAt: at, updatedAt: at,
  };
});
for (const it of items) console.log(`  + [${it.category}] ${it.title}`);

if (!apply) { console.log('\nDry run — relancer avec --apply pour publier.'); process.exit(0); }

// 1. Backup
const backup = oldNews.map(k => ({ key: k, value: wrangler('key', 'get', k, '--text') }));
const backupFile = join(here, `news-backup-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(backupFile, JSON.stringify(backup, null, 2));
console.log(`Sauvegarde : ${backupFile}`);

// 2. Publish new, 3. delete old (publish first so the feed is never empty)
const tmp = (name, data) => { const f = join(tmpdir(), name); writeFileSync(f, JSON.stringify(data)); return f; };
const putFile = tmp('bwr-news-put.json', items.map(it => ({ key: `news:${it.id}`, value: JSON.stringify(it) })));
wrangler('bulk', 'put', putFile);
unlinkSync(putFile);

const toDelete = [...oldNews, ...oldReacts];
if (toDelete.length) {
  const delFile = tmp('bwr-news-del.json', toDelete);
  wrangler('bulk', 'delete', delFile, '--force');
  unlinkSync(delFile);
}
console.log(`Terminé : ${items.length} publiées, ${oldNews.length} anciennes supprimées.`);
