import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Runs the Node queue server and the Vite dev server together.
 *   npm run dev:all
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  { name: 'server', cmd: process.execPath, args: ['--watch', 'server/src/index.js'], color: '\x1b[36m' },
  { name: 'web', cmd: 'npm', args: ['--prefix', 'web', 'run', 'dev'], color: '\x1b[35m' },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `${p.color}[${p.name}]\x1b[0m `;
  child.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, tag)));
  child.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/^/gm, tag)));
  child.on('exit', (code) => {
    console.log(`${tag}exited with ${code}`);
    shutdown();
  });
  return child;
});

function shutdown() {
  children.forEach((c) => !c.killed && c.kill('SIGTERM'));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('dev: queue server on :4000, web on :5173 (proxying /api -> :4000)');
