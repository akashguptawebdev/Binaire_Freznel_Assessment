import { ValidationError } from './errors.js';

/**
 * CSV handling for the all-reduce.
 *
 * The brief says files are "filled with numeric values (integers and floats)"
 * and can "vary in row and column sizes (called rank)". So parsing is
 * deliberately permissive:
 *   - comma, tab, semicolon or whitespace separate values
 *   - blank lines are ignored
 *   - non-numeric tokens are ignored (but a file with *zero* numbers is
 *     rejected as invalid)
 *
 * We never build the full number matrix in memory. We keep the raw lines and
 * hand row-ranges ("chunks") to workers, which parse their own slice. That
 * keeps peak memory ~= file size, not 8 bytes * cells.
 */

const SEPARATOR = /[\s,;]+/;

export function splitLines(text) {
  // Normalise newlines, drop a trailing newline, keep everything else.
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function countNumericTokens(line) {
  let count = 0;
  for (const tok of line.split(SEPARATOR)) {
    if (tok === '') continue;
    if (Number.isFinite(Number(tok))) count += 1;
  }
  return count;
}

/**
 * Reduce a set of lines to { sum, count }. This is the exact routine the
 * worker runs; exported here so the inline strategy and the unit tests can
 * share it.
 */
export function reduceLines(lines) {
  let sum = 0;
  let count = 0;
  for (const line of lines) {
    for (const tok of line.split(SEPARATOR)) {
      if (tok === '') continue;
      const n = Number(tok);
      if (Number.isFinite(n)) {
        sum += n;
        count += 1;
      }
    }
  }
  return { sum, count };
}

/**
 * Parse the upload into a processing plan.
 * @returns {{ lines: string[], rank: {rows:number, cols:number},
 *             chunks: Array<{index:number,startRow:number,endRow:number}> }}
 */
export function planCsv(buffer, { chunkRows }) {
  const text = buffer.toString('utf8');
  const lines = splitLines(text);
  if (lines.length === 0) {
    throw new ValidationError('CSV file is empty.');
  }

  const cols = Math.max(...lines.slice(0, 25).map((l) => l.split(SEPARATOR).filter(Boolean).length));
  const rank = { rows: lines.length, cols: cols || 0 };

  // Validate there is at least one number anywhere in the first rows, and
  // that the file is not obviously junk (e.g. prose).
  const sampledNumeric = lines
    .slice(0, 50)
    .reduce((acc, l) => acc + countNumericTokens(l), 0);
  if (sampledNumeric === 0) {
    throw new ValidationError('CSV contains no numeric values to reduce.');
  }

  const chunks = [];
  for (let start = 0, index = 0; start < lines.length; start += chunkRows, index += 1) {
    chunks.push({
      index,
      startRow: start,
      endRow: Math.min(start + chunkRows, lines.length),
    });
  }

  return { lines, rank, chunks };
}
