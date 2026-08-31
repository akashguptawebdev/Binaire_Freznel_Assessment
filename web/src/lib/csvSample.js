/**
 * Client-side random CSV generator so the app is demoable without shipping
 * fixture files. "Rank" (rows x cols) is randomised within the given bounds,
 * matching the brief's "CSV files ... can vary in row and column sizes".
 */
export function makeRandomCsv({ minRows = 40, maxRows = 6000, minCols = 3, maxCols = 12, floatRatio = 0.4 } = {}) {
  const rows = randInt(minRows, maxRows);
  const cols = randInt(minCols, maxCols);
  const lines = new Array(rows);
  let expectedSum = 0;

  for (let r = 0; r < rows; r += 1) {
    const cells = new Array(cols);
    for (let c = 0; c < cols; c += 1) {
      let value;
      if (Math.random() < floatRatio) {
        value = Number((Math.random() * 200 - 100).toFixed(3));
      } else {
        value = randInt(-500, 500);
      }
      expectedSum += value;
      cells[c] = value;
    }
    lines[r] = cells.join(',');
  }

  const text = lines.join('\n') + '\n';
  const name = `random-${rows}x${cols}-${Date.now().toString(36)}.csv`;
  const file = new File([text], name, { type: 'text/csv' });
  return { file, rows, cols, expectedSum: Number(expectedSum.toPrecision(12)) };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
