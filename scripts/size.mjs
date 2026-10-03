// Reports the gzipped size of each entry point, following relative chunk imports
// so shared chunks are counted. Fails when the core entry exceeds the budget.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(new URL('..', import.meta.url).pathname);
const BUDGET_CORE_GZ = Number(process.env.SIZE_BUDGET_CORE ?? 8 * 1024);

function collect(file, seen = new Set()) {
  const abs = resolve(root, file);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  const src = readFileSync(abs, 'utf8');
  const re = /(?:import|export)[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) collect(resolve(dirname(abs), m[1]), seen);
  return seen;
}

export function sizeOf(entry) {
  const files = [...collect(entry)];
  const raw = Buffer.concat(files.map((f) => readFileSync(f)));
  return { raw: raw.length, gz: gzipSync(raw, { level: 9 }).length, files: files.length };
}

const entries = [
  'dist/index.js',
  'dist/react.js',
  'dist/adapters/ag-ui.js',
  'dist/adapters/ai-sdk.js',
  'dist/adapters/langgraph.js',
  'dist/storage/local-storage.js',
  'dist/storage/indexeddb.js',
  'dist/storage/http.js',
  'dist/server.js',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  for (const e of entries) {
    const s = sizeOf(e);
    const flag = e === 'dist/index.js' && s.gz > BUDGET_CORE_GZ ? '  OVER BUDGET' : '';
    if (flag) failed = true;
    console.log(`${e.padEnd(34)} ${String(s.raw).padStart(7)} B  ${String(s.gz).padStart(6)} B gz  (${s.files} file${s.files > 1 ? 's' : ''})${flag}`);
  }
  console.log(`\ncore budget: ${BUDGET_CORE_GZ} B gz`);
  if (failed) process.exit(1);
}
