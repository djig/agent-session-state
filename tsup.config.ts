import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react/index.ts',
    'adapters/ag-ui': 'src/adapters/ag-ui.ts',
    'adapters/ai-sdk': 'src/adapters/ai-sdk.ts',
    'adapters/langgraph': 'src/adapters/langgraph.ts',
    'storage/local-storage': 'src/storage/local-storage.ts',
    'storage/indexeddb': 'src/storage/indexeddb.ts',
    'storage/http': 'src/storage/http.ts',
    server: 'src/server/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  minify: true,
  external: ['react'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
