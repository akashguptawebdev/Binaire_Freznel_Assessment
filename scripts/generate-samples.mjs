import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Writes a spread of sample CSVs (varying rank) into ./samples so the queue
 * can be demoed without generating files in the browser.
 *
 *   node scripts/generate-samples.mjs
 */
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples');
mkdirSync(OUT, { recursive: true });

const specs = [
  { name: 'tiny-5x3.csv', rows: 5, cols: 3, float: 0 },
  { name: 'small-200x6.csv', rows: 200, cols: 6, float: 0.3 },
  { name: 'wide-50x40.csv', rows: 50, cols: 40, float: 0.5 },
  { name: 'tall-8000x4.csv', rows: 8000, cols: 4, float: 0.4 },
  { name: 'big-20000x10.csv', rows: 20000, cols: 10, float: 0.45 },
];

const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

for (const spec of specs) {
  let sum = 0;
  const lines = new Array(spec.rows);
  for (let r = 0; r < spec.rows; r += 1) {
    const cells = new Array(spec.cols);
    for (let c = 0; c < spec.cols; c += 1) {
      const v = Math.random() < spec.float ? Number((Math.random() * 200 - 100).toFixed(3)) : randInt(-500, 500);
      sum += v;
      cells[c] = v;
    }
    lines[r] = cells.join(',');
  }
  writeFileSync(path.join(OUT, spec.name), lines.join('\n') + '\n');
  console.log(`${spec.name.padEnd(22)} rank ${spec.rows}x${spec.cols}  expected all-reduce Σ ≈ ${sum.toPrecision(10)}`);
}

console.log(`\nwrote ${specs.length} files to ${OUT}`);
