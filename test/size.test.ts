import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = resolve(__dirname, '../dist/index.js');

// Runs against the built output; `npm run build` first (CI does).
describe.skipIf(!existsSync(dist))('bundle size', () => {
  it('core entry (dist/index.js + its chunks) is under 8 KB gzipped', async () => {
    const { sizeOf } = await import('../scripts/size.mjs');
    const { gz } = sizeOf('dist/index.js');
    expect(gz).toBeLessThan(8 * 1024);
  });

  it('react entry stays tiny', async () => {
    const { sizeOf } = await import('../scripts/size.mjs');
    expect(sizeOf('dist/react.js').gz).toBeLessThan(2 * 1024);
  });
});
