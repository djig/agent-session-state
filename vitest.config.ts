import { defineConfig } from 'vitest/config';

// Browser-ish tests opt into happy-dom with a `// @vitest-environment happy-dom`
// pragma at the top of the file; everything else runs in plain Node.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
