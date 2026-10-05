import { defineConfig } from 'tsup';

// Bundle the TypeScript-source workspace package into the server build;
// everything else in node_modules stays external.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: ['@sync-retail/shared'],
});
