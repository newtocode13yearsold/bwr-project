#!/usr/bin/env node
// Bundle size monitor — reports sizes of all frontend JS/CSS assets.
// Fails (exit 1) if any file exceeds its per-type threshold.

'use strict';

const { statSync, readdirSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');

const THRESHOLDS = {
  js:  150 * 1024,  // 150 KB per JS file
  css: 100 * 1024,  // 100 KB per CSS file
};

function scanDir(dir, ext) {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.' + ext))
      .map(f => ({ file: dir.replace(ROOT, '').replace(/\\/g, '/') + '/' + f, size: statSync(join(dir, f)).size }));
  } catch {
    return [];
  }
}

const PUBLIC = join(ROOT, 'public');

const files = [
  ...scanDir(join(PUBLIC, 'js'), 'js'),
  ...scanDir(join(PUBLIC, 'css'), 'css'),
  { file: '/worker.js', size: statSync(join(ROOT, 'worker.js')).size },
  { file: '/public/sw.js', size: statSync(join(PUBLIC, 'sw.js')).size },
];

const kb = n => (n / 1024).toFixed(1).padStart(7) + ' KB';

let failed = false;
let totalSize = 0;

console.log('\nBundle size report\n' + '─'.repeat(48));

for (const { file, size } of files.sort((a, b) => b.size - a.size)) {
  const ext = file.split('.').pop();
  const limit = THRESHOLDS[ext];
  const over = limit && size > limit;
  console.log(`${kb(size)}  ${file}${over ? '  ⚠  OVER LIMIT' : ''}`);
  if (over) failed = true;
  totalSize += size;
}

console.log('─'.repeat(48));
console.log(`${kb(totalSize)}  TOTAL (${files.length} files)\n`);

if (failed) {
  console.error('One or more files exceed size thresholds. Consider splitting or lazy-loading.');
  process.exit(1);
}
